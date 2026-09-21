import { JobNotFoundError, type JobRepository } from "../contracts/job.js";
import type { ContentSecretaryService } from "../agent/content-secretary.js";
import {
  parseMaterialPlanOutput,
} from "../materials/material-plan-validation.js";
import type {
  ImageTextMaterialPlan,
  MaterialPlan,
} from "../materials/contracts.js";
import {
  MaterialPreparationProviderError,
  type MaterialPreparationService,
} from "../materials/material-preparation-service.js";
import {
  PROVIDER_PIPELINE_MATERIAL_SOURCE,
  PrepublishMaterialResolutionError,
  type PrepublishMaterialSource,
} from "./prepublish-material-source.js";

const MATERIAL_PLAN_STEP_KEY = "material_plan";

export type ProviderPipelineMaterialStage =
  | "material_plan"
  | "material_preparation";

export class ProviderPipelineMaterialStageError extends PrepublishMaterialResolutionError {
  constructor(
    readonly stage: ProviderPipelineMaterialStage,
    code: string,
    retryable: boolean,
    message: string,
    options?: ErrorOptions,
  ) {
    super(code, retryable, message, options);
    this.name = "ProviderPipelineMaterialStageError";
  }
}

type ProviderPipelineJobs = Pick<
  JobRepository,
  "getById" | "getStepsForJob"
>;

type ContentSecretaryPort = Pick<
  ContentSecretaryService,
  "createMaterialPlan"
>;

type MaterialPreparationPort = Pick<
  MaterialPreparationService,
  "prepareImageText"
>;

function findPersistedMaterialPlan(
  jobs: ProviderPipelineJobs,
  jobId: string,
): MaterialPlan | null {
  const job = jobs.getById(jobId);
  if (!job) {
    throw new JobNotFoundError(jobId);
  }

  for (const step of [...jobs.getStepsForJob(jobId)].reverse()) {
    if (
      step.stepKey !== MATERIAL_PLAN_STEP_KEY ||
      step.status !== "succeeded" ||
      step.outputJson === null
    ) {
      continue;
    }

    return parseMaterialPlanOutput(step.outputJson, {
      mode: job.publishMode,
      platform: job.platform,
    });
  }

  return null;
}

function requireImageTextPlan(
  jobId: string,
  plan: MaterialPlan,
): ImageTextMaterialPlan {
  if (plan.mode !== "image_text") {
    throw new Error(
      `Provider pipeline source for Job ${jobId} currently supports image_text only.`,
    );
  }
  return plan;
}

function materialPlanFailure(error: unknown): ProviderPipelineMaterialStageError {
  if (error instanceof ProviderPipelineMaterialStageError) {
    return error;
  }

  if (error instanceof PrepublishMaterialResolutionError) {
    return new ProviderPipelineMaterialStageError(
      "material_plan",
      error.code,
      error.retryable,
      "Provider pipeline could not produce a valid MaterialPlan.",
      { cause: error },
    );
  }

  return new ProviderPipelineMaterialStageError(
    "material_plan",
    "MATERIAL_GENERATION_FAILED",
    false,
    "Provider pipeline could not produce a valid MaterialPlan.",
    { cause: error },
  );
}

function materialPreparationFailure(
  error: unknown,
): ProviderPipelineMaterialStageError {
  if (error instanceof ProviderPipelineMaterialStageError) {
    return error;
  }

  if (error instanceof MaterialPreparationProviderError) {
    return new ProviderPipelineMaterialStageError(
      "material_preparation",
      error.code,
      error.retryable,
      "Provider pipeline material preparation failed.",
      { cause: error },
    );
  }

  if (error instanceof PrepublishMaterialResolutionError) {
    return new ProviderPipelineMaterialStageError(
      "material_preparation",
      error.code,
      error.retryable,
      "Provider pipeline material preparation failed.",
      { cause: error },
    );
  }

  return new ProviderPipelineMaterialStageError(
    "material_preparation",
    "MATERIAL_GENERATION_FAILED",
    false,
    "Provider pipeline material preparation failed before producing a valid MaterialPack.",
    { cause: error },
  );
}

/**
 * Real material source for the APP-02 pre-publish seam.
 *
 * The source reuses an already checkpointed MaterialPlan before asking the
 * Content Secretary to plan again. MaterialPreparationService then owns the
 * provider-step checkpoints; the existing orchestrator remains the single
 * owner of the final material_pack JobStep.
 */
export function createProviderPipelineMaterialSource(dependencies: {
  readonly jobs: ProviderPipelineJobs;
  readonly contentSecretary: ContentSecretaryPort;
  readonly preparation: MaterialPreparationPort;
}): PrepublishMaterialSource {
  return {
    async resolve(input) {
      const job = dependencies.jobs.getById(input.jobId);
      if (!job) {
        throw new JobNotFoundError(input.jobId);
      }
      if (job.publishMode !== "image_text") {
        throw new Error(
          `Provider pipeline material source does not yet support ${job.publishMode}.`,
        );
      }

      let plan: ImageTextMaterialPlan;
      try {
        const persistedPlan = findPersistedMaterialPlan(
          dependencies.jobs,
          input.jobId,
        );
        plan = requireImageTextPlan(
          input.jobId,
          persistedPlan ??
            (await dependencies.contentSecretary.createMaterialPlan(input.jobId))
              .plan,
        );
      } catch (error) {
        throw materialPlanFailure(error);
      }

      try {
        const prepared = await dependencies.preparation.prepareImageText(
          input.jobId,
          plan,
        );

        return {
          source: PROVIDER_PIPELINE_MATERIAL_SOURCE,
          generatedFromBrief: true,
          pack: prepared.pack,
        };
      } catch (error) {
        throw materialPreparationFailure(error);
      }
    },
  };
}
