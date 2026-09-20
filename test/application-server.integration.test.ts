import { get } from "node:http";

import type { FastifyPluginAsync } from "fastify";
import { describe, expect, test } from "vitest";

import { createSseFixtureRoutes } from "../src/api/routes/events-fixture.js";
import { SseConnectionRegistry } from "../src/api/sse.js";
import {
  createApplication,
  type AgentPublisherApplication,
} from "../src/app/bootstrap.js";

interface TestSseClient {
  readonly statusCode: number | undefined;
  readonly contentType: string;
  readonly firstChunk: string;
  readonly closed: Promise<void>;
  disconnect(): void;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for application state");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createSseTestApplication(): AgentPublisherApplication {
  const sseConnections = new SseConnectionRegistry();

  return createApplication({
    dependencies: { sseConnections },
    routeModules: {
      events: createSseFixtureRoutes(sseConnections),
    },
  });
}

function connectSse(url: string): Promise<TestSseClient> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.setEncoding("utf8");
      response.once("error", reject);

      response.once("data", (chunk) => {
        const closed = new Promise<void>((resolveClosed) => {
          response.once("close", resolveClosed);
        });

        resolve({
          statusCode: response.statusCode,
          contentType: String(response.headers["content-type"] ?? ""),
          firstChunk: String(chunk),
          closed,
          disconnect: () => {
            response.destroy();
          },
        });
      });
    });

    request.once("error", reject);
  });
}

describe("Fastify application bootstrap", () => {
  test("constructs isolated application instances and returns bounded readiness", async () => {
    const first = createApplication();
    const second = createApplication();

    try {
      expect(first.server).not.toBe(second.server);
      expect(first.dependencies.sseConnections).not.toBe(
        second.dependencies.sseConnections,
      );

      const response = await first.server.inject({
        method: "GET",
        url: "/health/ready",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ status: "ready" });

      const fixtureResponse = await first.server.inject({
        method: "GET",
        url: "/api/_fixtures/events",
      });
      expect(fixtureResponse.statusCode).toBe(404);

      await second.server.ready();
    } finally {
      await Promise.all([first.stop(), second.stop()]);
    }
  });

  test("registers future API modules through explicit route boundaries", async () => {
    const jobs: FastifyPluginAsync = async (server) => {
      server.get("/jobs/_boundary", async () => ({ registered: true }));
    };

    const application = createApplication({
      routeModules: { jobs },
    });

    try {
      const response = await application.server.inject({
        method: "GET",
        url: "/api/jobs/_boundary",
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toEqual({ registered: true });
    } finally {
      await application.stop();
    }
  });

  test("streams one controlled SSE event and releases a disconnected client", async () => {
    const application = createSseTestApplication();
    const origin = await application.start({ host: "127.0.0.1", port: 0 });

    try {
      const client = await connectSse(`${origin}/api/_fixtures/events`);

      expect(client.statusCode).toBe(200);
      expect(client.contentType).toContain("text/event-stream");
      expect(client.firstChunk).toContain("event: fixture");
      expect(client.firstChunk).toContain('data: {"status":"connected"}');
      expect(application.dependencies.sseConnections.activeCount).toBe(1);

      client.disconnect();
      await client.closed;
      await waitFor(
        () => application.dependencies.sseConnections.activeCount === 0,
      );
    } finally {
      await application.stop();
    }
  });

  test("graceful shutdown closes active SSE listeners deterministically", async () => {
    const application = createSseTestApplication();
    const origin = await application.start({ host: "127.0.0.1", port: 0 });
    const client = await connectSse(`${origin}/api/_fixtures/events`);

    expect(application.dependencies.sseConnections.activeCount).toBe(1);

    const stopPromise = application.stop();
    await client.closed;
    await stopPromise;

    expect(application.dependencies.sseConnections.activeCount).toBe(0);
    expect(application.server.server.listening).toBe(false);
  });
});
