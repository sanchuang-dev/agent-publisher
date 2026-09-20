import type { FastifyPluginAsync } from "fastify";

const readinessResponseSchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: {
    status: { const: "ready" },
  },
} as const;

export const healthRoutes: FastifyPluginAsync = async (server) => {
  server.get(
    "/health/ready",
    {
      schema: {
        response: {
          200: readinessResponseSchema,
        },
      },
    },
    async () => ({ status: "ready" as const }),
  );
};
