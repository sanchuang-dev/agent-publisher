export const safeRichLayoutVersion = 1 as const;
export const safeRichLayoutCanvas = {
  width: 1080,
  height: 1440,
} as const;

export const safeRichLayoutLimits = {
  maxNodes: 120,
  maxDepth: 10,
  maxChildrenPerContainer: 32,
  maxTotalTextCharacters: 6000,
  maxResourceIdLength: 120,
} as const;

export type SafeLayoutAlignment = "start" | "center" | "end" | "stretch";
export type SafeLayoutJustification =
  | "start"
  | "center"
  | "end"
  | "space-between";
export type SafeTextAlignment = "left" | "center" | "right";
export type SafeImageFit = "cover" | "contain";

export type SafeLayoutBackground =
  | {
      readonly kind: "solid";
      readonly color: string;
    }
  | {
      readonly kind: "linear-gradient";
      readonly angle: number;
      readonly from: string;
      readonly to: string;
    };

export interface SafeLayoutStyle {
  readonly background?: SafeLayoutBackground;
  readonly color?: string;
  readonly padding?: number;
  readonly gap?: number;
  readonly borderRadius?: number;
  readonly borderWidth?: number;
  readonly borderColor?: string;
  readonly width?: number;
  readonly height?: number;
  readonly align?: SafeLayoutAlignment;
  readonly justify?: SafeLayoutJustification;
}

export interface SafeTextStyle {
  readonly color?: string;
  readonly fontSize?: number;
  readonly fontWeight?: 400 | 500 | 600 | 700 | 800;
  readonly lineHeight?: number;
  readonly textAlign?: SafeTextAlignment;
}

export interface SafePageNode {
  readonly type: "page";
  readonly width: 1080;
  readonly height: 1440;
  readonly background?: SafeLayoutBackground;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeStackNode {
  readonly type: "stack";
  readonly direction: "row" | "column";
  readonly style?: SafeLayoutStyle;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeGridNode {
  readonly type: "grid";
  readonly columns: 1 | 2 | 3 | 4;
  readonly style?: SafeLayoutStyle;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeCardNode {
  readonly type: "card";
  readonly style?: SafeLayoutStyle;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeHeadingNode {
  readonly type: "heading";
  readonly text: string;
  readonly level: 1 | 2 | 3;
  readonly style?: SafeTextStyle;
}

export interface SafeTextNode {
  readonly type: "text";
  readonly text: string;
  readonly style?: SafeTextStyle;
}

export interface SafeBadgeNode {
  readonly type: "badge";
  readonly text: string;
  readonly style?: SafeLayoutStyle & SafeTextStyle;
}

export interface SafeQuoteNode {
  readonly type: "quote";
  readonly text: string;
  readonly style?: SafeLayoutStyle & SafeTextStyle;
}

export interface SafeImageNode {
  readonly type: "image";
  readonly sourceId: string;
  readonly width: number;
  readonly height: number;
  readonly fit?: SafeImageFit;
  readonly borderRadius?: number;
}

export interface SafeDividerNode {
  readonly type: "divider";
  readonly color?: string;
  readonly thickness?: number;
}

export interface SafeSpacerNode {
  readonly type: "spacer";
  readonly size: number;
}

export type SafeLayoutNode =
  | SafeStackNode
  | SafeGridNode
  | SafeCardNode
  | SafeHeadingNode
  | SafeTextNode
  | SafeBadgeNode
  | SafeQuoteNode
  | SafeImageNode
  | SafeDividerNode
  | SafeSpacerNode;

export type SafeRichLayout = SafePageNode;

export class SafeRichLayoutValidationError extends Error {
  constructor(
    readonly path: string,
    message: string,
  ) {
    super(`Invalid SafeRichLayout at ${path}: ${message}`);
    this.name = "SafeRichLayoutValidationError";
  }
}

interface ValidationState {
  nodes: number;
  textCharacters: number;
}

const colorPattern = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]*$/;

function fail(path: string, message: string): never {
  throw new SafeRichLayoutValidationError(path, message);
}

function expectRecord(value: unknown, path: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    fail(path, "must be an object");
  }
  return value as Record<string, unknown>;
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  allowed: readonly string[],
  path: string,
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(`${path}.${key}`, "is not allowed");
    }
  }
}

function readString(
  value: unknown,
  path: string,
  options: { readonly min?: number; readonly max: number },
): string {
  if (typeof value !== "string") {
    fail(path, "must be a string");
  }
  const min = options.min ?? 1;
  if (value.length < min || value.length > options.max) {
    fail(path, `must contain ${min}-${options.max} characters`);
  }
  return value;
}

