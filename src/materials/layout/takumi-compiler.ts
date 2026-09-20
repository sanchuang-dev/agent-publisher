import type {
  ContainerNode,
  ImageNode,
  Node as TakumiNode,
  TextNode,
} from "@takumi-rs/core";

import type {
  SafeLayoutBackground,
  SafeLayoutNode,
  SafeLayoutStyle,
  SafeRichLayout,
  SafeTextStyle,
} from "./safe-rich-layout.js";

export const builtinLayoutFontFamily = "Noto Sans SC";

export type SafeLayoutResources = Readonly<
  Record<string, Uint8Array | Buffer>
>;

export class SafeLayoutResourceError extends Error {
  constructor(readonly sourceId: string) {
    super(`SafeRichLayout resource is missing: ${sourceId}`);
    this.name = "SafeLayoutResourceError";
  }
}

type TakumiStyle = NonNullable<ContainerNode["style"]>;

function backgroundValue(
  background: SafeLayoutBackground | undefined,
): string | undefined {
  if (!background) {
    return undefined;
  }
  if (background.kind === "solid") {
    return background.color;
  }
  return `linear-gradient(${background.angle}deg, ${background.from}, ${background.to})`;
}

function alignValue(
  value: SafeLayoutStyle["align"],
): "flex-start" | "center" | "flex-end" | "stretch" | undefined {
  if (value === "start") {
    return "flex-start";
  }
  if (value === "end") {
    return "flex-end";
  }
  return value;
}

function justifyValue(
  value: SafeLayoutStyle["justify"],
): "flex-start" | "center" | "flex-end" | "space-between" | undefined {
  if (value === "start") {
    return "flex-start";
  }
  if (value === "end") {
    return "flex-end";
  }
  return value;
}

function boxStyle(style: SafeLayoutStyle | undefined): TakumiStyle {
  if (!style) {
    return {};
  }

  return {
    ...(style.background
      ? { background: backgroundValue(style.background) }
      : {}),
    ...(style.color ? { color: style.color } : {}),
    ...(style.padding !== undefined ? { padding: `${style.padding}px` } : {}),
    ...(style.gap !== undefined ? { gap: `${style.gap}px` } : {}),
    ...(style.borderRadius !== undefined
      ? { borderRadius: `${style.borderRadius}px` }
      : {}),
    ...(style.borderWidth !== undefined
      ? {
          borderWidth: `${style.borderWidth}px`,
          borderStyle: "solid",
        }
      : {}),
    ...(style.borderColor ? { borderColor: style.borderColor } : {}),
    ...(style.width !== undefined ? { width: `${style.width}px` } : {}),
    ...(style.height !== undefined ? { height: `${style.height}px` } : {}),
    ...(style.align ? { alignItems: alignValue(style.align) } : {}),
    ...(style.justify ? { justifyContent: justifyValue(style.justify) } : {}),
  } as TakumiStyle;
}

function textStyle(
  style: SafeTextStyle | undefined,
  defaults: {
    readonly fontSize: number;
    readonly fontWeight: 400 | 500 | 600 | 700 | 800;
    readonly lineHeight: number;
  },
): NonNullable<TextNode["style"]> {
  return {
    fontFamily: builtinLayoutFontFamily,
    fontSize: `${style?.fontSize ?? defaults.fontSize}px`,
    fontWeight: style?.fontWeight ?? defaults.fontWeight,
    lineHeight: style?.lineHeight ?? defaults.lineHeight,
    ...(style?.color ? { color: style.color } : {}),
    ...(style?.textAlign ? { textAlign: style.textAlign } : {}),
  } as NonNullable<TextNode["style"]>;
}

function compileChildren(
  children: readonly SafeLayoutNode[],
  resources: SafeLayoutResources,
): TakumiNode[] {
  return children.map((child) => compileNode(child, resources));
}

