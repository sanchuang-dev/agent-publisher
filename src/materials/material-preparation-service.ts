import { randomUUID } from "node:crypto";

import type { AssetStore } from "../assets/store.js";
import {
  JobNotFoundError,
  type Job,
  type JobRepository,
  type JobStep,
} from "../contracts/job.js";
import { resolveDesignProviderFailure } from "./degradation.js";
import type {
  DesignAssetReference,
  DesignRenderResult,
  ImageAssetReference,
  ImageTextMaterialPack,
  ImageTextMaterialPlan,
  MaterialProviderFailure,
  MaterialWarning,
  ProviderResult,
  TextMaterial,
} from "./contracts.js";
import type { MaterialProviderSlots } from "./providers/index.js";

export const MATERIAL_COPY_STEP_KEY = "material_copy" as const;
export const MATERIAL_IMAGES_STEP_KEY = "material_images" as const;
export const MATERIAL_DESIGN_STEP_KEY = "material_design" as const;
export const MAX_IMAGE_TEXT_MATERIAL_IMAGES = 12 as const;

type MaterialPreparationJobs = Pick<
  JobRepository,
  "getById" | "getStepsForJob" | "commitCheckpoint"
>;

interface PersistedProviderEnvelope<T> {
  readonly version: 1;
  readonly planId: string;
  readonly warnings: readonly MaterialWarning[];
  readonly value: T;
}

type PersistedDesignOutcome =
  | {
      readonly version: 1;
      readonly planId: string;
      readonly outcome: "rendered";
      readonly warnings: readonly MaterialWarning[];
      readonly value: DesignRenderResult;
    }
  | {
      readonly version: 1;
      readonly planId: string;
      readonly outcome: "degraded";
      readonly failure: MaterialProviderFailure;
    };

export interface MaterialPreparationResult {
  readonly pack: ImageTextMaterialPack;
  readonly reusedSteps: readonly string[];
}

export class MaterialPreparationStateError extends Error {
  readonly code = "MATERIAL_INVALID_REQUEST" as const;

  constructor(readonly jobId: string, message: string) {
    super(`Cannot prepare materials for Job ${jobId}: ${message}`);
    this.name = "MaterialPreparationStateError";
  }
}

export class MaterialPreparationCheckpointError extends Error {
  readonly code = "MATERIAL_GENERATION_FAILED" as const;

  constructor(readonly stepKey: string, message: string, options?: ErrorOptions) {
    super(`Invalid persisted material step ${stepKey}: ${message}`, options);
    this.name = "MaterialPreparationCheckpointError";
  }
}

export class MaterialPreparationProviderError extends Error {
  readonly code: MaterialProviderFailure["code"];

