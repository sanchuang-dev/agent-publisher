import { createHash } from "node:crypto";

import type { Locator, Page } from "playwright";

import type {
  ImageAssetReference,
  ImageTextMaterialPack,
  MaterialPack,
} from "../../materials/contracts.js";

export type PreparedField = "title" | "body" | "tags";

export const XIAOHONGSHU_PREPARE_INTERACTION_STAGES = [
  "enter_image_text",
  "find_title_editor",
  "find_body_editor",
  "find_tags_editor",
  "find_upload_input",
  "verify_fresh_composer",
  "upload",
  "fill_fields",
  "readback",
] as const;

export type XiaohongshuPrepareInteractionStage =
  (typeof XIAOHONGSHU_PREPARE_INTERACTION_STAGES)[number];

export type XiaohongshuPrepareUrlCategory =
  | "about_blank"
  | "creator_publish"
  | "creator_other"
  | "other";

export type XiaohongshuPrepareInteractionErrorType =
  | "page_state"
  | "composer_not_fresh"
  | "prepared_validation"
  | "checkpoint"
  | "browser_interaction"
  | "unknown";

export interface PreparedImageTextPublication {
  readonly platform: "xiaohongshu";
  readonly mode: "image_text";
  readonly planId: string;
  readonly title: string;
  readonly bodyLength: number;
  readonly tags: readonly string[];
  readonly imageAssetIds: readonly string[];
  readonly imageCount: number;
  readonly contentFingerprint: string;
  readonly verifiedAt: string;
}

export interface VerifiedPreparedForm {
  readonly title: string;
  readonly bodyLength: number;
  readonly tags: readonly string[];
  readonly imageCount: number;
}

export type AssetPathResolver = (
  asset: ImageAssetReference,
) => string | Promise<string>;

export class XiaohongshuUnsupportedPublishModeError extends Error {
  readonly code = "MATERIAL_UNSUPPORTED_CAPABILITY" as const;

  constructor(readonly mode: MaterialPack["mode"]) {
    super(
      "Xiaohongshu deterministic prepare currently supports image_text only; " +
        mode +
        " must be routed to an explicit video capability.",
    );
    this.name = "XiaohongshuUnsupportedPublishModeError";
  }
}

export class XiaohongshuPreparedValidationError extends Error {
  readonly code = "PREPARED_VALIDATION_FAILED" as const;

  constructor(readonly mismatches: readonly PreparedField[]) {
    super(
      "Xiaohongshu prepared form validation failed for: " +
        mismatches.join(", "),
    );
    this.name = "XiaohongshuPreparedValidationError";
  }
}

export class XiaohongshuComposerNotFreshError extends Error {
  readonly code = "COMPOSER_NOT_FRESH" as const;

  constructor(readonly reason: string) {
    super("Xiaohongshu composer is not fresh: " + reason);
    this.name = "XiaohongshuComposerNotFreshError";
  }
}

export type XiaohongshuPageStateErrorCode =
  | "PLATFORM_UI_CHANGED"
  | "PLATFORM_EDITOR_STATE_CHANGED"
  | "PLATFORM_UPLOAD_FAILED"
  | "PLATFORM_UPLOAD_TIMEOUT"
  | "ASSET_RESOLUTION_FAILED"
  | "BROWSER_INTERACTION_FAILED";

export class XiaohongshuPageStateError extends Error {
  constructor(
    readonly code: XiaohongshuPageStateErrorCode,
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.name = "XiaohongshuPageStateError";
  }
}

export class XiaohongshuPrepareCheckpointError extends Error {
  readonly code = "PREPARE_CHECKPOINT_FAILED" as const;

  constructor(options?: ErrorOptions) {
    super(
      "Could not persist the Xiaohongshu prepare mutation boundary.",
      options,
    );
    this.name = "XiaohongshuPrepareCheckpointError";
  }
}

