import type {
  JobStep,
} from "../contracts/job.js";
import type {
  DesignAssetReference,
  ImageAssetReference,
  ImageTextMaterialPack,
  MaterialDegradation,
  MaterialWarning,
} from "../materials/contracts.js";

export const CONTROLLED_SMOKE_MATERIAL_SOURCE = "controlled_smoke" as const;
export const PROVIDER_PIPELINE_MATERIAL_SOURCE = "provider_pipeline" as const;
export const PREPUBLISH_MATERIAL_STEP_KEY = "material_pack" as const;

export type PrepublishMaterialSourceKind =
  | typeof CONTROLLED_SMOKE_MATERIAL_SOURCE
  | typeof PROVIDER_PIPELINE_MATERIAL_SOURCE;

export interface PrepublishMaterialSourceInput {
  readonly jobId: string;
  readonly brief: string;
}

export interface PrepublishMaterialResolution {
  readonly source: PrepublishMaterialSourceKind;
  readonly generatedFromBrief: boolean;
  readonly pack: ImageTextMaterialPack;
}

export interface PrepublishMaterialSource {
  resolve(
    input: PrepublishMaterialSourceInput,
  ): Promise<PrepublishMaterialResolution>;
}

export type ControlledMaterialFactory = (
  input: PrepublishMaterialSourceInput,
) => ImageTextMaterialPack | Promise<ImageTextMaterialPack>;

export function createControlledMaterialSource(
  factory: ControlledMaterialFactory,
): PrepublishMaterialSource {
  return {
    async resolve(input) {
      return {
        source: CONTROLLED_SMOKE_MATERIAL_SOURCE,
        generatedFromBrief: false,
        pack: await factory(input),
      };
    },
  };
}

export interface PersistedPrepublishMaterial {
  readonly version: 1;
  readonly source: PrepublishMaterialSourceKind;
  readonly generatedFromBrief: boolean;
  readonly pack: ImageTextMaterialPack;
}

export class InvalidPersistedMaterialError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "InvalidPersistedMaterialError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
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
    value.uri.length > 0 &&
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

function isDegradation(value: unknown): value is MaterialDegradation {
  return (
    isRecord(value) &&
    (value.code === "VIDEO_PROVIDER_UNAVAILABLE" ||
      value.code === "DESIGN_PROVIDER_UNAVAILABLE") &&
    (value.slot === "video" || value.slot === "design") &&
    (value.originalMode === "image_text" || value.originalMode === "video") &&
    (value.resultingMode === "image_text" || value.resultingMode === "video") &&
    typeof value.reason === "string" &&
    isWarning(value.warning)
  );
}

function isImageTextPack(value: unknown): value is ImageTextMaterialPack {
  if (!isRecord(value) || value.mode !== "image_text") {
    return false;
  }

  if (
    (value.status !== "ready" && value.status !== "ready_with_degradation") ||
    typeof value.planId !== "string" ||
    value.planId.length === 0 ||
    !isRecord(value.copy) ||
    typeof value.copy.title !== "string" ||
    typeof value.copy.body !== "string" ||
    !isStringArray(value.copy.tags) ||
    !isImageAsset(value.cover) ||
    !Array.isArray(value.images) ||
    !value.images.every(isImageAsset) ||
    !Array.isArray(value.warnings) ||
    !value.warnings.every(isWarning) ||
    !Array.isArray(value.degradations) ||
    !value.degradations.every(isDegradation) ||
    !(value.design === null || isDesignAsset(value.design))
  ) {
    return false;
  }

  if (value.status === "ready" && value.degradations.length !== 0) {
    return false;
  }

  if (
    value.status === "ready_with_degradation" &&
    (value.warnings.length === 0 || value.degradations.length === 0)
  ) {
    return false;
  }

  return true;
}

export function serializePrepublishMaterial(
  resolution: PrepublishMaterialResolution,
): string {
  const persisted: PersistedPrepublishMaterial = {
    version: 1,
    source: resolution.source,
    generatedFromBrief: resolution.generatedFromBrief,
    pack: resolution.pack,
  };

  return JSON.stringify(persisted);
}

export function parsePrepublishMaterial(
  serialized: string | null,
): PersistedPrepublishMaterial {
  if (!serialized) {
    throw new InvalidPersistedMaterialError(
      "Job has no persisted pre-publish material.",
    );
  }

  let value: unknown;
  try {
    value = JSON.parse(serialized);
  } catch (error) {
    throw new InvalidPersistedMaterialError(
      "Persisted pre-publish material is not valid JSON.",
      { cause: error },
    );
  }

  if (
    !isRecord(value) ||
    value.version !== 1 ||
    (value.source !== CONTROLLED_SMOKE_MATERIAL_SOURCE &&
      value.source !== PROVIDER_PIPELINE_MATERIAL_SOURCE) ||
    typeof value.generatedFromBrief !== "boolean" ||
    (value.source === CONTROLLED_SMOKE_MATERIAL_SOURCE &&
      value.generatedFromBrief !== false) ||
    !isImageTextPack(value.pack)
  ) {
    throw new InvalidPersistedMaterialError(
      "Persisted pre-publish material does not match the supported image-text material contract.",
    );
  }

  return value as unknown as PersistedPrepublishMaterial;
}

/**
 * MaterialPack is durable Publisher execution data, not model-facing
 * material_summary_json. Keep it in the append-only JobStep history so restart
 * can recover it without widening the Pi Job Context whitelist.
 */
export function findPersistedPrepublishMaterial(
  steps: readonly JobStep[],
): PersistedPrepublishMaterial | null {
  for (const step of [...steps].reverse()) {
    if (
      step.stepKey !== PREPUBLISH_MATERIAL_STEP_KEY ||
      step.status !== "succeeded" ||
      step.outputJson === null
    ) {
      continue;
    }

    return parsePrepublishMaterial(step.outputJson);
  }

  return null;
}
