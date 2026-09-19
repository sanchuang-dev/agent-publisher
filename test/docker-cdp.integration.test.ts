import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { expect, test } from "vitest";

import { DockerCdpBrowserProvider } from "../src/browser/providers/docker-cdp.js";

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => Boolean(value));

  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      "Docker CDP integration requires an installed Chrome/Chromium executable",
    );
  }

  return executable;
}

async function waitForDevToolsEndpoint(
  process: ChildProcessWithoutNullStreams,
  timeoutMs = 20_000,
): Promise<string> {
  return await new Promise<string>((resolve, reject) => {
    let stderr = "";

    const cleanup = () => {
      clearTimeout(timer);
      process.stderr.off("data", handleData);
      process.off("exit", handleExit);
    };

    const handleData = (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
      const match = stderr.match(
        /DevTools listening on (ws:\/\/[^\s]+)/,
      );

      if (match?.[1]) {
        cleanup();
        resolve(match[1]);
      }
    };

    const handleExit = (code: number | null, signal: NodeJS.Signals | null) => {
      cleanup();
      reject(
        new Error(
          `Chromium exited before exposing CDP (code=${code}, signal=${signal})\n${stderr}`,
        ),
      );
    };

    const timer = setTimeout(() => {
      cleanup();
      reject(
        new Error(
          `Timed out waiting for Chromium CDP endpoint\n${stderr}`,
        ),
      );
    }, timeoutMs);

    process.stderr.on("data", handleData);
    process.once("exit", handleExit);
  });
}

function signalProcessTree(
  child: ChildProcessWithoutNullStreams,
  signal: NodeJS.Signals,
): void {
  if (process.platform !== "win32" && child.pid !== undefined) {
    try {
      process.kill(-child.pid, signal);
      return;
    } catch (error) {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "ESRCH"
      ) {
        return;
      }
      throw error;
    }
  }

  child.kill(signal);
}

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const alreadyExited =
    child.exitCode !== null || child.signalCode !== null;

  if (!alreadyExited) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
      }, 2_000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      signalProcessTree(child, "SIGTERM");
    });
  }

  // Chromium can leave renderer/utility descendants alive briefly after the
  // browser process exits. On POSIX CI runners it is spawned in its own process
  // group, so make the final cleanup authoritative before removing the profile.
  if (process.platform !== "win32") {
    signalProcessTree(child, "SIGKILL");
  }
}

async function stopChromiumForRuntimeRestart(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (child.exitCode === null && child.signalCode === null) {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(() => {
        signalProcessTree(child, "SIGKILL");
      }, 5_000);

      child.once("exit", () => {
        clearTimeout(timer);
        resolve();
      });

      // browser-runtime cleanup sends SIGTERM to Chromium itself. Let the
      // browser process flush persistent profile state before the final
      // process-group cleanup removes any lingering renderer/utility children.
      child.kill("SIGTERM");
    });
  }

  if (process.platform !== "win32") {
    signalProcessTree(child, "SIGKILL");
  }
}

test(
  "real Chromium survives provider release and accepts a fresh CDP session",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-cdp-"));
    const profilePath = join(root, "profile");
    const chromiumProcess = spawn(
      findChrome(),
      [
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-dev-shm-usage",
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=0",
        `--user-data-dir=${profilePath}`,
        "about:blank",
      ],
      {
        stdio: ["pipe", "pipe", "pipe"],
        detached: process.platform !== "win32",
      },
    );

    try {
      const websocketEndpoint =
        await waitForDevToolsEndpoint(chromiumProcess);
      const websocketUrl = new URL(websocketEndpoint);
      const endpoint = `http://127.0.0.1:${websocketUrl.port}`;
      const provider = new DockerCdpBrowserProvider({
        endpoint,
        connectTimeoutMs: 5_000,
      });

      const first = await provider.acquire({});
      await expect(provider.acquire({})).rejects.toThrow(
        /Browser session already active/,
      );
      await first.page.goto(
        "data:text/html,<title>provider-integration</title>",
      );
      await expect(first.page.title()).resolves.toBe(
        "provider-integration",
      );

      await provider.release(first.id);

      expect(chromiumProcess.exitCode).toBeNull();
      expect(chromiumProcess.signalCode).toBeNull();

      const second = await provider.acquire({});
      expect(second.page.isClosed()).toBe(false);
      await provider.release(second.id);

      expect(chromiumProcess.exitCode).toBeNull();
      expect(chromiumProcess.signalCode).toBeNull();
    } finally {
      await stopProcess(chromiumProcess);
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },
  45_000,
);

