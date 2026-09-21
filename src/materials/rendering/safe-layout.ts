export const SAFE_LAYOUT_WIDTH = 1080 as const;
export const SAFE_LAYOUT_HEIGHT = 1440 as const;
export const SAFE_LAYOUT_OVERFLOW_POLICY = "clip" as const;

export const SAFE_LAYOUT_LIMITS = {
  maxDepth: 8,
  maxNodes: 96,
  maxChildren: 24,
  maxTextLength: 1200,
  maxHeadingLength: 120,
  maxResourceIdLength: 120,
  maxImageBytes: 8 * 1024 * 1024,
  maxTotalImageBytes: 24 * 1024 * 1024,
} as const;

export type SafeColor = string;
export interface SafeLinearGradient {
  readonly kind: "linear-gradient";
  readonly angle: 0 | 45 | 90 | 135;
  readonly from: SafeColor;
  readonly to: SafeColor;
}
export type SafeBackground = SafeColor | SafeLinearGradient;

export type SafeAlignment = "start" | "center" | "end" | "stretch";
export type SafeJustification =
  | "start"
  | "center"
  | "end"
  | "space-between"
  | "space-around";

export interface SafeBoxStyle {
  readonly padding?: number;
  readonly gap?: number;
  readonly background?: SafeBackground;
  readonly borderColor?: SafeColor;
  readonly borderWidth?: number;
  readonly radius?: number;
}