function compileNode(
  node: SafeLayoutNode,
  resources: SafeLayoutResources,
): TakumiNode {
  if (node.type === "stack") {
    return {
      type: "container",
      children: compileChildren(node.children, resources),
      style: {
        display: "flex",
        flexDirection: node.direction,
        boxSizing: "border-box",
        ...boxStyle(node.style),
      },
    } satisfies ContainerNode;
  }

  if (node.type === "grid") {
    return {
      type: "container",
      children: compileChildren(node.children, resources),
      style: {
        display: "grid",
        gridTemplateColumns: `repeat(${node.columns}, minmax(0, 1fr))`,
        boxSizing: "border-box",
        ...boxStyle(node.style),
      },
    } satisfies ContainerNode;
  }

  if (node.type === "card") {
    return {
      type: "container",
      children: compileChildren(node.children, resources),
      style: {
        display: "flex",
        flexDirection: "column",
        boxSizing: "border-box",
        overflow: "hidden",
        ...boxStyle(node.style),
      },
    } satisfies ContainerNode;
  }

  if (node.type === "heading") {
    const defaults =
      node.level === 1
        ? { fontSize: 72, fontWeight: 800 as const, lineHeight: 1.15 }
        : node.level === 2
          ? { fontSize: 54, fontWeight: 700 as const, lineHeight: 1.2 }
          : { fontSize: 40, fontWeight: 700 as const, lineHeight: 1.25 };

    return {
      type: "text",
      text: node.text,
      lang: "zh-CN",
      style: textStyle(node.style, defaults),
    } satisfies TextNode;
  }

  if (node.type === "text") {
    return {
      type: "text",
      text: node.text,
      lang: "zh-CN",
      style: textStyle(node.style, {
        fontSize: 32,
        fontWeight: 400,
        lineHeight: 1.5,
      }),
    } satisfies TextNode;
  }

  if (node.type === "badge") {
    return {
      type: "container",
      children: [
        {
          type: "text",
          text: node.text,
          lang: "zh-CN",
          style: textStyle(node.style, {
            fontSize: 24,
            fontWeight: 600,
            lineHeight: 1.2,
          }),
        } satisfies TextNode,
      ],
      style: {
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        alignSelf: "flex-start",
        boxSizing: "border-box",
        ...boxStyle(node.style),
      },
    } satisfies ContainerNode;
  }

  if (node.type === "quote") {
    return {
      type: "container",
      children: [
        {
          type: "text",
          text: node.text,
          lang: "zh-CN",
          style: textStyle(node.style, {
            fontSize: 32,
            fontWeight: 500,
            lineHeight: 1.5,
          }),
        } satisfies TextNode,
      ],
      style: {
        display: "flex",
        flexDirection: "column",
        borderLeftWidth: "6px",
        borderLeftStyle: "solid",
        borderLeftColor: node.style?.borderColor ?? "#5B5EF7",
        paddingLeft: "24px",
        boxSizing: "border-box",
        ...boxStyle(node.style),
      },
    } satisfies ContainerNode;
  }

  if (node.type === "image") {
    const bytes = resources[node.sourceId];
    if (!bytes) {
      throw new SafeLayoutResourceError(node.sourceId);
    }

    return {
      type: "image",
      src: bytes,
      width: node.width,
      height: node.height,
      style: {
        width: `${node.width}px`,
        height: `${node.height}px`,
        objectFit: node.fit ?? "cover",
        ...(node.borderRadius !== undefined
          ? { borderRadius: `${node.borderRadius}px` }
          : {}),
      },
    } satisfies ImageNode;
  }

  if (node.type === "divider") {
    return {
      type: "container",
      style: {
        display: "flex",
        width: "100%",
        height: `${node.thickness ?? 1}px`,
        backgroundColor: node.color ?? "#D9DCE5",
      },
    } satisfies ContainerNode;
  }

  return {
    type: "container",
    style: {
      display: "flex",
      width: "100%",
      height: `${node.size}px`,
      flexShrink: 0,
    },
  } satisfies ContainerNode;
}

export function compileSafeRichLayoutToTakumi(
  layout: SafeRichLayout,
  resources: SafeLayoutResources = {},
): TakumiNode {
  return {
    type: "container",
    children: compileChildren(layout.children, resources),
    lang: "zh-CN",
    style: {
      display: "flex",
      flexDirection: "column",
      width: "100%",
      height: "100%",
      boxSizing: "border-box",
      overflow: "hidden",
      background: backgroundValue(layout.background) ?? "#FFFFFF",
      fontFamily: builtinLayoutFontFamily,
    },
  } satisfies ContainerNode;
}
