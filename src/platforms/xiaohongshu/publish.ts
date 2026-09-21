import type { Locator, Page } from "playwright";

export interface XiaohongshuPublishedResult {
  readonly kind: "published";
  readonly resultUrl: string | null;
  readonly contentId: string | null;
  readonly confirmationRef: string;
}

export interface XiaohongshuNotPublishedResult {
  readonly kind: "not_published";
  readonly reasonCode: string;
}

export type XiaohongshuPublishVerificationResult =
  | XiaohongshuPublishedResult
  | XiaohongshuNotPublishedResult;

export interface ExecuteXiaohongshuPublishInput {
  readonly page: Page;
  readonly timeoutMs?: number;
  readonly onMutationStarted?: () => void | Promise<void>;
}

export interface VerifyXiaohongshuPublishResultInput {
  readonly page: Page;
  readonly timeoutMs?: number;
}

export class XiaohongshuPublishPageStateError extends Error {
  readonly code = "PUBLISH_UI_CHANGED" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "XiaohongshuPublishPageStateError";
  }
}

export class XiaohongshuPublishVerificationUncertainError extends Error {
  readonly code = "PUBLISH_RESULT_UNKNOWN" as const;

  constructor(message = "Xiaohongshu publication result is not yet deterministic.") {
    super(message);
    this.name = "XiaohongshuPublishVerificationUncertainError";
  }
}

function publishButtons(page: Page): Locator {
  return page
    .getByRole("button", {
      name: /^(发布|发布笔记|立即发布|确认发布)$/,
    })
    .or(page.locator('button:visible').filter({ hasText: /^(发布|发布笔记|立即发布|确认发布)$/ }));
}

async function requireSingleVisiblePublishButton(
  page: Page,
  timeoutMs: number,
): Promise<Locator> {
  const candidates = publishButtons(page);

  try {
    await candidates.first().waitFor({ state: "visible", timeout: timeoutMs });
  } catch (error) {
    throw new XiaohongshuPublishPageStateError(
      "The Xiaohongshu publish button did not become visible.",
      { cause: error },
    );
  }

  const count = await candidates.count();
  const visible: Locator[] = [];
  for (let index = 0; index < count; index += 1) {
    const candidate = candidates.nth(index);
    if (await candidate.isVisible()) {
      visible.push(candidate);
    }
  }

  if (visible.length !== 1) {
    throw new XiaohongshuPublishPageStateError(
      "Expected exactly one visible Xiaohongshu publish button.",
    );
  }

  return visible[0]!;
}

export async function executeXiaohongshuPublish(
  input: ExecuteXiaohongshuPublishInput,
): Promise<void> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const button = await requireSingleVisiblePublishButton(input.page, timeoutMs);

  if (await button.isDisabled()) {
    throw new XiaohongshuPublishPageStateError(
      "The Xiaohongshu publish button is disabled.",
    );
  }

  await input.onMutationStarted?.();

  try {
    await button.click({ timeout: timeoutMs });
  } catch (error) {
    throw new XiaohongshuPublishPageStateError(
      "The Xiaohongshu publish interaction did not complete cleanly.",
      { cause: error },
    );
  }
}

function sanitizedXiaohongshuResultUrl(rawUrl: string): string | null {
  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    const hostname = url.hostname.toLowerCase();
    if (
      hostname !== "xiaohongshu.com" &&
      !hostname.endsWith(".xiaohongshu.com")
    ) {
      return null;
    }

    url.username = "";
    url.password = "";
    url.search = "";
    url.hash = "";
    return url.toString();
  } catch {
    return null;
  }
}

function contentIdFromResultUrl(resultUrl: string | null): string | null {
  if (!resultUrl) return null;

  try {
    const url = new URL(resultUrl);
    const match = url.pathname.match(
      /\/(?:explore|discovery\/item|user\/profile\/[^/]+\/notes?)\/([A-Za-z0-9_-]{6,128})(?:\/|$)/,
    );
    return match?.[1] ?? null;
  } catch {
    return null;
  }
}

async function visibleText(locator: Locator): Promise<boolean> {
  return (await locator.count()) > 0 && (await locator.first().isVisible());
}

export async function verifyXiaohongshuPublishResult(
  input: VerifyXiaohongshuPublishResultInput,
): Promise<XiaohongshuPublishVerificationResult> {
  const timeoutMs = input.timeoutMs ?? 15_000;
  const deadline = Date.now() + timeoutMs;

  while (Date.now() <= deadline) {
    const explicitFailure = input.page.getByText(
      /发布失败|提交失败|发布未成功|笔记发布失败/,
      { exact: false },
    );
    if (await visibleText(explicitFailure)) {
      return {
        kind: "not_published",
        reasonCode: "PLATFORM_REPORTED_PUBLISH_FAILURE",
      };
    }

    const resultUrl = sanitizedXiaohongshuResultUrl(input.page.url());
    const contentId = contentIdFromResultUrl(resultUrl);
    const successMarker = input.page.getByText(
      /发布成功|笔记发布成功|发布完成|提交成功/,
      { exact: false },
    );

    if (contentId || (await visibleText(successMarker))) {
      return {
        kind: "published",
        resultUrl,
        contentId,
        confirmationRef: contentId
          ? "xhs-result-page"
          : "xhs-publish-success",
      };
    }

    const remaining = deadline - Date.now();
    if (remaining <= 0) break;
    await input.page.waitForTimeout(Math.min(150, remaining));
  }

  throw new XiaohongshuPublishVerificationUncertainError();
}