  constructor(readonly failure: MaterialProviderFailure) {
    super(failure.message);
    this.name = "MaterialPreparationProviderError";
    this.code = failure.code;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isWarning(value: unknown): value is MaterialWarning {
  return (
    isRecord(value) &&
    (value.code === "VIDEO_PROVIDER_UNAVAILABLE" ||
      value.code === "DESIGN_PROVIDER_UNAVAILABLE" ||
      value.code === "PROVIDER_WARNING") &&
    typeof value.message === "string" &&
    typeof value.reason === "string" &&
    value.userVisible === true
  );
}

function isWarningArray(value: unknown): value is readonly MaterialWarning[] {
  return Array.isArray(value) && value.every(isWarning);
}

function isTextMaterial(value: unknown): value is TextMaterial {
  return (
    isRecord(value) &&
    typeof value.title === "string" &&
    value.title.trim().length > 0 &&
    typeof value.body === "string" &&
    value.body.trim().length > 0 &&
    isStringArray(value.tags)
  );
}

function isAssetBase(
  value: unknown,
): value is Record<string, unknown> & {
  readonly assetId: string;
  readonly uri: string;
  readonly mimeType: string;
} {
  return (
    isRecord(value) &&
    typeof value.assetId === "string" &&
    value.assetId.length > 0 &&
    typeof value.uri === "string" &&
    value.uri === `asset://${value.assetId}` &&
    typeof value.mimeType === "string" &&
    value.mimeType.length > 0
  );
}

function isImageAsset(value: unknown): value is ImageAssetReference {
  return (
    isAssetBase(value) &&
    value.kind === "image" &&
    typeof value.width === "number" &&
    Number.isFinite(value.width) &&
    value.width > 0 &&
    typeof value.height === "number" &&
    Number.isFinite(value.height) &&
    value.height > 0
  );
}

function isDesignAsset(value: unknown): value is DesignAssetReference {
  return isAssetBase(value) && value.kind === "design";
}

function isDesignResult(value: unknown): value is DesignRenderResult {
  return (
    isRecord(value) &&
    (value.source === null || isDesignAsset(value.source)) &&
    isImageAsset(value.cover) &&
    Array.isArray(value.images) &&
    value.images.every(isImageAsset)
  );
}

function isProviderFailure(value: unknown): value is MaterialProviderFailure {
  return (
    isRecord(value) &&
    (value.code === "MATERIAL_PROVIDER_UNAVAILABLE" ||
      value.code === "MATERIAL_GENERATION_FAILED" ||
      value.code === "MATERIAL_INVALID_REQUEST" ||
      value.code === "MATERIAL_UNSUPPORTED_CAPABILITY") &&
    (value.slot === "text" ||
      value.slot === "image" ||
      value.slot === "design" ||
      value.slot === "video") &&
    typeof value.message === "string" &&
    typeof value.retryable === "boolean"
  );
}

function parseJson(stepKey: string, serialized: string): unknown {
  try {
    return JSON.parse(serialized) as unknown;
  } catch (cause) {
    throw new MaterialPreparationCheckpointError(
      stepKey,
      "outputJson is not valid JSON",
      { cause },
    );
  }
}

function parseProviderEnvelope<T>(
  stepKey: string,
  serialized: string,
  planId: string,
  isValue: (value: unknown) => value is T,
): PersistedProviderEnvelope<T> | null {
  const raw = parseJson(stepKey, serialized);
  if (!isRecord(raw) || raw.version !== 1 || typeof raw.planId !== "string") {
    throw new MaterialPreparationCheckpointError(
      stepKey,
      "outputJson does not match the material provider checkpoint envelope",
    );
  }
  if (raw.planId !== planId) {
    return null;
  }
  if (!isWarningArray(raw.warnings) || !isValue(raw.value)) {
    throw new MaterialPreparationCheckpointError(
      stepKey,
      "outputJson contains invalid provider output",
    );
  }

  return raw as unknown as PersistedProviderEnvelope<T>;
}

function parseImageArray(value: unknown): value is readonly ImageAssetReference[] {
  return Array.isArray(value) && value.every(isImageAsset);
}

function parseDesignOutcome(
  serialized: string,
  planId: string,
): PersistedDesignOutcome | null {
  const raw = parseJson(MATERIAL_DESIGN_STEP_KEY, serialized);
  if (
    !isRecord(raw) ||
    raw.version !== 1 ||
    typeof raw.planId !== "string" ||
    (raw.outcome !== "rendered" && raw.outcome !== "degraded")
  ) {
    throw new MaterialPreparationCheckpointError(
      MATERIAL_DESIGN_STEP_KEY,
      "outputJson does not match the design checkpoint envelope",
    );
  }
  if (raw.planId !== planId) {
    return null;
  }

  if (raw.outcome === "rendered") {
    if (!isWarningArray(raw.warnings) || !isDesignResult(raw.value)) {
      throw new MaterialPreparationCheckpointError(
        MATERIAL_DESIGN_STEP_KEY,
        "rendered design checkpoint is invalid",
      );
    }
  } else if (!isProviderFailure(raw.failure) || raw.failure.slot !== "design") {
    throw new MaterialPreparationCheckpointError(
      MATERIAL_DESIGN_STEP_KEY,
      "degraded design checkpoint does not contain a valid design failure",
    );
  }

  return raw as unknown as PersistedDesignOutcome;
}

function nextAttempt(steps: readonly JobStep[], stepKey: string): number {
  return (
    steps
      .filter((step) => step.stepKey === stepKey)
      .reduce((max, step) => Math.max(max, step.attempt), 0) + 1
  );
}

function latestSucceededOutput(
  steps: readonly JobStep[],
  stepKey: string,
): readonly JobStep[] {
  return [...steps]
    .reverse()
    .filter(
      (step) =>
        step.stepKey === stepKey &&
        step.status === "succeeded" &&
        step.outputJson !== null,
    );
}

function mergeWarnings(
  ...groups: readonly (readonly MaterialWarning[])[]
): readonly MaterialWarning[] {
  return groups.flat();
}

export class MaterialPreparationService {
  readonly #jobs: MaterialPreparationJobs;
  readonly #providers: MaterialProviderSlots;
  readonly #assetStore: AssetStore;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: {
    readonly jobs: MaterialPreparationJobs;
    readonly providers: MaterialProviderSlots;
    readonly assetStore: AssetStore;
    readonly createId?: () => string;
    readonly now?: () => Date;
  }) {
    this.#jobs = dependencies.jobs;
    this.#providers = dependencies.providers;
    this.#assetStore = dependencies.assetStore;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async prepareImageText(
    jobId: string,
    plan: ImageTextMaterialPlan,
  ): Promise<MaterialPreparationResult> {
    this.#assertJobState(jobId, plan);
    if (
      plan.imageCount < 1 ||
      plan.imageCount > MAX_IMAGE_TEXT_MATERIAL_IMAGES
    ) {
      throw new MaterialPreparationStateError(
        jobId,
        `imageCount must be between 1 and ${MAX_IMAGE_TEXT_MATERIAL_IMAGES}`,
      );
    }

    const reusedSteps: string[] = [];
    const copy = await this.#resolveCopy(jobId, plan, reusedSteps);
    const images = await this.#resolveImages(jobId, plan, reusedSteps);
    const baseline = {
      copy: copy.value,
      cover: images.value[0]!,
      images: images.value,
    };

    if (plan.design === "none") {
      return {
        pack: {
          mode: "image_text",
          status: "ready",
          planId: plan.id,
          copy: copy.value,
          cover: baseline.cover,
          images: baseline.images,
          design: null,
          warnings: mergeWarnings(copy.warnings, images.warnings),
          degradations: [],
        },
        reusedSteps,
      };
    }

    const design = await this.#resolveDesign(
      jobId,
      plan,
      baseline,
      reusedSteps,
    );

