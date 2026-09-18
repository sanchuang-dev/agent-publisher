import type {
  DesignAssetReference,
  MaterialPlan,
  ProviderResult,
} from "../contracts.js";

export interface DesignProvider {
  readonly slot: "design";
  render(
    plan: MaterialPlan,
  ): Promise<ProviderResult<readonly DesignAssetReference[]>>;
}