export interface SafePageNode extends SafeBoxStyle {
  readonly type: "page";
  readonly width: typeof SAFE_LAYOUT_WIDTH;
  readonly height: typeof SAFE_LAYOUT_HEIGHT;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeStackNode extends SafeBoxStyle {
  readonly type: "stack";
  readonly direction: "row" | "column";
  readonly align?: SafeAlignment;
  readonly justify?: SafeJustification;
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeGridNode extends SafeBoxStyle {
  readonly type: "grid";
  readonly columns: 1 | 2 | 3;
  readonly children: readonly SafeLayoutNode[];
}

interface SafeTextStyle {
  readonly color?: SafeColor;
  readonly align?: "left" | "center" | "right";
  readonly fontSize?: number;
  readonly lineHeight?: number;
  readonly maxLines?: number;
}

export interface SafeHeadingNode extends SafeTextStyle {
  readonly type: "heading";
  readonly text: string;
  readonly level: 1 | 2 | 3;
  readonly weight?: 500 | 600 | 700 | 800;
}

export interface SafeTextNode extends SafeTextStyle {
  readonly type: "text";
  readonly text: string;
  readonly weight?: 400 | 500 | 600;
}

export interface SafeImageNode {
  readonly type: "image";
  readonly resourceId: string;
  readonly width: number;
  readonly height: number;
  readonly fit?: "cover" | "contain";
  readonly radius?: number;
}

export interface SafeBadgeNode {
  readonly type: "badge";
  readonly text: string;
  readonly color?: SafeColor;
  readonly background?: SafeColor;
}

export interface SafeQuoteNode extends SafeBoxStyle, SafeTextStyle {
  readonly type: "quote";
  readonly text: string;
  readonly attribution?: string;
}

export interface SafeCardNode extends SafeBoxStyle {
  readonly type: "card";
  readonly children: readonly SafeLayoutNode[];
}

export interface SafeDividerNode {
  readonly type: "divider";
  readonly color?: SafeColor;
  readonly thickness?: number;
}

export interface SafeSpacerNode {
  readonly type: "spacer";
  readonly size: number;
}

export type SafeLayoutNode =
  | SafeStackNode
  | SafeGridNode
  | SafeHeadingNode
  | SafeTextNode
  | SafeImageNode
  | SafeBadgeNode
  | SafeQuoteNode
  | SafeCardNode
  | SafeDividerNode
  | SafeSpacerNode;

export interface SafeRichLayout {
  readonly version: 1;
  readonly page: SafePageNode;
}

export type SafeImageResources = Readonly<Record<string, Uint8Array>>;

export class SafeLayoutValidationError extends Error {
  constructor(
    readonly path: string,
    readonly reason: string,
  ) {
    super(`Invalid SafeRichLayout at ${path}: ${reason}`);
    this.name = "SafeLayoutValidationError";
  }
}

const colorPattern = /^#[0-9a-fA-F]{6}(?:[0-9a-fA-F]{2})?$/;
const resourceIdPattern = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function fail(path: string, reason: string): never {
  throw new SafeLayoutValidationError(path, reason);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireRecord(value: unknown, path: string): Record<string, unknown> {
  if (!isRecord(value)) {
    fail(path, "must be an object");
  }
  return value;
}

const boxStyleKeys = [
  "padding",
  "gap",
  "background",
  "borderColor",
  "borderWidth",
  "radius",
] as const;

const textStyleKeys = [
  "color",
  "align",
  "fontSize",
  "lineHeight",
  "maxLines",
] as const;

function assertAllowedKeys(
  value: Record<string, unknown>,
  path: string,
  allowed: readonly string[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(value)) {
    if (!allowedSet.has(key)) {
      fail(`${path}.${key}`, "is unsupported");
    }
  }
}

function assertOptionalEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): void {
  if (value !== undefined && !allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
}

function assertRequiredEnum<T extends string>(
  value: unknown,
  path: string,
  allowed: readonly T[],
): void {
  if (!allowed.includes(value as T)) {
    fail(path, `must be one of: ${allowed.join(", ")}`);
  }
}

function assertOptionalNumberInRange(
  value: unknown,
  path: string,
  min: number,
  max: number,
  integer = true,
): void {
  if (value === undefined) {
    return;
  }
  if (
    typeof value !== "number" ||
    !Number.isFinite(value) ||
    (integer && !Number.isInteger(value)) ||
    value < min ||
    value > max
  ) {
    fail(
      path,
      integer
        ? `must be an integer between ${min} and ${max}`
        : `must be between ${min} and ${max}`,
    );
  }
}

function assertColor(value: unknown, path: string): void {
  if (
    value !== undefined &&
    (typeof value !== "string" || !colorPattern.test(value))
  ) {
    fail(path, "must be a #RRGGBB or #RRGGBBAA color");
  }
}

function assertRequiredColor(value: unknown, path: string): void {
  if (typeof value !== "string" || !colorPattern.test(value)) {
    fail(path, "must be a #RRGGBB or #RRGGBBAA color");
  }
}

function assertBackground(value: unknown, path: string): void {
  if (value === undefined) {
    return;
  }
  if (typeof value === "string") {
    assertColor(value, path);
    return;
  }

  const background = requireRecord(value, path);
  assertAllowedKeys(background, path, ["kind", "angle", "from", "to"]);
  if (background.kind !== "linear-gradient") {
    fail(path, "must be a bounded linear gradient");
  }
  if (![0, 45, 90, 135].includes(background.angle as number)) {
    fail(`${path}.angle`, "must be 0, 45, 90, or 135");
  }
  assertRequiredColor(background.from, `${path}.from`);
  assertRequiredColor(background.to, `${path}.to`);
}

function validateBoxStyle(node: Record<string, unknown>, path: string): void {
  assertOptionalNumberInRange(node.padding, `${path}.padding`, 0, 128);
  assertOptionalNumberInRange(node.gap, `${path}.gap`, 0, 96);
  assertOptionalNumberInRange(node.borderWidth, `${path}.borderWidth`, 0, 12);
  assertOptionalNumberInRange(node.radius, `${path}.radius`, 0, 96);
  assertBackground(node.background, `${path}.background`);
  assertColor(node.borderColor, `${path}.borderColor`);
}

function validateTextStyle(node: Record<string, unknown>, path: string): void {
  assertColor(node.color, `${path}.color`);
  assertOptionalEnum(node.align, `${path}.align`, ["left", "center", "right"] as const);
  assertOptionalNumberInRange(node.fontSize, `${path}.fontSize`, 12, 128);
  assertOptionalNumberInRange(node.lineHeight, `${path}.lineHeight`, 1, 2.4, false);
  assertOptionalNumberInRange(node.maxLines, `${path}.maxLines`, 1, 12);
}

function validateText(
  text: unknown,
  path: string,
  maxLength: number,
): void {
  if (typeof text !== "string" || text.trim().length === 0) {
    fail(path, "must be a non-empty string");
  }
  if (text.length > maxLength) {
    fail(path, `must be at most ${maxLength} characters`);
  }
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/u.test(text)) {
    fail(path, "contains unsupported control characters");
  }
}

function validateChildren(
  children: unknown,
  path: string,
  depth: number,
  state: { count: number },
): void {
  if (!Array.isArray(children)) {
    fail(path, "must be an array");
  }
  if (children.length > SAFE_LAYOUT_LIMITS.maxChildren) {
    fail(path, `must contain at most ${SAFE_LAYOUT_LIMITS.maxChildren} children`);
  }
  children.forEach((child, index) =>
    validateNode(child, `${path}[${index}]`, depth + 1, state),
  );
}

function validateNode(
  value: unknown,
  path: string,
  depth: number,
  state: { count: number },
): void {
  if (depth > SAFE_LAYOUT_LIMITS.maxDepth) {
    fail(path, `layout depth exceeds ${SAFE_LAYOUT_LIMITS.maxDepth}`);
  }

  const node = requireRecord(value, path);
  state.count += 1;
  if (state.count > SAFE_LAYOUT_LIMITS.maxNodes) {
    fail(path, `layout contains more than ${SAFE_LAYOUT_LIMITS.maxNodes} nodes`);
  }

  switch (node.type) {
    case "stack":
      assertAllowedKeys(node, path, [
        "type",
        "direction",
        "align",
        "justify",
        "children",
        ...boxStyleKeys,
      ]);
      validateBoxStyle(node, path);
      assertRequiredEnum(node.direction, `${path}.direction`, ["row", "column"] as const);
      assertOptionalEnum(node.align, `${path}.align`, ["start", "center", "end", "stretch"] as const);
      assertOptionalEnum(
        node.justify,
        `${path}.justify`,
        ["start", "center", "end", "space-between", "space-around"] as const,
      );
      validateChildren(node.children, `${path}.children`, depth, state);
      return;
    case "grid":
      assertAllowedKeys(node, path, [
        "type",
        "columns",
        "children",
        ...boxStyleKeys,
      ]);
      validateBoxStyle(node, path);
      if (![1, 2, 3].includes(node.columns as number)) {
        fail(`${path}.columns`, "must be 1, 2, or 3");
      }
      validateChildren(node.children, `${path}.children`, depth, state);
      return;
    case "heading":
      assertAllowedKeys(node, path, [
        "type",
        "text",
        "level",
        "weight",
        ...textStyleKeys,
      ]);
      validateText(node.text, `${path}.text`, SAFE_LAYOUT_LIMITS.maxHeadingLength);
      validateTextStyle(node, path);
      if (![1, 2, 3].includes(node.level as number)) {
        fail(`${path}.level`, "must be 1, 2, or 3");
      }
      if (
        node.weight !== undefined &&
        ![500, 600, 700, 800].includes(node.weight as number)
      ) {
        fail(`${path}.weight`, "must be 500, 600, 700, or 800");
      }
      return;
    case "text":
      assertAllowedKeys(node, path, [
        "type",
        "text",
        "weight",
        ...textStyleKeys,
      ]);
      validateText(node.text, `${path}.text`, SAFE_LAYOUT_LIMITS.maxTextLength);
      validateTextStyle(node, path);
      if (
        node.weight !== undefined &&
        ![400, 500, 600].includes(node.weight as number)
      ) {
        fail(`${path}.weight`, "must be 400, 500, or 600");
      }
      return;
    case "image":
      assertAllowedKeys(node, path, [
        "type",
        "resourceId",
        "width",
        "height",
        "fit",
        "radius",
      ]);
      if (
        typeof node.resourceId !== "string" ||
        node.resourceId.length === 0 ||
        node.resourceId.length > SAFE_LAYOUT_LIMITS.maxResourceIdLength ||
        !resourceIdPattern.test(node.resourceId)
      ) {
        fail(`${path}.resourceId`, "must be a bounded local resource identifier");
      }
      assertOptionalNumberInRange(node.width, `${path}.width`, 1, SAFE_LAYOUT_WIDTH);
      assertOptionalNumberInRange(node.height, `${path}.height`, 1, SAFE_LAYOUT_HEIGHT);
      if (node.width === undefined || node.height === undefined) {
        fail(path, "must provide width and height");
      }
      assertOptionalEnum(node.fit, `${path}.fit`, ["cover", "contain"] as const);
      assertOptionalNumberInRange(node.radius, `${path}.radius`, 0, 96);
      return;
    case "badge":
      assertAllowedKeys(node, path, [
        "type",
        "text",
        "color",
        "background",
      ]);
      validateText(node.text, `${path}.text`, 80);
      assertColor(node.color, `${path}.color`);
      assertColor(node.background, `${path}.background`);
      return;
    case "quote":
      assertAllowedKeys(node, path, [
        "type",
        "text",
        "attribution",
        ...boxStyleKeys,
        ...textStyleKeys,
      ]);
      validateText(node.text, `${path}.text`, 480);
      if (node.attribution !== undefined) {
        validateText(node.attribution, `${path}.attribution`, 120);
      }
      validateBoxStyle(node, path);
      validateTextStyle(node, path);
      return;
    case "card":
      assertAllowedKeys(node, path, [
        "type",
        "children",
        ...boxStyleKeys,
      ]);
      validateBoxStyle(node, path);
      validateChildren(node.children, `${path}.children`, depth, state);
      return;
    case "divider":
      assertAllowedKeys(node, path, ["type", "color", "thickness"]);
      assertColor(node.color, `${path}.color`);
      assertOptionalNumberInRange(node.thickness, `${path}.thickness`, 1, 12);
      return;
    case "spacer":
      assertAllowedKeys(node, path, ["type", "size"]);
      assertOptionalNumberInRange(node.size, `${path}.size`, 1, 240);
      if (node.size === undefined) {
        fail(`${path}.size`, "is required");
      }
      return;
    default:
      fail(`${path}.type`, "is unsupported");
  }
}

export function validateSafeRichLayout(
  value: unknown,
): asserts value is SafeRichLayout {
  const layout = requireRecord(value, "layout");
  assertAllowedKeys(layout, "layout", ["version", "page"]);
  if (layout.version !== 1) {
    fail("version", "must equal 1");
  }

  const page = requireRecord(layout.page, "page");
  assertAllowedKeys(page, "page", [
    "type",
    "width",
    "height",
    "children",
    ...boxStyleKeys,
  ]);
  if (page.type !== "page") {
    fail("page.type", "must equal page");
  }
  if (
    page.width !== SAFE_LAYOUT_WIDTH ||
    page.height !== SAFE_LAYOUT_HEIGHT
  ) {
    fail(
      "page",
      `must use the supported ${SAFE_LAYOUT_WIDTH}x${SAFE_LAYOUT_HEIGHT} canvas`,
    );
  }

  validateBoxStyle(page, "page");
  const state = { count: 1 };
  validateChildren(page.children, "page.children", 1, state);
}

export function validateSafeImageResources(
  layout: SafeRichLayout,
  resources: SafeImageResources,
): void {
  validateSafeRichLayout(layout);

  const required = new Set<string>();
  const collect = (nodes: readonly SafeLayoutNode[]): void => {
    for (const node of nodes) {
      if (node.type === "image") {
        required.add(node.resourceId);
      } else if (
        node.type === "stack" ||
        node.type === "grid" ||
        node.type === "card"
      ) {
        collect(node.children);
      }
    }
  };
  collect(layout.page.children);

  let totalBytes = 0;
  for (const resourceId of required) {
    const bytes = resources[resourceId];
    if (!(bytes instanceof Uint8Array) || bytes.byteLength === 0) {
      fail(`resources.${resourceId}`, "must provide non-empty controlled image bytes");
    }
    if (bytes.byteLength > SAFE_LAYOUT_LIMITS.maxImageBytes) {
      fail(
        `resources.${resourceId}`,
        `exceeds ${SAFE_LAYOUT_LIMITS.maxImageBytes} bytes`,
      );
    }
    totalBytes += bytes.byteLength;
  }

  if (totalBytes > SAFE_LAYOUT_LIMITS.maxTotalImageBytes) {
    fail(
      "resources",
      `referenced images exceed ${SAFE_LAYOUT_LIMITS.maxTotalImageBytes} bytes in total`,
    );
  }
}
