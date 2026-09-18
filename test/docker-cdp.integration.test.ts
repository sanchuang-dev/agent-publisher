import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
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
  timeoutMs = 10_000,
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
  process: ChildProcessWithoutNullStreams,
): Promise<void> {
  if (process.exitCode !== null || process.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => {
      process.kill("SIGKILL");
    }, 2_000);

    process.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });

    process.kill("SIGTERM");
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
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  },
  20_000,
);
