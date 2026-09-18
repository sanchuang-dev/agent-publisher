import type { PublishPlatform } from "../contracts/publish-job.js";

export const materialModes = ["image_text", "video"] as const;
export type MaterialMode = (typeof materialModes)[number];

interface CreativeBriefBase<TMode extends MaterialMode> {
  readonly id: string;
  readonly brief: string;
  readonly platform: PublishPlatform;
  readonly mode: TMode;
}

export type ImageTextCreativeBrief = CreativeBriefBase<"image_text">;
export type VideoCreativeBrief = CreativeBriefBase<"video">;
export type CreativeBrief = ImageTextCreativeBrief | VideoCreativeBrief;

export type DesignRequirement = "none" | "optional" | "required";
export type VideoDegradationPolicy = "fail" | "allow_without_video";

export interface ImageTextMaterialPlan {
  readonly id: string;
  readonly mode: "image_text";
  readonly brief: ImageTextCreativeBrief;
  readonly imageCount: number;
  readonly coverRequired: true;
  readonly design: DesignRequirement;
}

export interface VideoMaterialPlan {
  readonly id: string;
  readonly mode: "video";
  readonly brief: VideoCreativeBrief;
  readonly coverRequired: true;
  readonly supportingImageCount: number;
  readonly onVideoUnavailable: VideoDegradationPolicy;
}

export type MaterialPlan = ImageTextMaterialPlan | VideoMaterialPlan;

interface AssetReferenceBase {
  readonly assetId: string;
  readonly uri: string;
  readonly mimeType: string;
}

export interface ImageAssetReference extends AssetReferenceBase {
  readonly kind: "image";
  readonly width: number;
  readonly height: number;
}

export interface VideoAssetReference extends AssetReferenceBase {
  readonly kind: "video";
  readonly durationMs: number;
}

export interface DesignAssetReference extends AssetReferenceBase {
  readonly kind: "design";
}

export type MediaReference = ImageAssetReference | VideoAssetReference;
export type AssetReference =
  | ImageAssetReference
  | VideoAssetReference
  | DesignAssetReference;

export interface TextMaterial {
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
}

export type MaterialWarningCode =
  | "VIDEO_PROVIDER_UNAVAILABLE"
  | "DESIGN_PROVIDER_UNAVAILABLE"
  | "PROVIDER_WARNING";

export interface MaterialWarning {
  readonly code: MaterialWarningCode;
  readonly message: string;
  readonly reason: string;
  readonly userVisible: true;
}

export type MaterialDegradationCode =
  | "VIDEO_PROVIDER_UNAVAILABLE"
  | "DESIGN_PROVIDER_UNAVAILABLE";

export interface MaterialDegradation<TMode extends MaterialMode = MaterialMode> {
  readonly code: MaterialDegradationCode;
  readonly slot: "video" | "design";
  readonly originalMode: TMode;
  readonly resultingMode: TMode;
  readonly reason: string;
  readonly warning: MaterialWarning;
}

interface MaterialPackBase<TMode extends MaterialMode> {
  readonly mode: TMode;
  readonly planId: string;
  readonly copy: TextMaterial;
  readonly cover: ImageAssetReference;
  readonly images: readonly ImageAssetReference[];
}

interface ReadyMaterialPackMetadata {
  readonly status: "ready";
  readonly warnings: readonly MaterialWarning[];
  readonly degradations: readonly [];
}

interface DegradedMaterialPackMetadata {
  readonly status: "ready_with_degradation";
  readonly warnings: readonly [MaterialWarning, ...MaterialWarning[]];
  readonly degradations: readonly [
    MaterialDegradation,
    ...MaterialDegradation[],
  ];
}

type MaterialPackMetadata =
  | ReadyMaterialPackMetadata
  | DegradedMaterialPackMetadata;

type ImageTextMaterialPackContent = MaterialPackBase<"image_text"> & {
  readonly design: DesignAssetReference | null;
  readonly video?: never;
};

export type ImageTextMaterialPack =
  ImageTextMaterialPackContent & MaterialPackMetadata;

interface VideoMaterialPackBase extends MaterialPackBase<"video"> {
  readonly design: DesignAssetReference | null;
}

export type ReadyVideoMaterialPack = VideoMaterialPackBase &
  ReadyMaterialPackMetadata & {
    readonly video: VideoAssetReference;
  };

export type DegradedVideoMaterialPack = VideoMaterialPackBase &
  DegradedMaterialPackMetadata & {
    readonly video: null;
  };

export type VideoMaterialPack =
  | ReadyVideoMaterialPack
  | DegradedVideoMaterialPack;
export type MaterialPack = ImageTextMaterialPack | VideoMaterialPack;

export type MaterialProviderSlot = "text" | "image" | "design" | "video";

export type MaterialProviderErrorCode =
  | "MATERIAL_PROVIDER_UNAVAILABLE"
  | "MATERIAL_GENERATION_FAILED"
  | "MATERIAL_INVALID_REQUEST"
  | "MATERIAL_UNSUPPORTED_CAPABILITY";

export interface MaterialProviderFailure {
  readonly code: MaterialProviderErrorCode;
  readonly slot: MaterialProviderSlot;
  readonly message: string;
  readonly retryable: boolean;
}

export type ProviderResult<T> =
  | {
      readonly ok: true;
      readonly value: T;
      readonly warnings: readonly MaterialWarning[];
    }
  | {
      readonly ok: false;
      readonly error: MaterialProviderFailure;
    };