export class XiaohongshuPrepareInteractionError extends Error {
  constructor(
    readonly stage: XiaohongshuPrepareInteractionStage,
    readonly urlCategory: XiaohongshuPrepareUrlCategory,
    readonly interactionErrorType: XiaohongshuPrepareInteractionErrorType,
    readonly code: string,
    options?: ErrorOptions,
  ) {
    super("Xiaohongshu prepare interaction failed at " + stage + ".", options);
    this.name = "XiaohongshuPrepareInteractionError";
  }
}

function boundedPageUrlCategory(page: Page): XiaohongshuPrepareUrlCategory {
  const rawUrl = page.url();
  if (rawUrl === "about:blank") {
    return "about_blank";
  }

  try {
    const url = new URL(rawUrl);
    if (url.hostname !== "creator.xiaohongshu.com") {
      return "other";
    }
    return url.pathname.startsWith("/publish")
      ? "creator_publish"
      : "creator_other";
  } catch {
    return "other";
  }
}

function boundedInteractionErrorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    const candidate = (error as { readonly code: string }).code;
    if (/^[A-Z0-9_]{1,64}$/.test(candidate)) {
      return candidate;
    }
  }

  return "BROWSER_INTERACTION_FAILED";
}

function boundedInteractionErrorType(
  error: unknown,
): XiaohongshuPrepareInteractionErrorType {
  if (error instanceof XiaohongshuPageStateError) return "page_state";
  if (error instanceof XiaohongshuComposerNotFreshError) {
    return "composer_not_fresh";
  }
  if (error instanceof XiaohongshuPreparedValidationError) {
    return "prepared_validation";
  }
  if (error instanceof XiaohongshuPrepareCheckpointError) return "checkpoint";
  if (error instanceof Error) return "browser_interaction";
  return "unknown";
}

async function runInteractionStage<T>(
  page: Page,
  stage: XiaohongshuPrepareInteractionStage,
  operation: () => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (error instanceof XiaohongshuPrepareInteractionError) {
      throw error;
    }

    throw new XiaohongshuPrepareInteractionError(
      stage,
      boundedPageUrlCategory(page),
      boundedInteractionErrorType(error),
      boundedInteractionErrorCode(error),
      { cause: error },
    );
  }
}

function normalizeText(value: string): string {
  return value.replace(/\r\n/g, "\n").trim();
}

