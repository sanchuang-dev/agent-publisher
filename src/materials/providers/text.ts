import type {
  MaterialPlan,
  ProviderResult,
  TextMaterial,
} from "../contracts.js";

export interface TextProvider {
  readonly slot: "text";
  generate(plan: MaterialPlan): Promise<ProviderResult<TextMaterial>>;
}