async function startProfileStateServer(): Promise<{
  readonly server: Server;
  readonly origin: string;
}> {
  const server = createServer((_request, response) => {
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end("<!doctype html><title>profile-state-smoke</title>");
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Profile state test server did not expose a TCP address");
  }

  return {
    server,
    origin: `http://127.0.0.1:${address.port}`,
  };
}

async function stopServer(server: Server): Promise<void> {
  if (!server.listening) {
    return;
  }

  await new Promise<void>((resolve, reject) => {
    server.close((error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}


function cookieStorePaths(profilePath: string): string[] {
  return [
    join(profilePath, "Default", "Cookies"),
    join(profilePath, "Default", "Cookies-wal"),
    join(profilePath, "Default", "Network", "Cookies"),
    join(profilePath, "Default", "Network", "Cookies-wal"),
  ];
}

function fileSignature(path: string): string | undefined {
  if (!existsSync(path)) {
    return undefined;
  }

  const stat = statSync(path);
  return `${stat.size}:${stat.mtimeMs}`;
}

async function waitForCookieStoreWrite(
  profilePath: string,
  before: ReadonlyMap<string, string | undefined>,
  timeoutMs = 35_000,
): Promise<void> {
  const paths = cookieStorePaths(profilePath);
  // Chromium batches persistent-cookie SQLite mutations and normally commits
  // them on a 30-second timer. Poll for the actual backing-store write instead
  // of assuming that an in-memory cookie is already durable.
  const deadline = Date.now() + timeoutMs;

  while (Date.now() < deadline) {
    if (
      paths.some((path) => {
        const current = fileSignature(path);
        return current !== undefined && current !== before.get(path);
      })
    ) {
      return;
    }

    await new Promise((resolve) => setTimeout(resolve, 50));
  }

  throw new Error(
    "Timed out waiting for Chromium to persist the non-sensitive test cookie",
  );
}

test(
  "real Chromium preserves a non-sensitive persistent cookie across process restart with the same profile",
  async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-profile-"));
    const profilePath = join(root, "profile");
    const { server, origin } = await startProfileStateServer();
    const spawnChromium = (): ChildProcessWithoutNullStreams =>
      spawn(
        findChrome(),
        [
          "--headless=new",
          "--no-first-run",
          "--no-default-browser-check",
          "--disable-dev-shm-usage",
          "--remote-debugging-address=127.0.0.1",
          "--remote-debugging-port=0",
          `--user-data-dir=${profilePath}`,
          "about:blank",
        ],
        {
          stdio: ["pipe", "pipe", "pipe"],
          detached: process.platform !== "win32",
        },
      );

    let chromiumProcess = spawnChromium();

    try {
      const firstWebsocketEndpoint =
        await waitForDevToolsEndpoint(chromiumProcess);
      const firstWebsocketUrl = new URL(firstWebsocketEndpoint);
      const firstProvider = new DockerCdpBrowserProvider({
        endpoint: `http://127.0.0.1:${firstWebsocketUrl.port}`,
        connectTimeoutMs: 5_000,
      });

      const first = await firstProvider.acquire({});
      await first.page.goto(origin);
      const cookieStoreBefore = new Map(
        cookieStorePaths(profilePath).map((path) => [path, fileSignature(path)]),
      );
      await first.page.context().addCookies([
        {
          name: "m1_04_profile_smoke",
          value: "persisted",
          url: origin,
          expires: Math.floor(Date.now() / 1000) + 60 * 60,
        },
      ]);
      await expect(
        first.page.context().cookies(origin),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "m1_04_profile_smoke",
            value: "persisted",
          }),
        ]),
      );
      await waitForCookieStoreWrite(profilePath, cookieStoreBefore);
      await firstProvider.release(first.id);

      await stopChromiumForRuntimeRestart(chromiumProcess);
      chromiumProcess = spawnChromium();

      const secondWebsocketEndpoint =
        await waitForDevToolsEndpoint(chromiumProcess);
      const secondWebsocketUrl = new URL(secondWebsocketEndpoint);
      const secondProvider = new DockerCdpBrowserProvider({
        endpoint: `http://127.0.0.1:${secondWebsocketUrl.port}`,
        connectTimeoutMs: 5_000,
      });

      const second = await secondProvider.acquire({});
      await second.page.goto(origin);
      await expect(
        second.page.context().cookies(origin),
      ).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            name: "m1_04_profile_smoke",
            value: "persisted",
          }),
        ]),
      );

      await secondProvider.release(second.id);
    } finally {
      await stopProcess(chromiumProcess);
      await stopServer(server);
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      });
    }
  },
  60_000,
);
