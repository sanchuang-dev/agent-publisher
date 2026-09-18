import type {
  ProviderResult,
  VideoAssetReference,
  VideoMaterialPlan,
} from "../contracts.js";

export interface VideoProvider {
  readonly slot: "video";
  generate(
    plan: VideoMaterialPlan,
  ): Promise<ProviderResult<VideoAssetReference>>;
}
