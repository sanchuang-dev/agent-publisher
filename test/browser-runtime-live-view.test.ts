import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

test("browser-runtime image includes noVNC dependencies and lifecycle healthcheck", () => {
  const dockerfile = read("docker/browser-runtime/Dockerfile");

  assert.match(dockerfile, /\bx11vnc\b/);
  assert.match(dockerfile, /\bnovnc\b/);
  assert.match(dockerfile, /\bwebsockify\b/);
  assert.match(dockerfile, /COPY health-browser\.sh \/usr\/local\/bin\/health-browser/);
  assert.match(dockerfile, /EXPOSE 6080 9222/);
  assert.match(dockerfile, /HEALTHCHECK[\s\S]*\/usr\/local\/bin\/health-browser/);
});

test("browser startup script wires the same Xvfb display into x11vnc and supervises all critical processes", () => {
  const script = read("docker/browser-runtime/start-browser.sh");

  assert.match(script, /display="\$\{DISPLAY:-:99\}"/);
  assert.match(script, /\bgosu browser Xvfb "\$\{display\}"/);
  assert.match(script, /\bgosu browser x11vnc[\s\S]*-display "\$\{display\}"/);
  assert.match(script, /-rfbport "\$\{vnc_port\}"/);
  assert.match(script, /\bgosu browser websockify\b/);
  assert.match(script, /--web=\/usr\/share\/novnc\//);
  assert.match(script, /"127\.0\.0\.1:\$\{vnc_port\}"/);

  for (const processName of ["xvfb", "chromium", "x11vnc", "websockify"]) {
    assert.match(script, new RegExp(`record_pid ${processName} `));
  }
});

test("healthcheck rejects missing or zombie critical processes before probing endpoints", () => {
  const health = read("docker/browser-runtime/health-browser.sh");

  assert.match(health, /for process_name in xvfb chromium x11vnc websockify/);
  assert.match(health, /\/proc\/\$\{process_pid\}\/stat/);
  assert.match(health, /"\$\{process_state\}" = "Z"/);
  assert.match(health, /127\.0\.0\.1:9222\/json\/version/);
  assert.match(health, /127\.0\.0\.1:6080\/vnc\.html/);
});

test("compose exposes Live View only on localhost while keeping raw VNC and CDP internal", () => {
  const compose = read("compose.yaml");

  assert.match(compose, /expose:\n(?:\s+- ".+"\n)*\s+- "9222"/);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1:6080:6080"/);
  assert.doesNotMatch(compose, /(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?9222:9222"/m);
  assert.doesNotMatch(compose, /(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?5900:5900"/m);
});
