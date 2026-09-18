import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import test from "node:test";

const repoRoot = resolve(import.meta.dirname, "..");

function read(relativePath: string): string {
  return readFileSync(resolve(repoRoot, relativePath), "utf8");
}

test("browser-runtime image includes noVNC dependencies and healthchecks live view", () => {
  const dockerfile = read("docker/browser-runtime/Dockerfile");

  assert.match(dockerfile, /\bx11vnc\b/);
  assert.match(dockerfile, /\bnovnc\b/);
  assert.match(dockerfile, /\bwebsockify\b/);
  assert.match(dockerfile, /EXPOSE 6080 9222/);
  assert.match(dockerfile, /127\.0\.0\.1:6080\/vnc\.html/);
});

test("browser startup script wires Xvfb into x11vnc and noVNC", () => {
  const script = read("docker/browser-runtime/start-browser.sh");

  assert.match(script, /\bgosu browser x11vnc\b/);
  assert.match(script, /-display "\$\{display\}"/);
  assert.match(script, /-rfbport "\$\{vnc_port\}"/);
  assert.match(script, /\bgosu browser websockify\b/);
  assert.match(script, /--web=\/usr\/share\/novnc\//);
  assert.match(script, /"\$\{novnc_port\}"/);
  assert.match(script, /"127\.0\.0\.1:\$\{vnc_port\}"/);
});

test("compose exposes live view only on localhost while keeping CDP internal", () => {
  const compose = read("compose.yaml");

  assert.match(compose, /expose:\n(?:\s+- ".+"\n)*\s+- "9222"/);
  assert.match(compose, /ports:\n\s+- "127\.0\.0\.1:6080:6080"/);
  assert.doesNotMatch(compose, /127\.0\.0\.1:9222:9222|0\.0\.0\.0:9222:9222|:\s*"9222:9222"/);
});
