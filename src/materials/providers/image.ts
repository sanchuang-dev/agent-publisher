import type {
  ImageAssetReference,
  MaterialPlan,
  ProviderResult,
} from "../contracts.js";

export interface ImageProvider {
  readonly slot: "image";
  generate(
    plan: MaterialPlan,
  ): Promise<ProviderResult<readonly ImageAssetReference[]>>;
}
