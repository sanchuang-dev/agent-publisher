import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { expect, test } from "vitest";

const repoRoot = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

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

  for (const processName of ["xvfb", "chromium", "x11vnc", "websockify"]) {
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

test("compose exposes Live View only on localhost while keeping raw VNC and CDP internal", () => {
  const composeFile = read("compose.yaml");

  expect(composeFile).toMatch(/expose:\n(?:\s+- ".+"\n)*\s+- "9222"/);
  expect(composeFile).toMatch(/ports:\n\s+- "127\.0\.0\.1:6080:6080"/);
  expect(composeFile).not.toMatch(/(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?9222:9222"/m);
  expect(composeFile).not.toMatch(/(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?5900:5900"/m);
});
