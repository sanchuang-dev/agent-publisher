import type { FastifyPluginAsync } from "fastify";

import { JobNotFoundError } from "../../contracts/job.js";
import {
  PrepublishJobBusyError,
  UnsupportedPrepublishStateError,
  type XiaohongshuPrepublishOrchestrator,
} from "../../app/xiaohongshu-prepublish-orchestrator.js";

interface CreateJobBody {
  readonly brief?: unknown;
  readonly platform?: unknown;
  readonly publishMode?: unknown;
}

interface JobParams {
  readonly jobId: string;
}

function parseCreateBody(value: unknown): { readonly brief: string } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const body = value as CreateJobBody;
  if (typeof body.brief !== "string" || !body.brief.trim()) {
    return null;
  }

  if (
    body.platform !== undefined &&
    body.platform !== "xiaohongshu"
  ) {
    return null;
  }

  if (
    body.publishMode !== undefined &&
    body.publishMode !== "image_text"
  ) {
    return null;
  }

  return { brief: body.brief.trim() };
}

function isJobNotFound(error: unknown): error is JobNotFoundError {
  return error instanceof JobNotFoundError;
}

export function createJobRoutes(
  orchestrator: XiaohongshuPrepublishOrchestrator,
): FastifyPluginAsync {
  return async (server) => {
    server.post("/jobs", async (request, reply) => {
      const input = parseCreateBody(request.body);
      if (!input) {
        return reply.code(400).send({
          error: {
            code: "INVALID_REQUEST",
            message:
              "APP-02 accepts a non-empty brief for Xiaohongshu image_text only.",
          },
        });
      }

      const job = await orchestrator.createJob(input);
      return reply.code(201).send({ job });
    });

    server.get<{ Params: JobParams }>("/jobs/:jobId", async (request, reply) => {
      try {
        return { job: orchestrator.getJob(request.params.jobId) };
      } catch (error) {
        if (isJobNotFound(error)) {
          return reply.code(404).send({
            error: {
              code: "JOB_NOT_FOUND",
              message: "The requested publish job does not exist.",
            },
          });
        }

        throw error;
      }
    });

    server.post<{ Params: JobParams }>(
      "/jobs/:jobId/continue",
      async (request, reply) => {
        try {
          const result = await orchestrator.continueJob(request.params.jobId);
          return {
            job: result.projection,
            run: {
              blocked: result.blocked,
              error: result.error,
            },
          };
        } catch (error) {
          if (isJobNotFound(error)) {
            return reply.code(404).send({
              error: {
                code: "JOB_NOT_FOUND",
                message: "The requested publish job does not exist.",
              },
            });
          }

          if (error instanceof PrepublishJobBusyError) {
            return reply.code(409).send({
              error: {
                code: error.code,
                message: "This job is already being continued.",
              },
            });
          }

          if (error instanceof UnsupportedPrepublishStateError) {
            return reply.code(409).send({
              error: {
                code: error.code,
                message:
                  "The current Job state is outside the APP-02 pre-publish boundary.",
              },
            });
          }

          throw error;
        }
      },
    );
  };
}
