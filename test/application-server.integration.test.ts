import type { FastifyPluginAsync } from "fastify";
import { describe, expect, test } from "vitest";

import { createSseFixtureRoutes } from "../src/api/routes/events-fixture.js";
import { SseConnectionRegistry } from "../src/api/sse.js";
import {
  createApplication,
  type AgentPublisherApplication,
} from "../src/app/bootstrap.js";

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
    const abort = new AbortController();

    try {
      const response = await fetch(`${origin}/api/_fixtures/events`, {
        signal: abort.signal,
      });
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toContain(
        "text/event-stream",
      );

      const reader = response.body?.getReader();
      expect(reader).toBeDefined();

      const firstRead = await reader!.read();
      const payload = new TextDecoder().decode(firstRead.value);

      expect(payload).toContain("event: fixture");
      expect(payload).toContain('data: {"status":"connected"}');
      expect(application.dependencies.sseConnections.activeCount).toBe(1);

      const readerClosed = reader!.closed.catch(() => undefined);
      abort.abort();
      await readerClosed;
      await waitFor(
        () => application.dependencies.sseConnections.activeCount === 0,
      );
    } finally {
      abort.abort();
      await application.stop();
    }
  });

  test("graceful shutdown closes active SSE listeners deterministically", async () => {
    const application = createSseTestApplication();
    const origin = await application.start({ host: "127.0.0.1", port: 0 });

    const response = await fetch(`${origin}/api/_fixtures/events`);
    const reader = response.body?.getReader();
    expect(reader).toBeDefined();

    const firstRead = await reader!.read();
    expect(firstRead.done).toBe(false);
    expect(application.dependencies.sseConnections.activeCount).toBe(1);

    const stopPromise = application.stop();
    const finalRead = await reader!.read();

    await stopPromise;

    expect(finalRead.done).toBe(true);
    expect(application.dependencies.sseConnections.activeCount).toBe(0);
    expect(application.server.server.listening).toBe(false);
  });
});
