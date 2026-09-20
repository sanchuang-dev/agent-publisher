import type { FastifyPluginAsync } from "fastify";

import { JobNotFoundError } from "../../contracts/job.js";
import type { JobProjectionEventBus } from "../../app/job-events.js";
import type { JobProjectionService } from "../../app/job-projection.js";
import type { SseConnectionRegistry } from "../sse.js";

interface JobParams {
  readonly jobId: string;
}

export function createJobEventRoutes(dependencies: {
  readonly events: JobProjectionEventBus;
  readonly projections: JobProjectionService;
  readonly connections: SseConnectionRegistry;
}): FastifyPluginAsync {
  return async (server) => {
    server.get<{ Params: JobParams }>(
      "/jobs/:jobId/events",
      async (request, reply) => {
        let initial;
        try {
          initial = dependencies.projections.get(request.params.jobId);
        } catch (error) {
          if (error instanceof JobNotFoundError) {
            return reply.code(404).send({
              error: {
                code: "JOB_NOT_FOUND",
                message: "The requested publish job does not exist.",
              },
            });
          }

          throw error;
        }

        reply.hijack();
        const connection = dependencies.connections.open(reply.raw);
        const unsubscribe = dependencies.events.subscribe(
          request.params.jobId,
          (projection) => {
            connection.send({
              event: "job",
              id: projection.updatedAt,
              data: { job: projection },
            });
          },
        );

        connection.send({
          event: "job",
          id: initial.updatedAt,
          data: { job: initial },
        });

        try {
          await connection.closed;
        } finally {
          unsubscribe();
        }
      },
    );
  };
}