    if (design.outcome === "rendered") {
      return {
        pack: {
          mode: "image_text",
          status: "ready",
          planId: plan.id,
          copy: copy.value,
          cover: design.value.cover,
          images: design.value.images,
          design: design.value.source,
          warnings: mergeWarnings(
            copy.warnings,
            images.warnings,
            design.warnings,
          ),
          degradations: [],
        },
        reusedSteps,
      };
    }

    const degraded = resolveDesignProviderFailure(
      plan,
      baseline,
      design.failure,
    );
    if (!degraded.ok) {
      throw new MaterialPreparationProviderError(degraded.error);
    }

    const degradationWarnings = degraded.value.warnings;
    const firstDegradationWarning = degradationWarnings[0];
    if (!firstDegradationWarning) {
      throw new MaterialPreparationCheckpointError(
        MATERIAL_DESIGN_STEP_KEY,
        "design degradation is missing its required user-visible warning",
      );
    }

    const combinedWarnings: [
      MaterialWarning,
      ...MaterialWarning[],
    ] = [
      firstDegradationWarning,
      ...copy.warnings,
      ...images.warnings,
      ...degradationWarnings.slice(1),
    ];

    return {
      pack: {
        ...degraded.value,
        warnings: combinedWarnings,
      },
      reusedSteps,
    };
  }

  async #resolveCopy(
    jobId: string,
    plan: ImageTextMaterialPlan,
    reusedSteps: string[],
  ): Promise<PersistedProviderEnvelope<TextMaterial>> {
    const steps = this.#jobs.getStepsForJob(jobId);
    for (const step of latestSucceededOutput(steps, MATERIAL_COPY_STEP_KEY)) {
      const persisted = parseProviderEnvelope(
        MATERIAL_COPY_STEP_KEY,
        step.outputJson!,
        plan.id,
        isTextMaterial,
      );
      if (persisted) {
        reusedSteps.push(MATERIAL_COPY_STEP_KEY);
        return persisted;
      }
    }

    const startedAt = this.#now().toISOString();
    const result = await this.#providers.text.generate(plan);
    if (!result.ok) {
      this.#recordProviderFailure(
        jobId,
        plan,
        MATERIAL_COPY_STEP_KEY,
        result.error,
        startedAt,
      );
      throw new MaterialPreparationProviderError(result.error);
    }
    if (!isTextMaterial(result.value) || !isWarningArray(result.warnings)) {
      const failure: MaterialProviderFailure = {
        slot: "text",
        code: "MATERIAL_GENERATION_FAILED",
        message: "TextProvider returned an invalid TextMaterial.",
        retryable: false,
      };
      this.#recordProviderFailure(
        jobId,
        plan,
        MATERIAL_COPY_STEP_KEY,
        failure,
        startedAt,
      );
      throw new MaterialPreparationProviderError(failure);
    }

    const persisted: PersistedProviderEnvelope<TextMaterial> = {
      version: 1,
      planId: plan.id,
      warnings: result.warnings,
      value: result.value,
    };
    this.#commitSuccess(
      jobId,
      plan,
      MATERIAL_COPY_STEP_KEY,
      persisted,
      startedAt,
    );
    return persisted;
  }

  async #resolveImages(
    jobId: string,
    plan: ImageTextMaterialPlan,
    reusedSteps: string[],
  ): Promise<PersistedProviderEnvelope<readonly ImageAssetReference[]>> {
    const steps = this.#jobs.getStepsForJob(jobId);
    for (const step of latestSucceededOutput(steps, MATERIAL_IMAGES_STEP_KEY)) {
      const persisted = parseProviderEnvelope(
        MATERIAL_IMAGES_STEP_KEY,
        step.outputJson!,
        plan.id,
        parseImageArray,
      );
      if (persisted) {
        await this.#assertDurableImages(
          MATERIAL_IMAGES_STEP_KEY,
          persisted.value,
          plan.imageCount,
        );
        reusedSteps.push(MATERIAL_IMAGES_STEP_KEY);
        return persisted;
      }
    }

    const startedAt = this.#now().toISOString();
    const result = await this.#providers.image.generate(plan);
    if (!result.ok) {
      this.#recordProviderFailure(
        jobId,
        plan,
        MATERIAL_IMAGES_STEP_KEY,
        result.error,
        startedAt,
      );
      throw new MaterialPreparationProviderError(result.error);
    }

    try {
      if (!isWarningArray(result.warnings)) {
        throw new MaterialPreparationCheckpointError(
          MATERIAL_IMAGES_STEP_KEY,
          "ImageProvider returned invalid warnings",
        );
      }
      await this.#assertDurableImages(
        MATERIAL_IMAGES_STEP_KEY,
        result.value,
        plan.imageCount,
      );
    } catch (error) {
      const failure: MaterialProviderFailure = {
        slot: "image",
        code: "MATERIAL_GENERATION_FAILED",
        message:
          error instanceof Error
            ? error.message
            : "ImageProvider returned invalid Publisher assets.",
        retryable: false,
      };
      this.#recordProviderFailure(
        jobId,
        plan,
        MATERIAL_IMAGES_STEP_KEY,
        failure,
        startedAt,
      );
      throw new MaterialPreparationProviderError(failure);
    }

    const persisted: PersistedProviderEnvelope<
      readonly ImageAssetReference[]
    > = {
      version: 1,
      planId: plan.id,
      warnings: result.warnings,
      value: result.value,
    };
    this.#commitSuccess(
      jobId,
      plan,
      MATERIAL_IMAGES_STEP_KEY,
      persisted,
      startedAt,
    );
    return persisted;
  }

  async #resolveDesign(
    jobId: string,
    plan: ImageTextMaterialPlan,
    baseline: {
      readonly copy: TextMaterial;
      readonly cover: ImageAssetReference;
      readonly images: readonly ImageAssetReference[];
    },
    reusedSteps: string[],
  ): Promise<PersistedDesignOutcome> {
    const steps = this.#jobs.getStepsForJob(jobId);
    for (const step of latestSucceededOutput(steps, MATERIAL_DESIGN_STEP_KEY)) {
      const persisted = parseDesignOutcome(step.outputJson!, plan.id);
      if (!persisted) continue;

      if (persisted.outcome === "rendered") {
        await this.#assertDurableDesign(plan, persisted.value);
      }
      reusedSteps.push(MATERIAL_DESIGN_STEP_KEY);
      return persisted;
    }

    const startedAt = this.#now().toISOString();
    const provider = this.#providers.design;
    const result: ProviderResult<DesignRenderResult> =
      provider === undefined
        ? {
            ok: false,
            error: {
              slot: "design",
              code: "MATERIAL_PROVIDER_UNAVAILABLE",
              message: "No DesignProvider is configured.",
              retryable: true,
            },
          }
        : await provider.render({
            plan,
            copy: baseline.copy,
            sourceImages: baseline.images,
          });

    if (result.ok) {
      try {
        if (!isWarningArray(result.warnings)) {
          throw new MaterialPreparationCheckpointError(
            MATERIAL_DESIGN_STEP_KEY,
            "DesignProvider returned invalid warnings",
          );
        }
        await this.#assertDurableDesign(plan, result.value);
      } catch (error) {
        const failure: MaterialProviderFailure = {
          slot: "design",
          code: "MATERIAL_GENERATION_FAILED",
          message:
            error instanceof Error
              ? error.message
              : "DesignProvider returned invalid Publisher assets.",
          retryable: false,
        };
        this.#recordProviderFailure(
          jobId,
          plan,
          MATERIAL_DESIGN_STEP_KEY,
          failure,
          startedAt,
        );
        throw new MaterialPreparationProviderError(failure);
      }

      const persisted: PersistedDesignOutcome = {
        version: 1,
        planId: plan.id,
        outcome: "rendered",
        warnings: result.warnings,
        value: result.value,
      };
      this.#commitSuccess(
        jobId,
        plan,
        MATERIAL_DESIGN_STEP_KEY,
        persisted,
        startedAt,
      );
      return persisted;
    }

    const resolution = resolveDesignProviderFailure(plan, baseline, result.error);
    if (!resolution.ok) {
      this.#recordProviderFailure(
        jobId,
        plan,
        MATERIAL_DESIGN_STEP_KEY,
        resolution.error,
        startedAt,
      );
      throw new MaterialPreparationProviderError(resolution.error);
    }

    const persisted: PersistedDesignOutcome = {
      version: 1,
      planId: plan.id,
      outcome: "degraded",
      failure: result.error,
    };
    this.#commitSuccess(
      jobId,
      plan,
      MATERIAL_DESIGN_STEP_KEY,
      persisted,
      startedAt,
    );
    return persisted;
  }

  async #assertDurableImages(
    stepKey: string,
    images: readonly ImageAssetReference[],
    expectedCount: number,
  ): Promise<void> {
    if (images.length !== expectedCount) {
      throw new MaterialPreparationCheckpointError(
        stepKey,
        `expected ${expectedCount} images, received ${images.length}`,
      );
    }

    for (const image of images) {
      if (!isImageAsset(image)) {
        throw new MaterialPreparationCheckpointError(
          stepKey,
          "contains a non-canonical image asset reference",
        );
      }
      await this.#assetStore.read(image.assetId);
    }
  }

  async #assertDurableDesign(
    plan: ImageTextMaterialPlan,
    value: DesignRenderResult,
  ): Promise<void> {
    if (!isDesignResult(value)) {
      throw new MaterialPreparationCheckpointError(
        MATERIAL_DESIGN_STEP_KEY,
        "DesignProvider output is not contract-valid",
      );
    }
    await this.#assetStore.read(value.cover.assetId);
    await this.#assertDurableImages(
      MATERIAL_DESIGN_STEP_KEY,
      value.images,
      plan.imageCount,
    );
    if (value.source !== null) {
      await this.#assetStore.read(value.source.assetId);
    }
  }

  #commitSuccess(
    jobId: string,
    plan: ImageTextMaterialPlan,
    stepKey: string,
    output: unknown,
    startedAt: string,
  ): Job {
    const steps = this.#jobs.getStepsForJob(jobId);
    const finishedAt = this.#now().toISOString();
    return this.#jobs.commitCheckpoint(jobId, {
      status: "preparing_materials",
      checkpoint: {
        phase: "material_step_ready",
        materialPlanId: plan.id,
        materialStep: stepKey,
      },
      step: {
        id: this.#createId(),
        stepKey,
        status: "succeeded",
        attempt: nextAttempt(steps, stepKey),
        outputJson: JSON.stringify(output),
        startedAt,
        finishedAt,
      },
    });
  }

  #recordProviderFailure(
    jobId: string,
    plan: ImageTextMaterialPlan,
    stepKey: string,
    failure: MaterialProviderFailure,
    startedAt: string,
  ): void {
    const steps = this.#jobs.getStepsForJob(jobId);
    const finishedAt = this.#now().toISOString();
    this.#jobs.commitCheckpoint(jobId, {
      status: "preparing_materials",
      checkpoint: {
        phase: "material_step_failed",
        materialPlanId: plan.id,
        materialStep: stepKey,
        retryable: failure.retryable,
      },
      step: {
        id: this.#createId(),
        stepKey,
        status: "failed",
        attempt: nextAttempt(steps, stepKey),
        errorCode: failure.code,
        errorMessage: failure.message,
        startedAt,
        finishedAt,
      },
    });
  }

  #assertJobState(jobId: string, plan: ImageTextMaterialPlan): void {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    if (
      job.status !== "preparing_materials" ||
      job.publishMode !== "image_text" ||
      plan.mode !== "image_text" ||
      plan.brief.mode !== "image_text" ||
      plan.brief.platform !== job.platform
    ) {
      throw new MaterialPreparationStateError(
        jobId,
        "Job and MaterialPlan must remain in the same image_text preparing_materials scope",
      );
    }
  }
}
