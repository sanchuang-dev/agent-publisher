import { fileURLToPath } from "node:url";

import {
  JobNotFoundError,
  type Job,
  type JobRepository,
} from "../contracts/job.js";
import type { MaterialPlan } from "../materials/contracts.js";
import { parseMaterialPlanOutput } from "../materials/material-plan-validation.js";
import type { AgentDefinition } from "./definition.js";
import type {
  AgentSessionBindingRepository,
} from "./job-session-binding.js";
import type { JobAgentSessionService } from "./job-session-service.js";
import type { PiResourceLoaderFactoryInput } from "./pi-agent-host.js";
import { createControlledPiResourceLoader } from "./pi-controlled-resources.js";

export const CONTENT_SECRETARY_ROLE = "content" as const;
export const CONTENT_SECRETARY_ALLOWED_TOOLS = [] as const;

export const contentSecretaryDefinition: AgentDefinition = {
  id: "content-secretary",
  systemPrompt: [
    "You are the Content Secretary for Agent Publisher.",
    "Use only the read-only Publisher Job Context and host-provisioned resources for this task.",
    "The user-selected platform and publish mode are fixed inputs. Never change or reinterpret them.",
    "Your authority ends at proposing a MaterialPlan. Never claim that Job state, approval, publication, or any external side effect changed.",
    "Return exactly one JSON object matching the requested MaterialPlan shape. Do not use markdown fences or surrounding prose.",
  ].join("\n"),
};

const publisherSafetySkillPath = fileURLToPath(
  new URL("../../skills/publisher-safety/SKILL.md", import.meta.url),
);

/**
 * Content planning is a context-to-structure task, so it intentionally exposes
 * no execution tools. The standard Publisher safety Skill is mandatory and
 * host-injected; ambient Pi resources remain disabled by the controlled loader.
 */
export function createContentSecretaryResourceLoader(
  input: PiResourceLoaderFactoryInput,
) {
  if (input.definition.id !== contentSecretaryDefinition.id) {
    throw new Error(
      `Content Secretary resource profile cannot load definition ${input.definition.id}`,
    );
  }
  if (input.allowedTools.length !== 0) {
    throw new Error(
      "Content Secretary MaterialPlan sessions must not receive execution tools",
    );
  }

  return createControlledPiResourceLoader({
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    allowedTools: CONTENT_SECRETARY_ALLOWED_TOOLS,
    policy: {
      skillPaths: [publisherSafetySkillPath],
      mandatorySkillPaths: [publisherSafetySkillPath],
      readRoots: [],
      executionGuardAllowedTools: CONTENT_SECRETARY_ALLOWED_TOOLS,
    },
  });
}

export interface ContentSecretaryMaterialPlanResult {
  readonly plan: MaterialPlan;
  readonly job: Job;
}

type ContentSecretaryJobs = Pick<
  JobRepository,
  "getById" | "commitCheckpoint"
>;

type ContentSecretaryBindings = Pick<
  AgentSessionBindingRepository,
  "getForScope"
>;

type ContentSecretarySessions = Pick<
  JobAgentSessionService,
  "create" | "resume"
>;

export class ContentSecretaryService {
  readonly #jobs: ContentSecretaryJobs;
  readonly #bindings: ContentSecretaryBindings;
  readonly #sessions: ContentSecretarySessions;

  constructor(dependencies: {
    readonly jobs: ContentSecretaryJobs;
    readonly bindings: ContentSecretaryBindings;
    readonly sessions: ContentSecretarySessions;
  }) {
    this.#jobs = dependencies.jobs;
    this.#bindings = dependencies.bindings;
    this.#sessions = dependencies.sessions;
  }

  async createMaterialPlan(
    jobId: string,
  ): Promise<ContentSecretaryMaterialPlanResult> {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const scope = { jobId: job.id, role: CONTENT_SECRETARY_ROLE };
    const existingBinding = this.#bindings.getForScope(scope);
    const session = existingBinding
      ? await this.#sessions.resume({
          jobId: job.id,
          role: scope.role,
          definition: contentSecretaryDefinition,
        })
      : await this.#sessions.create({
          jobId: job.id,
          role: scope.role,
          definition: contentSecretaryDefinition,
        });

    const startedAt = new Date().toISOString();

    try {
      const result = await session.run({
        prompt: buildMaterialPlanPrompt(job),
      });
      const plan = parseMaterialPlanOutput(result.finalText, {
        mode: job.publishMode,
        platform: job.platform,
      });
      const finishedAt = new Date().toISOString();

      const checkpointedJob = this.#jobs.commitCheckpoint(job.id, {
        status: "preparing_materials",
        checkpoint: {
          phase: "material_plan_ready",
          materialPlanId: plan.id,
        },
        step: {
          id: `${job.id}:material-plan:1`,
          stepKey: "material_plan",
          status: "succeeded",
          attempt: 1,
          outputJson: JSON.stringify(plan),
          startedAt,
          finishedAt,
        },
      });

      return { plan, job: checkpointedJob };
    } finally {
      await session.dispose();
    }
  }
}

function buildMaterialPlanPrompt(job: Job): string {
  const shape =
    job.publishMode === "image_text"
      ? [
          '"mode":"image_text"',
          '"id": string',
          '"brief": {"id": string, "brief": string, "platform": the exact Job platform, "mode":"image_text"}',
          '"imageCount": integer >= 1',
          '"coverRequired": true',
          '"design": "none" | "optional" | "required"',
        ]
      : [
          '"mode":"video"',
          '"id": string',
          '"brief": {"id": string, "brief": string, "platform": the exact Job platform, "mode":"video"}',
          '"coverRequired": true',
          '"supportingImageCount": integer >= 0',
          '"onVideoUnavailable": "fail" | "allow_without_video"',
        ];

  return [
    "Create the MaterialPlan for the current Publisher Job.",
    `The selected mode is ${job.publishMode}; it must not change.`,
    "Use the Job brief from the read-only Publisher Job Context.",
    "Return one JSON object only with these fields:",
    ...shape.map((field) => `- ${field}`),
    "Do not add workflow status, approval state, transcript data, browser state, or publication claims.",
  ].join("\n");
}
