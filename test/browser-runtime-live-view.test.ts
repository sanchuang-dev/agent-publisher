import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");
const startScriptPath = resolve(repoRoot, "docker/browser-runtime/start-browser.sh");
const healthScriptPath = resolve(repoRoot, "docker/browser-runtime/health-browser.sh");
const criticalProcesses = ["xvfb", "chromium", "x11vnc", "websockify"] as const;

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

interface HealthHarness {
  readonly root: string;
  readonly runtimeDir: string;
  readonly binDir: string;
  readonly curlLog: string;
}

function createHealthHarness(options: { missingProcess?: string } = {}): HealthHarness {
  const root = mkdtempSync(join(tmpdir(), "browser-runtime-health-"));
  const runtimeDir = join(root, "runtime");
  const binDir = join(root, "bin");
  const curlLog = join(root, "curl.log");

  mkdirSync(runtimeDir);
  mkdirSync(binDir);

  for (const processName of criticalProcesses) {
    if (processName !== options.missingProcess) {
      writeFileSync(join(runtimeDir, `${processName}.pid`), `${process.pid}\n`);
    }
  }

  writeFileSync(
    join(binDir, "curl"),
    [
      "#!/bin/sh",
      "printf '%s\\n' \"$*\" >> \"$CURL_LOG\"",
      "exit \"${FAKE_CURL_EXIT:-0}\"",
      "",
    ].join("\n"),
    { mode: 0o755 },
  );

  return { root, runtimeDir, binDir, curlLog };
}

function runHealthcheck(
  harness: HealthHarness,
  options: { curlExitCode?: number } = {},
) {
  return spawnSync("sh", [healthScriptPath], {
    encoding: "utf8",
    env: {
      ...process.env,
      BROWSER_RUNTIME_DIR: harness.runtimeDir,
      CURL_LOG: harness.curlLog,
      FAKE_CURL_EXIT: String(options.curlExitCode ?? 0),
      PATH: `${harness.binDir}:${process.env.PATH ?? ""}`,
    },
  });
}

test("browser-runtime shell entrypoints pass shell syntax validation", () => {
  for (const scriptPath of [startScriptPath, healthScriptPath]) {
    const result = spawnSync("sh", ["-n", scriptPath], { encoding: "utf8" });

    expect(result.status, result.stderr).toBe(0);
  }
});

test("browser-runtime image includes noVNC dependencies and lifecycle healthcheck", () => {
  const dockerfile = read("docker/browser-runtime/Dockerfile");

  expect(dockerfile).toMatch(/\bchromium-sandbox\b/);
  expect(dockerfile).toMatch(/\bx11vnc\b/);
  expect(dockerfile).toMatch(/\bnovnc\b/);
  expect(dockerfile).toMatch(/\bwebsockify\b/);
  expect(dockerfile).toMatch(/COPY health-browser\.sh \/usr\/local\/bin\/health-browser/);
  expect(dockerfile).toMatch(/EXPOSE 6080 9222/);
  expect(dockerfile).toMatch(/HEALTHCHECK[\s\S]*\/usr\/local\/bin\/health-browser/);
});

test("browser startup script uses the stable internal Live View transport contract", () => {
  const script = read("docker/browser-runtime/start-browser.sh");

  expect(script).toMatch(/vnc_port="5900"/);
  expect(script).toMatch(/novnc_port="6080"/);
  expect(script).not.toMatch(/VNC_PORT|NOVNC_PORT/);
  expect(script).toMatch(/display="\$\{DISPLAY:-:99\}"/);
  expect(script).toMatch(/\bgosu browser Xvfb "\$\{display\}"/);
  expect(script).toMatch(/\bgosu browser x11vnc[\s\S]*-display "\$\{display\}"/);
  expect(script).toMatch(/-rfbport "\$\{vnc_port\}"/);
  expect(script).toMatch(/\bgosu browser websockify\b/);
  expect(script).toMatch(/--web=\/usr\/share\/novnc\//);
  expect(script).toMatch(/"127\.0\.0\.1:\$\{vnc_port\}"/);
});

test("browser startup script supervises all critical processes", () => {
  const script = read("docker/browser-runtime/start-browser.sh");

  for (const processName of criticalProcesses) {
    expect(script).toMatch(new RegExp(`record_pid ${processName} `));
    expect(script).toMatch(new RegExp(`${processName}_pid`));
  }
});

test("healthcheck rejects missing or zombie critical processes before probing endpoints", () => {
  const healthScript = read("docker/browser-runtime/health-browser.sh");

  expect(healthScript).toMatch(/for process_name in xvfb chromium x11vnc websockify/);
  expect(healthScript).toMatch(/\/proc\/\$\{process_pid\}\/stat/);
  expect(healthScript).toMatch(/"\$\{process_state\}" = "Z"/);
  expect(healthScript).toMatch(/127\.0\.0\.1:9222\/json\/version/);
  expect(healthScript).toMatch(/127\.0\.0\.1:6080\/vnc\.html/);
});

test("healthcheck executes the fixed CDP and noVNC probes when critical processes are live", () => {
  const harness = createHealthHarness();

  try {
    const result = runHealthcheck(harness);

    expect(result.status, result.stderr).toBe(0);

    const calls = readFileSync(harness.curlLog, "utf8")
      .trim()
      .split("\n");

    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("http://127.0.0.1:9222/json/version");
    expect(calls[1]).toContain("http://127.0.0.1:6080/vnc.html");
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("healthcheck fails before endpoint probes when a critical process pid is missing", () => {
  const harness = createHealthHarness({ missingProcess: "websockify" });

  try {
    const result = runHealthcheck(harness);

    expect(result.status).not.toBe(0);
    expect(result.stderr).toContain("Missing pid file for websockify");
    expect(existsSync(harness.curlLog)).toBe(false);
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("healthcheck fails when an endpoint probe fails", () => {
  const harness = createHealthHarness();

  try {
    const result = runHealthcheck(harness, { curlExitCode: 22 });

    expect(result.status).not.toBe(0);
    expect(readFileSync(harness.curlLog, "utf8")).toContain(
      "http://127.0.0.1:9222/json/version",
    );
  } finally {
    rmSync(harness.root, { recursive: true, force: true });
  }
});

test("compose exposes Live View only on localhost while keeping raw VNC and CDP internal", () => {
  const composeFile = read("compose.yaml");

  expect(composeFile).toMatch(/expose:\n(?:\s+- ".+"\n)*\s+- "9222"/);
  expect(composeFile).toMatch(/ports:\n\s+- "127\.0\.0\.1:6080:6080"/);
  expect(composeFile).not.toMatch(/(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?9222:9222"/m);
  expect(composeFile).not.toMatch(/(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?5900:5900"/m);
});

test("browser profile uses the named persistent volume and Chromium user-data-dir contract", () => {
  const composeFile = read("compose.yaml");
  const startScript = read("docker/browser-runtime/start-browser.sh");

  expect(composeFile).toMatch(
    /volumes:\n\s+- browser-profile:\/data\/profile/,
  );
  expect(composeFile).toMatch(/\nvolumes:\n\s+browser-profile:\s*\n?$/);
  expect(startScript).toMatch(
    /profile_dir="\$\{BROWSER_PROFILE_DIR:-\/data\/profile\}"/,
  );
  expect(startScript).toMatch(/--user-data-dir="\$\{profile_dir\}"/);
});