function normalizeTag(value: string): string {
  return value.trim().replace(/^#+/, "");
}

function normalizeTags(values: readonly string[]): readonly string[] {
  return values.map(normalizeTag).filter((value) => value.length > 0);
}

function parseTagInput(value: string): readonly string[] {
  const hashtags = value.match(/#[^\s#]+/g);
  if (hashtags && hashtags.length > 0) {
    return normalizeTags(hashtags);
  }

  return normalizeTags(value.split(/[\s,，]+/));
}

function uniqueImageAssets(
  pack: ImageTextMaterialPack,
): readonly ImageAssetReference[] {
  const byId = new Map<string, ImageAssetReference>();
  for (const asset of [pack.cover, ...pack.images]) {
    if (!byId.has(asset.assetId)) {
      byId.set(asset.assetId, asset);
    }
  }
  return [...byId.values()];
}

function titleCandidates(page: Page): Locator {
  return page.locator(
    [
      'input[placeholder*="标题"]:visible',
      'textarea[placeholder*="标题"]:visible',
      'input[aria-label*="标题"]:visible',
      'textarea[aria-label*="标题"]:visible',
    ].join(", "),
  );
}

function bodyCandidates(page: Page): Locator {
  return page.locator(
    [
      'textarea[placeholder*="正文"]:visible',
      '[contenteditable="true"][data-placeholder*="正文"]:visible',
      '[contenteditable="true"][aria-label*="正文"]:visible',
      '.tiptap.ProseMirror[contenteditable="true"]:visible',
      '.ProseMirror[contenteditable="true"]:visible',
    ].join(", "),
  );
}

function tagsCandidates(page: Page): Locator {
  return page.locator(
    [
      'input[placeholder*="话题"]:visible',
      'input[placeholder*="标签"]:visible',
      'textarea[placeholder*="话题"]:visible',
      'textarea[placeholder*="标签"]:visible',
      'input[aria-label*="话题"]:visible',
      'input[aria-label*="标签"]:visible',
    ].join(", "),
  );
}

function uploadInputCandidates(page: Page): Locator {
  return page.locator(
    [
      'input.upload-input[type="file"]',
      'input[type="file"][multiple]',
      'input[type="file"][accept*="image"]',
      'input[type="file"][accept*=".jpg"]',
      'input[type="file"][accept*=".jpeg"]',
      'input[type="file"][accept*=".png"]',
      'input[type="file"][accept*=".webp"]',
    ].join(", "),
  );
}

function uploadedImageItems(page: Page): Locator {
  return page.locator(
    [
      '[data-testid="uploaded-image"]',
      '[data-testid="image-preview"]',
      "[data-xhs-uploaded-image]",
      '[class*="upload-item"][class*="success"]',
      '[class*="image-preview"]',
      '[class*="img-preview"]',
    ].join(", "),
  );
}

async function readUploadCounter(page: Page): Promise<number | null> {
  const counters = page.getByText(/\\b\\d+\\s*\\/\\s*18\\b/, {
    exact: false,
  });
  const count = await counters.count();
  let observed: number | null = null;
  for (let index = 0; index < count; index += 1) {
    const text = await counters.nth(index).textContent();
    const match = text?.match(/\\b(\\d+)\\s*\\/\\s*18\\b/);
    if (!match) continue;
    const value = Number.parseInt(match[1]!, 10);
    if (Number.isFinite(value)) {
      observed = Math.max(observed ?? 0, value);
    }
  }
  return observed;
}

function uploadFailure(page: Page): Locator {
  return page
    .getByText(/上传失败|上传错误|处理失败|图片[^\n]{0,12}失败/, {
      exact: false,
    })
    .first();
}

function uploadBusy(page: Page): Locator {
  return page
    .getByText(/上传中|处理中|正在上传|正在处理/, { exact: false })
    .first();
}

async function countVisible(locator: Locator): Promise<number> {
  const count = await locator.count();
  let visible = 0;
  for (let index = 0; index < count; index += 1) {
    if (await locator.nth(index).isVisible()) {
      visible += 1;
    }
  }
  return visible;
}

async function readEditable(locator: Locator): Promise<string> {
  return locator.evaluate((element) => {
    if (
      element instanceof HTMLInputElement ||
      element instanceof HTMLTextAreaElement
    ) {
      return element.value;
    }

    return element.textContent ?? "";
  });
}

async function isContentEditable(locator: Locator): Promise<boolean> {
  return locator.evaluate(
    (element) =>
      element instanceof HTMLElement && element.isContentEditable,
  );
}

async function fillBodyEditor(
  locator: Locator,
  value: string,
): Promise<void> {
  if (!(await isContentEditable(locator))) {
    await locator.fill(value);
    return;
  }

  await locator.evaluate((element, text) => {
    if (!(element instanceof HTMLElement)) {
      throw new Error("body editor is not an HTMLElement");
    }

    element.focus();
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(element);
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.execCommand("delete", false);

    const lines = text.replace(/\r\n/g, "\n").split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      if (lines[index]) {
        document.execCommand("insertText", false, lines[index]);
      }
      if (index < lines.length - 1) {
        document.execCommand("insertParagraph", false);
      }
    }
  }, value);
}

async function readBodyWithoutTopicEntities(
  locator: Locator,
): Promise<string> {
  return locator.evaluate((element) => {
    const clone = element.cloneNode(true) as HTMLElement;
    for (const topic of clone.querySelectorAll("a.tiptap-topic")) {
      topic.remove();
    }
    return clone.textContent ?? "";
  });
}

async function readTopicEntities(locator: Locator): Promise<readonly string[]> {
  const raw = await locator.locator("a.tiptap-topic").evaluateAll((elements) =>
    elements.map((element) => ({
      dataTopic: element.getAttribute("data-topic"),
      text: element.textContent ?? "",
    })),
  );

  return raw
    .map(({ dataTopic, text }) => {
      if (dataTopic) {
        try {
          const parsed = JSON.parse(dataTopic) as { readonly name?: unknown };
          if (typeof parsed.name === "string") {
            return parsed.name;
          }
        } catch {
          // Fall back to visible entity text.
        }
      }
      return text;
    })
    .map(normalizeTag)
    .filter((value) => value.length > 0);
}

async function requireSingleEditable(
  candidates: Locator,
  field: PreparedField,
  timeoutMs: number,
): Promise<Locator> {
  try {
    await candidates.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    throw new XiaohongshuPageStateError(
      "PLATFORM_UI_CHANGED",
      "Xiaohongshu " + field + " editor did not become visible.",
      { cause: error },
    );
  }

  const count = await candidates.count();
  if (count !== 1) {
    throw new XiaohongshuPageStateError(
      "PLATFORM_EDITOR_STATE_CHANGED",
      "Expected exactly one visible " +
        field +
        " editor, found " +
        count +
        ".",
    );
  }
  return candidates.first();
}

async function ensureEditorsEmpty(
  editors: readonly (readonly [PreparedField, Locator])[],
): Promise<void> {
  for (const [field, locator] of editors) {
    if (normalizeText(await readEditable(locator)).length > 0) {
      throw new XiaohongshuComposerNotFreshError(
        "existing " + field + " content was detected",
      );
    }
  }
}

async function ensureFreshComposer(page: Page): Promise<void> {
  const attachmentCount = await countVisible(uploadedImageItems(page));
  if (attachmentCount > 0) {
    throw new XiaohongshuComposerNotFreshError(
      "existing image attachments were detected",
    );
  }

  const failure = uploadFailure(page);
  if ((await failure.count()) > 0 && (await failure.isVisible())) {
    throw new XiaohongshuComposerNotFreshError(
      "an existing upload failure marker was detected",
    );
  }

  const fields = [
    ["title", titleCandidates(page)],
    ["body", bodyCandidates(page)],
    ["tags", tagsCandidates(page)],
  ] as const;

  for (const [field, candidates] of fields) {
    const count = await candidates.count();
    if (count > 1) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_EDITOR_STATE_CHANGED",
        "Expected at most one visible " +
          field +
          " editor before prepare, found " +
          count +
          ".",
      );
    }
    if (count === 1 && normalizeText(await readEditable(candidates.first()))) {
      throw new XiaohongshuComposerNotFreshError(
        "existing " + field + " content was detected",
      );
    }
  }
}

