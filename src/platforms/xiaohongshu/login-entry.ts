import type { Locator, Page } from "playwright";

export const XIAOHONGSHU_PUBLISH_ENTRY =
  "https://creator.xiaohongshu.com/publish/publish?source=official";

export type XiaohongshuEntryState =
  | {
      readonly kind: "authenticated";
    }
  | {
      readonly kind: "login_required";
    }
  | {
      readonly kind: "challenge";
    }
  | {
      readonly kind: "unexpected";
    };

export interface XiaohongshuEntrySignals {
  readonly url: string;
  readonly usablePublishMarker: boolean;
  readonly loginMarker: boolean;
  readonly challengeMarker: boolean;
}

function isCreatorPublishUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.protocol === "https:" &&
      url.hostname === "creator.xiaohongshu.com" &&
      url.pathname.startsWith("/publish")
    );
  } catch {
    return false;
  }
}

function isLoginUrl(rawUrl: string): boolean {
  try {
    const url = new URL(rawUrl);
    return (
      url.hostname === "creator.xiaohongshu.com" &&
      /(?:^|\/)(?:login|signin)(?:\/|$)/i.test(url.pathname)
    );
  } catch {
    return false;
  }
}

export function classifyXiaohongshuEntrySignals(
  signals: XiaohongshuEntrySignals,
): XiaohongshuEntryState {
  if (signals.challengeMarker) {
    return { kind: "challenge" };
  }

  if (signals.loginMarker || isLoginUrl(signals.url)) {
    return { kind: "login_required" };
  }

  if (isCreatorPublishUrl(signals.url) && signals.usablePublishMarker) {
    return { kind: "authenticated" };
  }

  return { kind: "unexpected" };
}

async function isAnyVisible(locators: readonly Locator[]): Promise<boolean> {
  for (const locator of locators) {
    const count = await locator.count();
    for (let index = 0; index < count; index += 1) {
      if (await locator.nth(index).isVisible()) {
        return true;
      }
    }
  }

  return false;
}

async function readSignals(page: Page): Promise<XiaohongshuEntrySignals> {
  const challengeMarker = await isAnyVisible([
    page.getByText(
      /安全验证|请完成验证|设备验证|滑块验证|身份验证|风险验证|环境异常/,
      { exact: false },
    ),
    page.locator(
      [
        '[data-testid*="verify"]',
        '[data-testid*="captcha"]',
        '[class*="captcha"]',
        '[class*="verification"]',
      ].join(", "),
    ),
  ]);

  const loginMarker = await isAnyVisible([
    page.getByText(/扫码登录|手机号登录|登录小红书|请先登录|请登录后/, {
      exact: false,
    }),
    page.locator(
      [
        'img[alt*="二维码"]',
        '[data-testid*="login-qr"]',
        '[class*="login-qrcode"]',
        '[class*="login-qr"]',
      ].join(", "),
    ),
  ]);

  const usablePublishMarker = await isAnyVisible([
    page.getByText(/上传图文|上传视频|写长文|新的创作|选择文件|拖拽.*上传/, {
      exact: false,
    }),
    page.locator('input[type="file"][accept*="image"], input[type="file"][accept*="video"]'),
  ]);

  return {
    url: page.url(),
    usablePublishMarker,
    loginMarker,
    challengeMarker,
  };
}

export async function inspectXiaohongshuPublishEntry(
  page: Page,
  timeoutMs = 0,
): Promise<XiaohongshuEntryState> {
  const deadline = Date.now() + Math.max(0, timeoutMs);

  while (true) {
    const state = classifyXiaohongshuEntrySignals(await readSignals(page));
    if (state.kind !== "unexpected" || Date.now() >= deadline) {
      return state;
    }

    await page.waitForTimeout(Math.min(100, Math.max(1, deadline - Date.now())));
  }
}

export async function openXiaohongshuPublishEntry(
  page: Page,
  timeoutMs = 5_000,
): Promise<XiaohongshuEntryState> {
  await page.goto(XIAOHONGSHU_PUBLISH_ENTRY, {
    waitUntil: "domcontentloaded",
    timeout: Math.max(timeoutMs, 1),
  });

  return await inspectXiaohongshuPublishEntry(page, timeoutMs);
}
