import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import {
  executeXiaohongshuPublish,
  verifyXiaohongshuPublishResult,
  XiaohongshuPublishPageStateError,
  XiaohongshuPublishVerificationUncertainError,
} from "../src/platforms/xiaohongshu/publish.js";

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => Boolean(value));

  const executable = candidates.find(existsSync);
  if (!executable) {
    throw new Error(
      "Xiaohongshu publish-page integration requires an installed Chrome/Chromium executable",
    );
  }

  return executable;
}

async function fixturePage(
  browser: Browser,
  body: string,
  url = "https://creator.xiaohongshu.com/publish/publish?source=official",
): Promise<Page> {
  const page = await browser.newPage();
  await page.route("https://creator.xiaohongshu.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${body}</body></html>`,
    });
  });
  await page.route("https://www.xiaohongshu.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${body}</body></html>`,
    });
  });
  await page.goto(url, { waitUntil: "domcontentloaded" });
  return page;
}

describe("Xiaohongshu deterministic final-publish page fixtures", () => {
  let browser: Browser;

  beforeAll(async () => {
    browser = await chromium.launch({
      executablePath: findChrome(),
      headless: true,
    });
  });

  afterAll(async () => {
    await browser.close();
  });

  test("starts the mutation boundary before exactly one publish click", async () => {
    const page = await fixturePage(
      browser,
      '<button type="button" onclick="window.__publishClicks=(window.__publishClicks||0)+1">发布</button>',
    );
    let callbackClicks: number | null = null;

    try {
      await executeXiaohongshuPublish({
        page,
        onMutationStarted: async () => {
          callbackClicks = await page.evaluate(
            () => (window as unknown as { __publishClicks?: number }).__publishClicks ?? 0,
          );
        },
      });

      expect(callbackClicks).toBe(0);
      await expect(
        page.evaluate(
          () => (window as unknown as { __publishClicks?: number }).__publishClicks ?? 0,
        ),
      ).resolves.toBe(1);
    } finally {
      await page.close();
    }
  });

  test("fails closed before mutation when more than one publish control is visible", async () => {
    const page = await fixturePage(
      browser,
      '<button type="button">发布</button><button type="button">立即发布</button>',
    );
    let mutationStarted = false;

    try {
      await expect(
        executeXiaohongshuPublish({
          page,
          onMutationStarted: () => {
            mutationStarted = true;
          },
        }),
      ).rejects.toBeInstanceOf(XiaohongshuPublishPageStateError);
      expect(mutationStarted).toBe(false);
    } finally {
      await page.close();
    }
  });

  test("verifies a bounded Xiaohongshu result URL and content id", async () => {
    const page = await fixturePage(
      browser,
      "<main>笔记详情</main>",
      "https://www.xiaohongshu.com/explore/post123456?token=must-not-persist#private",
    );

    try {
      await expect(
        verifyXiaohongshuPublishResult({ page, timeoutMs: 100 }),
      ).resolves.toEqual({
        kind: "published",
        resultUrl: "https://www.xiaohongshu.com/explore/post123456",
        contentId: "post123456",
        confirmationRef: "xhs-result-page",
      });
    } finally {
      await page.close();
    }
  });

  test("classifies explicit platform failure without inventing success", async () => {
    const page = await fixturePage(
      browser,
      "<main><div>发布失败，请稍后重试</div></main>",
    );

    try {
      await expect(
        verifyXiaohongshuPublishResult({ page, timeoutMs: 100 }),
      ).resolves.toEqual({
        kind: "not_published",
        reasonCode: "PLATFORM_REPORTED_PUBLISH_FAILURE",
      });
    } finally {
      await page.close();
    }
  });

  test("does not accept generic submission success as publish evidence", async () => {
    const page = await fixturePage(
      browser,
      "<main><div>提交成功</div></main>",
    );

    try {
      await expect(
        verifyXiaohongshuPublishResult({ page, timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(
        XiaohongshuPublishVerificationUncertainError,
      );
    } finally {
      await page.close();
    }
  });

  test("keeps an ambiguous result uncertain", async () => {
    const page = await fixturePage(
      browser,
      "<main><div>处理中</div></main>",
    );

    try {
      await expect(
        verifyXiaohongshuPublishResult({ page, timeoutMs: 50 }),
      ).rejects.toBeInstanceOf(
        XiaohongshuPublishVerificationUncertainError,
      );
    } finally {
      await page.close();
    }
  });
});