type TagEditorTarget =
  | {
      readonly kind: "dedicated";
      readonly locator: Locator;
    }
  | {
      readonly kind: "topic_entities";
      readonly body: Locator;
    }
  | {
      readonly kind: "none";
    };

async function resolveTagEditorTarget(
  page: Page,
  body: Locator,
  expectedTags: readonly string[],
): Promise<TagEditorTarget> {
  const candidates = tagsCandidates(page);
  const count = await candidates.count();
  if (count > 1) {
    throw new XiaohongshuPageStateError(
      "PLATFORM_EDITOR_STATE_CHANGED",
      "Expected at most one visible tags editor, found " + count + ".",
    );
  }

  if (count === 1) {
    return { kind: "dedicated", locator: candidates.first() };
  }

  if (normalizeTags(expectedTags).length === 0) {
    return { kind: "none" };
  }

  if (await isContentEditable(body)) {
    return { kind: "topic_entities", body };
  }

  throw new XiaohongshuPageStateError(
    "PLATFORM_UI_CHANGED",
    "No verified Xiaohongshu topic mechanism is available for non-empty tags.",
  );
}

function tagInputValue(tags: readonly string[]): string {
  return normalizeTags(tags)
    .map((tag) => "#" + tag)
    .join(" ");
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^$\{\}()|[\]\\]/g, "\\type TagEditorTarget =
  | {
      readonly kind: "dedicated";
      readonly locator: Locator;
    }
  | {
      readonly kind: "none";
    };