function readNumber(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    value < min ||
    value > max
  ) {
    fail(path, `must be a finite number between ${min} and ${max}`);
  }
  return value;
}

function readInteger(
  value: unknown,
  path: string,
  min: number,
  max: number,
): number {
  const number = readNumber(value, path, min, max);
  if (!Number.isInteger(number)) {
    fail(path, "must be an integer");
  }
  return number;
}

function readEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): T {
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
  return value as T;
}

function readColor(value: unknown, path: string): string {
  const color = readString(value, path, { max: 9 });
  if (!colorPattern.test(color)) {
    fail(path, "must be a #RRGGBB or #RRGGBBAA color");
  }
  return color;
}

function readBackground(
  value: unknown,
  path: string,
): SafeLayoutBackground {
  const record = expectRecord(value, path);
  const kind = readEnum(record.kind, `${path}.kind`, [
    "solid",
    "linear-gradient",
  ] as const);

  if (kind === "solid") {
    assertOnlyKeys(record, ["kind", "color"], path);
    return {
      kind,
      color: readColor(record.color, `${path}.color`),
    };
  }

  assertOnlyKeys(record, ["kind", "angle", "from", "to"], path);
  return {
    kind,
    angle: readNumber(record.angle, `${path}.angle`, 0, 360),
    from: readColor(record.from, `${path}.from`),
    to: readColor(record.to, `${path}.to`),
  };
}

function readLayoutStyle(
  value: unknown,
  path: string,
): SafeLayoutStyle {
  const record = expectRecord(value, path);
  assertOnlyKeys(
    record,
    [
      "background",
      "color",
      "padding",
      "gap",
      "borderRadius",
      "borderWidth",
      "borderColor",
      "width",
      "height",
      "align",
      "justify",
    ],
    path,
  );

  const result: {
    background?: SafeLayoutBackground;
    color?: string;
    padding?: number;
    gap?: number;
    borderRadius?: number;
    borderWidth?: number;
    borderColor?: string;
    width?: number;
    height?: number;
    align?: SafeLayoutAlignment;
    justify?: SafeLayoutJustification;
  } = {};

  if (record.background !== undefined) {
    result.background = readBackground(record.background, `${path}.background`);
  }
  if (record.color !== undefined) {
    result.color = readColor(record.color, `${path}.color`);
  }
  if (record.padding !== undefined) {
    result.padding = readNumber(record.padding, `${path}.padding`, 0, 160);
  }
  if (record.gap !== undefined) {
    result.gap = readNumber(record.gap, `${path}.gap`, 0, 96);
  }
  if (record.borderRadius !== undefined) {
    result.borderRadius = readNumber(
      record.borderRadius,
      `${path}.borderRadius`,
      0,
      96,
    );
  }
  if (record.borderWidth !== undefined) {
    result.borderWidth = readNumber(
      record.borderWidth,
      `${path}.borderWidth`,
      0,
      8,
    );
  }
  if (record.borderColor !== undefined) {
    result.borderColor = readColor(
      record.borderColor,
      `${path}.borderColor`,
    );
  }
  if (record.width !== undefined) {
    result.width = readNumber(record.width, `${path}.width`, 1, 1080);
  }
  if (record.height !== undefined) {
    result.height = readNumber(record.height, `${path}.height`, 1, 1440);
  }
  if (record.align !== undefined) {
    result.align = readEnum(record.align, `${path}.align`, [
      "start",
      "center",
      "end",
      "stretch",
    ] as const);
  }
  if (record.justify !== undefined) {
    result.justify = readEnum(record.justify, `${path}.justify`, [
      "start",
      "center",
      "end",
      "space-between",
    ] as const);
  }

  return result;
}

