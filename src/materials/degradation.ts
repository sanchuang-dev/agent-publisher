import type {
  DegradedVideoMaterialPack,
  ImageAssetReference,
  ImageTextMaterialPack,
  ImageTextMaterialPlan,
  MaterialProviderFailure,
  MaterialWarning,
  TextMaterial,
  VideoMaterialPlan,
} from "./contracts.js";

interface BaselineMaterialAssets {
  readonly copy: TextMaterial;
  readonly cover: ImageAssetReference;
  readonly images: readonly ImageAssetReference[];
}

export type VideoProviderFailureResolution =
  | {
      readonly ok: true;
      readonly value: DegradedVideoMaterialPack;
    }
  | {
      readonly ok: false;
      readonly error: MaterialProviderFailure;
    };

export function resolveVideoProviderFailure(
  plan: VideoMaterialPlan,
  baseline: BaselineMaterialAssets,
  failure: MaterialProviderFailure,
): VideoProviderFailureResolution {
  if (
    failure.slot !== "video" ||
    failure.code !== "MATERIAL_PROVIDER_UNAVAILABLE" ||
    plan.onVideoUnavailable === "fail"
  ) {
    return { ok: false, error: failure };
  }

  const warning: MaterialWarning = {
    code: "VIDEO_PROVIDER_UNAVAILABLE",
    message:
      "视频生成当前不可用；任务仍保持为视频模式，需要人工确认后再继续。",
    reason: failure.message,
    userVisible: true,
  };

  const degradation = {
    code: "VIDEO_PROVIDER_UNAVAILABLE",
    slot: "video",
    originalMode: "video",
    resultingMode: "video",
    reason: failure.message,
    warning,
  } as const;

  return {
    ok: true,
    value: {
      mode: "video",
      status: "ready_with_degradation",
      planId: plan.id,
      copy: baseline.copy,
      cover: baseline.cover,
      images: baseline.images,
      design: null,
      video: null,
      warnings: [warning],
      degradations: [degradation],
    },
  };
}

export type DesignProviderFailureResolution =
  | {
      readonly ok: true;
      readonly value: ImageTextMaterialPack;
    }
  | {
      readonly ok: false;
      readonly error: MaterialProviderFailure;
    };

export function resolveDesignProviderFailure(
  plan: ImageTextMaterialPlan,
  baseline: BaselineMaterialAssets,
  failure: MaterialProviderFailure,
): DesignProviderFailureResolution {
  if (
    failure.slot !== "design" ||
    failure.code !== "MATERIAL_PROVIDER_UNAVAILABLE" ||
    plan.design !== "optional"
  ) {
    return { ok: false, error: failure };
  }

  const warning: MaterialWarning = {
    code: "DESIGN_PROVIDER_UNAVAILABLE",
    message:
      "设计增强当前不可用；已保留基础图文素材，需要人工确认后再继续。",
    reason: failure.message,
    userVisible: true,
  };

  const degradation = {
    code: "DESIGN_PROVIDER_UNAVAILABLE",
    slot: "design",
    originalMode: "image_text",
    resultingMode: "image_text",
    reason: failure.message,
    warning,
  } as const;

  return {
    ok: true,
    value: {
      mode: "image_text",
      status: "ready_with_degradation",
      planId: plan.id,
      copy: baseline.copy,
      cover: baseline.cover,
      images: baseline.images,
      design: null,
      warnings: [warning],
      degradations: [degradation],
    },
  };
}