async function resolveTagEditorTarget(
  page: Page,
  expectedTags: readonly string[],
): Promise<TagEditorTarget> {
  const candidates = tagsCandidates(page);
  const count = await candidates.count();
  if (count > 1) {
    throw new XiaohongshuPageStateError(
      "PLATFORM_EDITOR_STATE_CHANGED",
      "Expected at most one visible tags editor, found " + count + ".",
    );
  }

  if (count === 1) {
    return { kind: "dedicated", locator: candidates.first() };
  }

  if (normalizeTags(expectedTags).length === 0) {
    return { kind: "none" };
  }

  throw new XiaohongshuPageStateError(
    "PLATFORM_UI_CHANGED",
    "No verified Xiaohongshu tags editor is available for non-empty tags.",
  );
}

function tagInputValue(tags: readonly string[]): string {
  return normalizeTags(tags)
    .map((tag) => "#" + tag)
    .join(" ");
}
");
}

function compactTopicQuery(value: string): string {
  return normalizeTag(value).replace(/\s+/g, "");
}

async function appendTopicEntities(
  page: Page,
  body: Locator,
  tags: readonly string[],
  timeoutMs: number,
): Promise<void> {
  const expectedTags = normalizeTags(tags);
  if (expectedTags.length === 0) return;

  const deadline = Date.now() + timeoutMs;
  for (let index = 0; index < expectedTags.length; index += 1) {
    const readableTag = expectedTags[index]!;
    const query = compactTopicQuery(readableTag);
    if (!query) continue;

    await body.evaluate((element, topicQuery) => {
      if (!(element instanceof HTMLElement) || !element.isContentEditable) {
        throw new Error("topic editor is not contenteditable");
      }

      element.focus();
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      range.collapse(false);
      selection?.removeAllRanges();
      selection?.addRange(range);
      document.execCommand("insertText", false, " #" + topicQuery);
    }, query);

    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_UI_CHANGED",
        "Xiaohongshu topic suggestions did not become ready in time.",
      );
    }

    const suggestion = page
      .locator("div.item .name")
      .filter({
        hasText: new RegExp(
          "^\\s*#?" + escapeRegExp(query) + "\\s*$",
          "i",
        ),
      })
      .first();

    try {
      await suggestion.waitFor({ state: "visible", timeout: remaining });
      await suggestion.click();
    } catch (error) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_UI_CHANGED",
        "Xiaohongshu topic suggestion did not become selectable.",
        { cause: error },
      );
    }

    const expectedCount = index + 1;
    const committed = body.locator("a.tiptap-topic");
    try {
      await committed.nth(expectedCount - 1).waitFor({
        state: "visible",
        timeout: Math.max(1, deadline - Date.now()),
      });
    } catch (error) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_UI_CHANGED",
        "Xiaohongshu did not commit the selected topic entity.",
        { cause: error },
      );
    }
  }
}

async function waitForUploadReady(
  page: Page,
  expectedImageCount: number,
  timeoutMs: number,
): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  let observedImageCount = 0;

  while (Date.now() <= deadline) {
    const failure = uploadFailure(page);
    if ((await failure.count()) > 0 && (await failure.isVisible())) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_UPLOAD_FAILED",
        "Xiaohongshu reported an image upload or processing failure.",
      );
    }

    const previewCount = await countVisible(uploadedImageItems(page));
    const platformCount = await readUploadCounter(page);
    observedImageCount = Math.max(previewCount, platformCount ?? 0);
    if (observedImageCount > expectedImageCount) {
      throw new XiaohongshuComposerNotFreshError(
        "platform shows more image attachments than this prepare requested",
      );
    }

    const busy = uploadBusy(page);
    const isBusy =
      (await busy.count()) > 0 ? await busy.isVisible() : false;

    if (!isBusy && observedImageCount === expectedImageCount) {
      return observedImageCount;
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await page.waitForTimeout(Math.min(100, remaining));
  }

  throw new XiaohongshuPageStateError(
    "PLATFORM_UPLOAD_TIMEOUT",
    "Image upload did not reach a DOM-verified ready state; observed " +
      observedImageCount +
      " of " +
      expectedImageCount +
      " expected attachments.",
  );
}

