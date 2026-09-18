import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createServer, type Server } from "node:http";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
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

async function stopProcess(
  child: ChildProcessWithoutNullStreams,
): Promise<void> {
  const killProcessTree = (signal: NodeJS.Signals) => {
    if (process.platform !== "win32" && child.pid !== undefined) {
      try {
        process.kill(-child.pid, signal);
        return;
      } catch {
        // Fall back to the direct child below.
      }
    }

    child.kill(signal);
  };

  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      killProcessTree("SIGKILL");
    }, 2_000);

    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    killProcessTree("SIGTERM");
  });
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

test(
  "real Chromium preserves non-sensitive localStorage across process restart with the same profile",
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
      await first.page.evaluate(() => {
        localStorage.setItem("m1_04_profile_smoke", "persisted");
      });
      await expect(
        first.page.evaluate(() =>
          localStorage.getItem("m1_04_profile_smoke"),
        ),
      ).resolves.toBe("persisted");
      await firstProvider.release(first.id);

      await stopProcess(chromiumProcess);
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
        second.page.evaluate(() =>
          localStorage.getItem("m1_04_profile_smoke"),
        ),
      ).resolves.toBe("persisted");

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
  45_000,
);