function readTextStyle(
  value: unknown,
  path: string,
): SafeTextStyle {
  const record = expectRecord(value, path);
  assertOnlyKeys(
    record,
    ["color", "fontSize", "fontWeight", "lineHeight", "textAlign"],
    path,
  );

  const result: {
    color?: string;
    fontSize?: number;
    fontWeight?: 400 | 500 | 600 | 700 | 800;
    lineHeight?: number;
    textAlign?: SafeTextAlignment;
  } = {};

  if (record.color !== undefined) {
    result.color = readColor(record.color, `${path}.color`);
  }
  if (record.fontSize !== undefined) {
    result.fontSize = readNumber(
      record.fontSize,
      `${path}.fontSize`,
      12,
      128,
    );
  }
  if (record.fontWeight !== undefined) {
    const weight = readInteger(
      record.fontWeight,
      `${path}.fontWeight`,
      400,
      800,
    );
    if (![400, 500, 600, 700, 800].includes(weight)) {
      fail(`${path}.fontWeight`, "must be one of 400, 500, 600, 700, 800");
    }
    result.fontWeight = weight as 400 | 500 | 600 | 700 | 800;
  }
  if (record.lineHeight !== undefined) {
    result.lineHeight = readNumber(
      record.lineHeight,
      `${path}.lineHeight`,
      1,
      2,
    );
  }
  if (record.textAlign !== undefined) {
    result.textAlign = readEnum(record.textAlign, `${path}.textAlign`, [
      "left",
      "center",
      "right",
    ] as const);
  }

  return result;
}

function readCombinedStyle(
  value: unknown,
  path: string,
): SafeLayoutStyle & SafeTextStyle {
  const record = expectRecord(value, path);
  const layoutKeys = [
    "background",
    "color",
    "padding",
    "gap",
    "borderRadius",
    "borderWidth",
    "borderColor",
    "width",
    "height",
    "align",
    "justify",
  ] as const;
  const textKeys = [
    "color",
    "fontSize",
    "fontWeight",
    "lineHeight",
    "textAlign",
  ] as const;
  assertOnlyKeys(record, [...new Set([...layoutKeys, ...textKeys])], path);

  const layoutSubset = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      (layoutKeys as readonly string[]).includes(key),
    ),
  );
  const textSubset = Object.fromEntries(
    Object.entries(record).filter(([key]) =>
      (textKeys as readonly string[]).includes(key),
    ),
  );

  return {
    ...readLayoutStyle(layoutSubset, path),
    ...readTextStyle(textSubset, path),
  };
}

function registerText(
  text: string,
  state: ValidationState,
  path: string,
): void {
  state.textCharacters += text.length;
  if (
    state.textCharacters >
    safeRichLayoutLimits.maxTotalTextCharacters
  ) {
    fail(
      path,
      `total layout text exceeds ${safeRichLayoutLimits.maxTotalTextCharacters} characters`,
    );
  }
}

function readChildren(
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
): readonly SafeLayoutNode[] {
  if (!Array.isArray(value)) {
    fail(path, "must be an array");
  }
  if (value.length > safeRichLayoutLimits.maxChildrenPerContainer) {
    fail(
      path,
      `must contain at most ${safeRichLayoutLimits.maxChildrenPerContainer} children`,
    );
  }

  return value.map((child, index) =>
    readNode(child, `${path}[${index}]`, state, depth + 1),
  );
}