export function fingerprintXiaohongshuImageTextMaterialPack(
  pack: ImageTextMaterialPack,
): string {
  const canonical = {
    mode: pack.mode,
    planId: pack.planId,
    title: normalizeText(pack.copy.title),
    body: normalizeText(pack.copy.body),
    tags: normalizeTags(pack.copy.tags),
    imageAssetIds: uniqueImageAssets(pack).map((asset) => asset.assetId),
  };

  return createHash("sha256")
    .update(JSON.stringify(canonical))
    .digest("hex");
}

export interface VerifyXiaohongshuPreparedPageInput {
  readonly page: Page;
  readonly materialPack: ImageTextMaterialPack;
  readonly timeoutMs?: number;
}

export async function verifyXiaohongshuPreparedPage(
  input: VerifyXiaohongshuPreparedPageInput,
): Promise<VerifiedPreparedForm> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const pack = input.materialPack;
  const page = input.page;
  const expectedImageCount = uniqueImageAssets(pack).length;
  const imageCount = await waitForUploadReady(
    page,
    expectedImageCount,
    timeoutMs,
  );

  const title = await requireSingleEditable(
    titleCandidates(page),
    "title",
    timeoutMs,
  );
  const body = await requireSingleEditable(
    bodyCandidates(page),
    "body",
    timeoutMs,
  );
  const tagsTarget = await resolveTagEditorTarget(
    page,
    body,
    pack.copy.tags,
  );

  const actualTitle = normalizeText(await readEditable(title));
  const actualBody = normalizeText(
    tagsTarget.kind === "topic_entities"
      ? await readBodyWithoutTopicEntities(body)
      : await readEditable(body),
  );
  const expectedTitle = normalizeText(pack.copy.title);
  const expectedBody = normalizeText(pack.copy.body);
  const expectedTags = normalizeTags(pack.copy.tags);
  const actualTags =
    tagsTarget.kind === "dedicated"
      ? parseTagInput(await readEditable(tagsTarget.locator))
      : tagsTarget.kind === "topic_entities"
        ? await readTopicEntities(body)
        : [];

  const mismatches: PreparedField[] = [];
  if (actualTitle !== expectedTitle) mismatches.push("title");
  if (actualBody !== expectedBody) mismatches.push("body");
  if (JSON.stringify(actualTags) !== JSON.stringify(expectedTags)) {
    mismatches.push("tags");
  }

  if (mismatches.length > 0) {
    throw new XiaohongshuPreparedValidationError(mismatches);
  }

  return {
    title: expectedTitle,
    bodyLength: expectedBody.length,
    tags: expectedTags,
    imageCount,
  };
}

export interface PrepareXiaohongshuPublicationInput {
  readonly page: Page;
  readonly materialPack: MaterialPack;
  readonly resolveAssetPath: AssetPathResolver;
  readonly timeoutMs?: number;
  readonly now?: () => Date;
  readonly onMutationStarted?: () => void | Promise<void>;
}

