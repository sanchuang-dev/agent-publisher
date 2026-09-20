import { createHash } from "node:crypto";

import type { Locator, Page } from "playwright";

import type {
  ImageAssetReference,
  ImageTextMaterialPack,
  MaterialPack,
} from "../../materials/contracts.js";

export type PreparedField = "title" | "body" | "tags";

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

    observedImageCount = await countVisible(uploadedImageItems(page));
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
  const tags = await requireSingleEditable(
    tagsCandidates(page),
    "tags",
    timeoutMs,
  );

  const actualTitle = normalizeText(await readEditable(title));
  const actualBody = normalizeText(await readEditable(body));
  const actualTags = parseTagInput(await readEditable(tags));

  const expectedTitle = normalizeText(pack.copy.title);
  const expectedBody = normalizeText(pack.copy.body);
  const expectedTags = normalizeTags(pack.copy.tags);

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
    .or(page.getByText("上传图文", { exact: true }))
    .first();

  try {
    await imageTextEntry.waitFor({ state: "visible", timeout: timeoutMs });
    await imageTextEntry.click();

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
    const tags = await requireSingleEditable(
      tagsCandidates(page),
      "tags",
      timeoutMs,
    );

    const uploadInput = page
      .locator('input[type="file"][accept*="image"]')
      .first();
    try {
      await uploadInput.waitFor({ state: "attached", timeout: timeoutMs });
    } catch (error) {
      throw new XiaohongshuPageStateError(
        "PLATFORM_UI_CHANGED",
        "Xiaohongshu image upload input did not become available.",
        { cause: error },
      );
    }

    await ensureFreshComposer(page);

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

    await ensureFreshComposer(page);
    try {
      await input.onMutationStarted?.();
    } catch (error) {
      throw new XiaohongshuPrepareCheckpointError({ cause: error });
    }
    await uploadInput.setInputFiles(assetPaths);

    await waitForUploadReady(page, assets.length, timeoutMs);
    await ensureEditorsEmpty([
      ["title", title],
      ["body", body],
      ["tags", tags],
    ]);

    await title.fill(pack.copy.title);
    await body.fill(pack.copy.body);
    await tags.fill(
      normalizeTags(pack.copy.tags)
        .map((tag) => "#" + tag)
        .join(" "),
    );

    const verified = await verifyXiaohongshuPreparedPage({
      page,
      materialPack: pack,
      timeoutMs,
    });

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
      error instanceof XiaohongshuPreparedValidationError ||
      error instanceof XiaohongshuUnsupportedPublishModeError ||
      error instanceof XiaohongshuComposerNotFreshError ||
      error instanceof XiaohongshuPageStateError ||
      error instanceof XiaohongshuPrepareCheckpointError
    ) {
      throw error;
    }

    throw new XiaohongshuPageStateError(
      "BROWSER_INTERACTION_FAILED",
      error instanceof Error
        ? "Xiaohongshu prepare page interaction failed: " + error.message
        : "Xiaohongshu prepare page interaction failed.",
      { cause: error },
    );
  }
}
