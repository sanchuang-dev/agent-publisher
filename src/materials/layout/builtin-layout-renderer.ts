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

export class SafeLayoutOverflowError extends Error {
  constructor(
    readonly measuredWidth: number,
    readonly measuredHeight: number,
    readonly maxWidth: number,
    readonly maxHeight: number,
  ) {
    super(
      `SafeRichLayout content exceeds canvas: measured ${measuredWidth}x${measuredHeight}, canvas ${maxWidth}x${maxHeight}`,
    );
    this.name = "SafeLayoutOverflowError";
  }
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
  readonly #fontsReady: Promise<void>;

  constructor(renderer: Renderer = new Renderer()) {
    this.#renderer = renderer;
    this.#fontsReady = loadBuiltinCjkFonts().then(async (fonts) => {
      for (const font of fonts) {
        await this.#renderer.registerFont(font);
      }
    });
  }

  async render(
    input: BuiltinLayoutRenderInput,
  ): Promise<BuiltinLayoutRenderResult> {
    const layout = validateSafeRichLayout(input.layout);
    const node = compileSafeRichLayoutToTakumi(
      layout,
      input.resources ?? {},
    );

    await this.#fontsReady;

    const {
      height: _fixedHeight,
      overflow: _fixedOverflow,
      ...measureStyle
    } = node.style ?? {};

    const measured = await this.#renderer.measure(
      {
        ...node,
        style: measureStyle,
      },
      {
        width: layout.width,
      },
    );

    if (
      measured.width > layout.width + 0.5 ||
      measured.height > layout.height + 0.5
    ) {
      throw new SafeLayoutOverflowError(
        measured.width,
        measured.height,
        layout.width,
        layout.height,
      );
    }

    const options = {
      width: layout.width,
      height: layout.height,
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