export async function prepareXiaohongshuPublication(
  input: PrepareXiaohongshuPublicationInput,
): Promise<PreparedImageTextPublication> {
  if (input.materialPack.mode !== "image_text") {
    throw new XiaohongshuUnsupportedPublishModeError(input.materialPack.mode);
  }

  const timeoutMs = input.timeoutMs ?? 15_000;
  const pack = input.materialPack;
  const page = input.page;

  const imageTextEntry = page
    .getByRole("tab", { name: /图文/ })
    .or(page.getByRole("button", { name: /图文/ }))
    .or(page.locator('div.creator-tab:has-text("上传图文")'))
    .or(page.getByText("上传图文", { exact: true }))
    .first();

  try {
    await runInteractionStage(page, "enter_image_text", async () => {
      await imageTextEntry.waitFor({ state: "visible", timeout: timeoutMs });
      await imageTextEntry.click();
    });

    const uploadInput = await runInteractionStage(
      page,
      "find_upload_input",
      async () => {
        const candidate = uploadInputCandidates(page).first();
        await candidate.waitFor({ state: "attached", timeout: timeoutMs });
        return candidate;
      },
    );

    await runInteractionStage(page, "verify_fresh_composer", async () => {
      await ensureFreshComposer(page);
    });

    const assets = uniqueImageAssets(pack);
    let assetPaths: string[];
    try {
      assetPaths = await Promise.all(
        assets.map((asset) => input.resolveAssetPath(asset)),
      );
    } catch (error) {
      throw new XiaohongshuPageStateError(
        "ASSET_RESOLUTION_FAILED",
        "Failed to resolve one or more controlled image assets.",
        { cause: error },
      );
    }

    await runInteractionStage(page, "verify_fresh_composer", async () => {
      await ensureFreshComposer(page);
    });

    try {
      await input.onMutationStarted?.();
    } catch (error) {
      throw new XiaohongshuPrepareCheckpointError({ cause: error });
    }

    await runInteractionStage(page, "upload", async () => {
      let currentUploadInput = uploadInput;
      for (let index = 0; index < assetPaths.length; index += 1) {
        if (index > 0) {
          currentUploadInput = uploadInputCandidates(page).first();
          await currentUploadInput.waitFor({
            state: "attached",
            timeout: timeoutMs,
          });
        }
        await currentUploadInput.setInputFiles(assetPaths[index]!);
        await waitForUploadReady(page, index + 1, timeoutMs);
      }
    });

    const title = await runInteractionStage(
      page,
      "find_title_editor",
      () => requireSingleEditable(titleCandidates(page), "title", timeoutMs),
    );
    const body = await runInteractionStage(
      page,
      "find_body_editor",
      () => requireSingleEditable(bodyCandidates(page), "body", timeoutMs),
    );
    const tagsTarget = await runInteractionStage(
      page,
      "find_tags_editor",
      () => resolveTagEditorTarget(page, body, pack.copy.tags),
    );

    await runInteractionStage(page, "verify_fresh_composer", async () => {
      const editors: Array<readonly [PreparedField, Locator]> = [
        ["title", title],
        ["body", body],
      ];
      if (tagsTarget.kind === "dedicated") {
        editors.push(["tags", tagsTarget.locator]);
      }
      await ensureEditorsEmpty(editors);
      if (
        tagsTarget.kind === "topic_entities" &&
        (await readTopicEntities(body)).length > 0
      ) {
        throw new XiaohongshuComposerNotFreshError(
          "existing topic entities were detected",
        );
      }
    });

    await runInteractionStage(page, "fill_fields", async () => {
      await title.fill(pack.copy.title);
      await fillBodyEditor(body, pack.copy.body);
      if (tagsTarget.kind === "dedicated") {
        await tagsTarget.locator.fill(tagInputValue(pack.copy.tags));
      } else if (tagsTarget.kind === "topic_entities") {
        await appendTopicEntities(
          page,
          body,
          pack.copy.tags,
          timeoutMs,
        );
      }
    });

    const verified = await runInteractionStage(page, "readback", () =>
      verifyXiaohongshuPreparedPage({
        page,
        materialPack: pack,
        timeoutMs,
      }),
    );

    return {
      platform: "xiaohongshu",
      mode: "image_text",
      planId: pack.planId,
      title: verified.title,
      bodyLength: verified.bodyLength,
      tags: verified.tags,
      imageAssetIds: assets.map((asset) => asset.assetId),
      imageCount: verified.imageCount,
      contentFingerprint: fingerprintXiaohongshuImageTextMaterialPack(pack),
      verifiedAt: (input.now?.() ?? new Date()).toISOString(),
    };
  } catch (error) {
    if (
      error instanceof XiaohongshuPrepareInteractionError ||
      error instanceof XiaohongshuUnsupportedPublishModeError ||
      error instanceof XiaohongshuPageStateError ||
      error instanceof XiaohongshuPrepareCheckpointError
    ) {
      throw error;
    }

    throw new XiaohongshuPageStateError(
      "BROWSER_INTERACTION_FAILED",
      "Xiaohongshu prepare page interaction failed.",
      { cause: error },
    );
  }
}
