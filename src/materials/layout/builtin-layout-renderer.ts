import { Renderer } from "@takumi-rs/core";

import { loadBuiltinCjkFonts } from "./font.js";
import {
  compileSafeRichLayoutToTakumi,
  type SafeLayoutResources,
} from "./takumi-compiler.js";
import {
  validateSafeRichLayout,
  type SafeRichLayout,
} from "./safe-rich-layout.js";

export interface BuiltinLayoutRenderInput {
  readonly layout: unknown;
  readonly resources?: SafeLayoutResources;
}

export interface BuiltinLayoutRenderResult {
  readonly renderer: "takumi";
  readonly width: 1080;
  readonly height: 1440;
  readonly png: Buffer;
  readonly svg: string;
  readonly layout: SafeRichLayout;
}

/**
 * Production Builtin renderer for the MVP image-text baseline.
 *
 * It consumes Publisher-owned SafeRichLayout, compiles directly to Takumi's
 * node tree, passes controlled in-memory image bytes and bundled CJK fonts,
 * and never evaluates HTML/JS or asks the publishing browser to render.
 */
export class BuiltinLayoutRenderer {
  readonly #renderer: Renderer;

  constructor(renderer: Renderer = new Renderer()) {
    this.#renderer = renderer;
  }

  async render(
    input: BuiltinLayoutRenderInput,
  ): Promise<BuiltinLayoutRenderResult> {
    const layout = validateSafeRichLayout(input.layout);
    const node = compileSafeRichLayoutToTakumi(
      layout,
      input.resources ?? {},
    );
    const fonts = [...(await loadBuiltinCjkFonts())];
    const options = {
      width: layout.width,
      height: layout.height,
      fonts,
    } as const;

    const [png, svg] = await Promise.all([
      this.#renderer.render(node, {
        ...options,
        format: "png",
      }),
      this.#renderer.renderSvg(node, options),
    ]);

    return {
      renderer: "takumi",
      width: layout.width,
      height: layout.height,
      png,
      svg,
      layout,
    };
  }
}