function readNode(
  value: unknown,
  path: string,
  state: ValidationState,
  depth: number,
): SafeLayoutNode {
  if (depth > safeRichLayoutLimits.maxDepth) {
    fail(path, `depth exceeds ${safeRichLayoutLimits.maxDepth}`);
  }

  state.nodes += 1;
  if (state.nodes > safeRichLayoutLimits.maxNodes) {
    fail(path, `node count exceeds ${safeRichLayoutLimits.maxNodes}`);
  }

  const record = expectRecord(value, path);
  const type = readString(record.type, `${path}.type`, { max: 16 });

  if (type === "stack") {
    assertOnlyKeys(record, ["type", "direction", "style", "children"], path);
    return {
      type,
      direction: readEnum(record.direction, `${path}.direction`, [
        "row",
        "column",
      ] as const),
      ...(record.style === undefined
        ? {}
        : { style: readLayoutStyle(record.style, `${path}.style`) }),
      children: readChildren(
        record.children,
        `${path}.children`,
        state,
        depth,
      ),
    };
  }

  if (type === "grid") {
    assertOnlyKeys(record, ["type", "columns", "style", "children"], path);
    const columns = readInteger(record.columns, `${path}.columns`, 1, 4);
    return {
      type,
      columns: columns as 1 | 2 | 3 | 4,
      ...(record.style === undefined
        ? {}
        : { style: readLayoutStyle(record.style, `${path}.style`) }),
      children: readChildren(
        record.children,
        `${path}.children`,
        state,
        depth,
      ),
    };
  }

  if (type === "card") {
    assertOnlyKeys(record, ["type", "style", "children"], path);
    return {
      type,
      ...(record.style === undefined
        ? {}
        : { style: readLayoutStyle(record.style, `${path}.style`) }),
      children: readChildren(
        record.children,
        `${path}.children`,
        state,
        depth,
      ),
    };
  }

  if (type === "heading") {
    assertOnlyKeys(record, ["type", "text", "level", "style"], path);
    const text = readString(record.text, `${path}.text`, { max: 160 });
    registerText(text, state, `${path}.text`);
    const level = readInteger(record.level, `${path}.level`, 1, 3);
    return {
      type,
      text,
      level: level as 1 | 2 | 3,
      ...(record.style === undefined
        ? {}
        : { style: readTextStyle(record.style, `${path}.style`) }),
    };
  }

  if (type === "text") {
    assertOnlyKeys(record, ["type", "text", "style"], path);
    const text = readString(record.text, `${path}.text`, { max: 2000 });
    registerText(text, state, `${path}.text`);
    return {
      type,
      text,
      ...(record.style === undefined
        ? {}
        : { style: readTextStyle(record.style, `${path}.style`) }),
    };
  }

  if (type === "badge") {
    assertOnlyKeys(record, ["type", "text", "style"], path);
    const text = readString(record.text, `${path}.text`, { max: 80 });
    registerText(text, state, `${path}.text`);
    return {
      type,
      text,
      ...(record.style === undefined
        ? {}
        : { style: readCombinedStyle(record.style, `${path}.style`) }),
    };
  }

  if (type === "quote") {
    assertOnlyKeys(record, ["type", "text", "style"], path);
    const text = readString(record.text, `${path}.text`, { max: 800 });
    registerText(text, state, `${path}.text`);
    return {
      type,
      text,
      ...(record.style === undefined
        ? {}
        : { style: readCombinedStyle(record.style, `${path}.style`) }),
    };
  }

  if (type === "image") {
    assertOnlyKeys(
      record,
      ["type", "sourceId", "width", "height", "fit", "borderRadius"],
      path,
    );
    const sourceId = readString(record.sourceId, `${path}.sourceId`, {
      max: safeRichLayoutLimits.maxResourceIdLength,
    });
    if (!resourceIdPattern.test(sourceId)) {
      fail(
        `${path}.sourceId`,
        "must be an opaque local resource identifier, not a URL/path",
      );
    }

    return {
      type,
      sourceId,
      width: readInteger(record.width, `${path}.width`, 1, 1080),
      height: readInteger(record.height, `${path}.height`, 1, 1440),
      ...(record.fit === undefined
        ? {}
        : {
            fit: readEnum(record.fit, `${path}.fit`, [
              "cover",
              "contain",
            ] as const),
          }),
      ...(record.borderRadius === undefined
        ? {}
        : {
            borderRadius: readNumber(
              record.borderRadius,
              `${path}.borderRadius`,
              0,
              96,
            ),
          }),
    };
  }

  if (type === "divider") {
    assertOnlyKeys(record, ["type", "color", "thickness"], path);
    return {
      type,
      ...(record.color === undefined
        ? {}
        : { color: readColor(record.color, `${path}.color`) }),
      ...(record.thickness === undefined
        ? {}
        : {
            thickness: readNumber(
              record.thickness,
              `${path}.thickness`,
              1,
              8,
            ),
          }),
    };
  }

  if (type === "spacer") {
    assertOnlyKeys(record, ["type", "size"], path);
    return {
      type,
      size: readNumber(record.size, `${path}.size`, 1, 240),
    };
  }

  fail(`${path}.type`, "is not a supported SafeRichLayout node type");
}

export function validateSafeRichLayout(input: unknown): SafeRichLayout {
  const record = expectRecord(input, "$");
  assertOnlyKeys(record, ["type", "width", "height", "background", "children"], "$");

  if (record.type !== "page") {
    fail("$.type", 'must be "page"');
  }
  if (record.width !== safeRichLayoutCanvas.width) {
    fail("$.width", `must be ${safeRichLayoutCanvas.width}`);
  }
  if (record.height !== safeRichLayoutCanvas.height) {
    fail("$.height", `must be ${safeRichLayoutCanvas.height}`);
  }

  const state: ValidationState = { nodes: 0, textCharacters: 0 };

  return {
    type: "page",
    width: safeRichLayoutCanvas.width,
    height: safeRichLayoutCanvas.height,
    ...(record.background === undefined
      ? {}
      : { background: readBackground(record.background, "$.background") }),
    children: readChildren(record.children, "$.children", state, 0),
  };
}
