import type { PublishPlatform } from "../contracts/publish-job.js";
import type {
  DesignRequirement,
  MaterialMode,
  MaterialPlan,
  VideoDegradationPolicy,
} from "./contracts.js";

export type MaterialPlanValidationErrorCode =
  | "MATERIAL_PLAN_INVALID_JSON"
  | "MATERIAL_PLAN_INVALID_SHAPE"
  | "MATERIAL_PLAN_MODE_MISMATCH"
  | "MATERIAL_PLAN_PLATFORM_MISMATCH";

export class MaterialPlanValidationError extends Error {
  constructor(
    readonly code: MaterialPlanValidationErrorCode,
    message: string,
    options?: { readonly cause?: unknown },
  ) {
    super(message, options);
    this.name = "MaterialPlanValidationError";
  }
}

interface MaterialPlanExpectation {
  readonly mode: MaterialMode;
  readonly platform: PublishPlatform;
}

type JsonObject = Record<string, unknown>;

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalidShape(message: string): never {
  throw new MaterialPlanValidationError(
    "MATERIAL_PLAN_INVALID_SHAPE",
    message,
  );
}

function requireObject(value: unknown, label: string): JsonObject {
  if (!isObject(value)) {
    return invalidShape(`${label} must be an object`);
  }
  return value;
}

function requireString(value: unknown, label: string): string {
  if (typeof value !== "string") {
    return invalidShape(`${label} must be a string`);
  }
  return value;
}

function requireInteger(
  value: unknown,
  label: string,
  minimum: number,
): number {
  if (!Number.isInteger(value) || (value as number) < minimum) {
    return invalidShape(
      `${label} must be an integer greater than or equal to ${minimum}`,
    );
  }
  return value as number;
}

function assertExpectedMode(
  value: unknown,
  expected: MaterialMode,
  label: string,
): void {
  if (value !== expected) {
    throw new MaterialPlanValidationError(
      "MATERIAL_PLAN_MODE_MISMATCH",
      `${label} must remain ${expected}; received ${String(value)}`,
    );
  }
}

function assertExpectedPlatform(
  value: unknown,
  expected: PublishPlatform,
): void {
  if (value !== expected) {
    throw new MaterialPlanValidationError(
      "MATERIAL_PLAN_PLATFORM_MISMATCH",
      `MaterialPlan brief.platform must remain ${expected}; received ${String(value)}`,
    );
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch (cause) {
    throw new MaterialPlanValidationError(
      "MATERIAL_PLAN_INVALID_JSON",
      "Content Secretary must return one JSON MaterialPlan object without markdown or surrounding text",
      { cause },
    );
  }
}

/**
 * Runtime boundary between model text and the Publisher-owned MaterialPlan
 * contract. Unknown model fields are deliberately discarded instead of being
 * persisted as an accidental extension of the product contract.
 */
export function parseMaterialPlanOutput(
  text: string,
  expected: MaterialPlanExpectation,
): MaterialPlan {
  const raw = requireObject(parseJson(text.trim()), "MaterialPlan");
  assertExpectedMode(raw.mode, expected.mode, "MaterialPlan.mode");

  const rawBrief = requireObject(raw.brief, "MaterialPlan.brief");
  assertExpectedMode(
    rawBrief.mode,
    expected.mode,
    "MaterialPlan.brief.mode",
  );
  assertExpectedPlatform(rawBrief.platform, expected.platform);

  const id = requireString(raw.id, "MaterialPlan.id");
  const briefId = requireString(rawBrief.id, "MaterialPlan.brief.id");
  const briefText = requireString(
    rawBrief.brief,
    "MaterialPlan.brief.brief",
  );

  if (raw.coverRequired !== true) {
    return invalidShape("MaterialPlan.coverRequired must be true");
  }

  if (expected.mode === "image_text") {
    const design = raw.design;
    if (
      design !== "none" &&
      design !== "optional" &&
      design !== "required"
    ) {
      return invalidShape(
        "Image-text MaterialPlan.design must be none, optional, or required",
      );
    }

    return {
      id,
      mode: "image_text",
      brief: {
        id: briefId,
        brief: briefText,
        platform: expected.platform,
        mode: "image_text",
      },
      imageCount: requireInteger(
        raw.imageCount,
        "Image-text MaterialPlan.imageCount",
        1,
      ),
      coverRequired: true,
      design: design as DesignRequirement,
    };
  }

  const onVideoUnavailable = raw.onVideoUnavailable;
  if (
    onVideoUnavailable !== "fail" &&
    onVideoUnavailable !== "allow_without_video"
  ) {
    return invalidShape(
      "Video MaterialPlan.onVideoUnavailable must be fail or allow_without_video",
    );
  }

  return {
    id,
    mode: "video",
    brief: {
      id: briefId,
      brief: briefText,
      platform: expected.platform,
      mode: "video",
    },
    coverRequired: true,
    supportingImageCount: requireInteger(
      raw.supportingImageCount,
      "Video MaterialPlan.supportingImageCount",
      0,
    ),
    onVideoUnavailable: onVideoUnavailable as VideoDegradationPolicy,
  };
}
