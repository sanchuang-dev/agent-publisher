import { Renderer, type Node } from "@takumi-rs/core";

import {
  BUILTIN_CJK_FONT_FAMILY,
  loadBuiltinCjkFonts,
} from "./fonts.js";
import {
  SAFE_LAYOUT_HEIGHT,
  SAFE_LAYOUT_WIDTH,
  validateSafeImageResources,
  type SafeBoxStyle,
  type SafeImageResources,
  type SafeLayoutNode,
  type SafeRichLayout,
} from "./safe-layout.js";

export interface RenderedLayoutImage {
  readonly bytes: Buffer;
  readonly width: typeof SAFE_LAYOUT_WIDTH;
  readonly height: typeof SAFE_LAYOUT_HEIGHT;
  readonly mimeType: "image/png";
  readonly engine: "takumi";
}

export interface BuiltinLayoutRenderer {
  render(
    layout: SafeRichLayout,
    resources?: SafeImageResources,
  ): Promise<RenderedLayoutImage>;
  renderSvg(
    layout: SafeRichLayout,
    resources?: SafeImageResources,
  ): Promise<string>;
}

function boxStyle(node: SafeBoxStyle): Record<string, string | number> {
  const style: Record<string, string | number> = {};

  if (node.padding !== undefined) style.padding = node.padding;
  if (node.gap !== undefined) style.gap = node.gap;
  if (node.background !== undefined) {
    if (typeof node.background === "string") {
      style.backgroundColor = node.background;
    } else {
      style.backgroundImage = `linear-gradient(${node.background.angle}deg, ${node.background.from}, ${node.background.to})`;
    }
  }
  if (node.borderColor !== undefined) style.borderColor = node.borderColor;
  if (node.borderWidth !== undefined) {
    style.borderWidth = node.borderWidth;
    style.borderStyle = "solid";
  }
  if (node.radius !== undefined) style.borderRadius = node.radius;

  return style;
}

function textStyle(node: {
  readonly color?: string;
  readonly align?: "left" | "center" | "right";
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly maxLines?: number;
  readonly weight?: number;
}): Record<string, string | number> {
  return {
    fontFamily: BUILTIN_CJK_FONT_FAMILY,
    color: node.color ?? "#111111",
    textAlign: node.align ?? "left",
    fontSize: node.fontSize ?? 32,
    lineHeight: node.lineHeight ?? 1.45,
    fontWeight: node.weight ?? 400,
    overflowWrap: "break-word",
    wordBreak: "break-word",
    ...(node.maxLines === undefined ? {} : { lineClamp: node.maxLines }),
  };
}

