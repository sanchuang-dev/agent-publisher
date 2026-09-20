import type {
  DesignRenderInput,
  DesignRenderResult,
  ProviderResult,
} from "../contracts.js";

export interface DesignProvider {
  readonly slot: "design";
  render(
    input: DesignRenderInput,
  ): Promise<ProviderResult<DesignRenderResult>>;
}
