import type { FastifyPluginAsync } from "fastify";

import {
  PrepublishApprovalActionError,
  type XiaohongshuPrepublishOrchestrator,
} from "../../app/xiaohongshu-prepublish-orchestrator.js";

interface ActionParams {
  readonly actionId: string;
}

interface ResolveApprovalBody {
  readonly approved?: unknown;
}

function parseResolveBody(
  value: unknown,
): { readonly approved: boolean } | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  const body = value as ResolveApprovalBody;
  return body.approved === true
    ? { approved: true }
    : null;
}

export function createActionRoutes(
  orchestrator: XiaohongshuPrepublishOrchestrator,
): FastifyPluginAsync {
  return async (server) => {
    server.post<{ Params: ActionParams }>(
      "/actions/:actionId/resolve",
      async (request, reply) => {
        const input = parseResolveBody(request.body);
        if (!input) {
          return reply.code(400).send({
            error: {
              code: "INVALID_REQUEST",
              message:
                "PUB-02 accepts only durable affirmative approval: { approved: true }.",
            },
          });
        }

        try {
          const job = orchestrator.resolveApproval(
            request.params.actionId,
            input.approved,
          );
          return { job };
        } catch (error) {
          if (error instanceof PrepublishApprovalActionError) {
            return reply.code(409).send({
              error: {
                code: error.code,
                message: error.message,
              },
            });
          }
          throw error;
        }
      },
    );
  };
}