function compileNode(
  node: SafeLayoutNode,
  resources: SafeImageResources,
): Node {
  switch (node.type) {
    case "stack":
      return {
        type: "container",
        style: {
          display: "flex",
          flexDirection: node.direction,
          alignItems: node.align ?? "stretch",
          justifyContent: node.justify ?? "start",
          ...boxStyle(node),
        },
        children: node.children.map((child) => compileNode(child, resources)),
      };
    case "grid":
      return {
        type: "container",
        style: {
          display: "grid",
          gridTemplateColumns: `repeat(${node.columns}, minmax(0, 1fr))`,
          ...boxStyle(node),
        },
        children: node.children.map((child) => compileNode(child, resources)),
      };
    case "heading":
      return {
        type: "text",
        lang: "zh-CN",
        text: node.text,
        style: {
          ...textStyle({
            ...node,
            fontSize:
              node.fontSize ??
              (node.level === 1 ? 72 : node.level === 2 ? 54 : 42),
            weight: node.weight ?? (node.level === 1 ? 800 : 700),
          }),
        },
      };
    case "text":
      return {
        type: "text",
        lang: "zh-CN",
        text: node.text,
        style: textStyle(node),
      };
    case "image":
      return {
        type: "image",
        src: resources[node.resourceId]!,
        width: node.width,
        height: node.height,
        style: {
          width: node.width,
          height: node.height,
          objectFit: node.fit ?? "cover",
          borderRadius: node.radius ?? 0,
        },
      };
    case "badge":
      return {
        type: "container",
        style: {
          display: "flex",
          alignItems: "center",
          alignSelf: "flex-start",
          padding: "10px 18px",
          borderRadius: 999,
          backgroundColor: node.background ?? "#EEEFF3",
        },
        children: [
          {
            type: "text",
            lang: "zh-CN",
            text: node.text,
            style: {
              fontFamily: BUILTIN_CJK_FONT_FAMILY,
              fontSize: 24,
              lineHeight: 1.2,
              fontWeight: 600,
              color: node.color ?? "#24262B",
            },
          },
        ],
      };
    case "quote":
      return {
        type: "container",
        style: {
          display: "flex",
          flexDirection: "column",
          borderLeft: "8px solid #6B6EF9",
          ...boxStyle({
            padding: node.padding ?? 28,
            gap: node.gap ?? 16,
            background: node.background ?? "#F7F7FC",
            radius: node.radius ?? 20,
            ...(node.borderColor === undefined
              ? {}
              : { borderColor: node.borderColor }),
            ...(node.borderWidth === undefined
              ? {}
              : { borderWidth: node.borderWidth }),
          }),
        },
        children: [
          {
            type: "text",
            lang: "zh-CN",
            text: node.text,
            style: {
              ...textStyle({
                ...node,
                fontSize: node.fontSize ?? 34,
                weight: 500,
              }),
            },
          },
          ...(node.attribution
            ? [
                {
                  type: "text" as const,
                  lang: "zh-CN",
                  text: `— ${node.attribution}`,
                  style: {
                    fontFamily: BUILTIN_CJK_FONT_FAMILY,
                    fontSize: 24,
                    lineHeight: 1.3,
                    fontWeight: 400,
                    color: "#666A73",
                  },
                },
              ]
            : []),
        ],
      };
    case "card":
      return {
        type: "container",
        style: {
          display: "flex",
          flexDirection: "column",
          ...boxStyle({
            padding: node.padding ?? 28,
            gap: node.gap ?? 20,
            background: node.background ?? "#FFFFFF",
            borderColor: node.borderColor ?? "#E5E7EB",
            borderWidth: node.borderWidth ?? 1,
            radius: node.radius ?? 24,
          }),
        },
        children: node.children.map((child) => compileNode(child, resources)),
      };
    case "divider":
      return {
        type: "container",
        style: {
          width: "100%",
          height: node.thickness ?? 1,
          backgroundColor: node.color ?? "#E5E7EB",
        },
      };
    case "spacer":
      return {
        type: "container",
        style: {
          width: "100%",
          height: node.size,
          flexShrink: 0,
        },
      };
  }
}

function compilePage(
  layout: SafeRichLayout,
  resources: SafeImageResources,
): Node {
  return {
    type: "container",
    lang: "zh-CN",
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      overflow: "hidden",
      boxSizing: "border-box",
      ...boxStyle(layout.page),
    },
    children: layout.page.children.map((child) =>
      compileNode(child, resources),
    ),
  };
}

class TakumiBuiltinLayoutRenderer implements BuiltinLayoutRenderer {
  #rendererPromise: Promise<Renderer> | null = null;

  async render(
    layout: SafeRichLayout,
    resources: SafeImageResources = {},
  ): Promise<RenderedLayoutImage> {
    validateSafeImageResources(layout, resources);
    const renderer = await this.#renderer();
    const bytes = await renderer.render(compilePage(layout, resources), {
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
      format: "png",
    });

    return {
      bytes,
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
      mimeType: "image/png",
      engine: "takumi",
    };
  }

  async renderSvg(
    layout: SafeRichLayout,
    resources: SafeImageResources = {},
  ): Promise<string> {
    validateSafeImageResources(layout, resources);
    const renderer = await this.#renderer();
    return renderer.renderSvg(compilePage(layout, resources), {
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
    });
  }

  async #renderer(): Promise<Renderer> {
    if (this.#rendererPromise === null) {
      this.#rendererPromise = this.#createRenderer();
    }
    return this.#rendererPromise;
  }

  async #createRenderer(): Promise<Renderer> {
    const renderer = new Renderer();
    const fonts = await loadBuiltinCjkFonts();

    for (const font of fonts) {
      await renderer.registerFont({
        data: font.data,
        name: font.name,
        weight: font.weight,
      });
    }

    return renderer;
  }
}

export function createBuiltinLayoutRenderer(): BuiltinLayoutRenderer {
  return new TakumiBuiltinLayoutRenderer();
}
