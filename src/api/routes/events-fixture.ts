import type { FastifyPluginAsync } from "fastify";

import type { SseConnectionRegistry } from "../sse.js";

export function createSseFixtureRoutes(
  connections: SseConnectionRegistry,
): FastifyPluginAsync {
  return async (server) => {
    server.get("/_fixtures/events", async (_request, reply) => {
      reply.hijack();

      const connection = connections.open(reply.raw);
      connection.send({
        event: "fixture",
        data: { status: "connected" },
      });

      await connection.closed;
    });
  };
}
