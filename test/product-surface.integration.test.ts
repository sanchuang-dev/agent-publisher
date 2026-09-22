import { createServer } from "node:http";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import { createApplication } from "../src/app/bootstrap.js";

const cleanup: Array<() => Promise<void> | void> = [];

afterEach(async () => {
  while (cleanup.length > 0) {
    await cleanup.pop()!();
  }
});

async function listen(server: ReturnType<typeof createServer>): Promise<string> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });

  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("test server did not expose an address");
  }
  return `http://127.0.0.1:${address.port}`;
}

describe("DEP-01 product surface", () => {
  test("serves the production Web bundle and SPA fallback without masking API 404s", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-web-root-"));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));

    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html><body>publisher-web</body></html>");
    writeFileSync(join(root, "assets", "app.js"), "globalThis.__publisher = true;");

    const application = createApplication({
      productSurface: { webRoot: root },
    });
    cleanup.push(() => application.stop());

    const rootResponse = await application.server.inject({
      method: "GET",
      url: "/",
    });
    expect(rootResponse.statusCode).toBe(200);
    expect(rootResponse.headers["content-type"]).toContain("text/html");
    expect(rootResponse.body).toContain("publisher-web");

    const spaResponse = await application.server.inject({
      method: "GET",
      url: "/jobs/example",
    });
    expect(spaResponse.statusCode).toBe(200);
    expect(spaResponse.body).toContain("publisher-web");

    const assetResponse = await application.server.inject({
      method: "GET",
      url: "/assets/app.js",
    });
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["cache-control"]).toContain("immutable");

    const apiResponse = await application.server.inject({
      method: "GET",
      url: "/api/not-a-real-route",
    });
    expect(apiResponse.statusCode).toBe(404);
    expect(apiResponse.body).not.toContain("publisher-web");
  });

  test("proxies Live View HTTP through the product origin and strips the public prefix", async () => {
    const upstream = createServer((request, response) => {
      response.setHeader("content-type", "application/json");
      response.end(JSON.stringify({ url: request.url }));
    });
    const upstreamOrigin = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const application = createApplication({
      productSurface: { browserLiveViewUpstream: upstreamOrigin },
    });
    cleanup.push(() => application.stop());

    const response = await application.server.inject({
      method: "GET",
      url: "/browser-live-view/vnc.html?path=browser-live-view/websockify",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      url: "/vnc.html?path=browser-live-view/websockify",
    });
  });

  test("proxies Live View WebSocket upgrades through the product origin", async () => {
    const upstream = createServer();
    upstream.on("upgrade", (request, socket) => {
      expect(request.url).toBe("/websockify");
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\n\r\n",
      );
    });
    const upstreamOrigin = await listen(upstream);
    cleanup.push(
      () =>
        new Promise<void>((resolve, reject) =>
          upstream.close((error) => (error ? reject(error) : resolve())),
        ),
    );

    const application = createApplication({
      productSurface: { browserLiveViewUpstream: upstreamOrigin },
    });
    const origin = await application.start({ host: "127.0.0.1", port: 0 });
    cleanup.push(() => application.stop());

    const appUrl = new URL(origin);
    const response = await new Promise<string>((resolve, reject) => {
      const socket = connect(Number(appUrl.port), appUrl.hostname);
      let received = "";

      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new Error("timed out waiting for proxied websocket upgrade"));
      }, 1_000);

      socket.once("connect", () => {
        socket.write(
          [
            "GET /browser-live-view/websockify HTTP/1.1",
            `Host: ${appUrl.host}`,
            "Connection: Upgrade",
            "Upgrade: websocket",
            "",
            "",
          ].join("\r\n"),
        );
      });

      socket.on("data", (chunk) => {
        received += chunk.toString("utf8");
        if (received.includes("\r\n\r\n")) {
          clearTimeout(timeout);
          socket.destroy();
          resolve(received);
        }
      });
      socket.once("error", reject);
    });

    expect(response).toContain("101 Switching Protocols");
  });

  test("refuses to expose raw CDP as the Live View upstream", () => {
    expect(() =>
      createApplication({
        productSurface: {
          browserLiveViewUpstream: "http://browser-runtime:9222",
        },
      }),
    ).toThrow(/raw CDP/);
  });
});
