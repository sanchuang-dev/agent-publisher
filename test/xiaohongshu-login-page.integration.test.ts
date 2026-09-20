import { existsSync } from "node:fs";

import { afterAll, beforeAll, describe, expect, test } from "vitest";
import { chromium, type Browser, type Page } from "playwright";

import { inspectXiaohongshuPublishEntry } from "../src/platforms/xiaohongshu/login-entry.js";

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
      "Xiaohongshu page-state integration requires an installed Chrome/Chromium executable",
    );
  }

  return executable;
}

async function fixturePage(
  browser: Browser,
  body: string,
): Promise<Page> {
  const page = await browser.newPage();
  await page.route("https://creator.xiaohongshu.com/**", async (route) => {
    await route.fulfill({
      status: 200,
      contentType: "text/html; charset=utf-8",
      body: `<!doctype html><html><body>${body}</body></html>`,
    });
  });
  await page.goto(
    "https://creator.xiaohongshu.com/publish/publish?source=official",
    { waitUntil: "domcontentloaded" },
  );
  return page;
}

describe("Xiaohongshu Playwright entry-state fixtures", () => {
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

  test("authenticated fixture requires a usable publisher control", async () => {
    const page = await fixturePage(
      browser,
      '<main><button type="button">上传图文</button></main>',
    );

    try {
      await expect(inspectXiaohongshuPublishEntry(page)).resolves.toEqual({
        kind: "authenticated",
      });
    } finally {
      await page.close();
    }
  });

  test("logged-out fixture is classified as login_required", async () => {
    const page = await fixturePage(
      browser,
      '<section class="login-panel"><div>扫码登录</div><img alt="登录二维码" /></section>',
    );

    try {
      await expect(inspectXiaohongshuPublishEntry(page)).resolves.toEqual({
        kind: "login_required",
      });
    } finally {
      await page.close();
    }
  });

  test("challenge fixture wins over simultaneous login markers", async () => {
    const page = await fixturePage(
      browser,
      '<section><div class="captcha-dialog">安全验证</div><div>扫码登录</div></section>',
    );

    try {
      await expect(inspectXiaohongshuPublishEntry(page)).resolves.toEqual({
        kind: "challenge",
      });
    } finally {
      await page.close();
    }
  });

  test("ambiguous creator fixture fails closed as unexpected", async () => {
    const page = await fixturePage(
      browser,
      "<main><h1>创作服务平台</h1><p>页面结构未知</p></main>",
    );

    try {
      await expect(inspectXiaohongshuPublishEntry(page)).resolves.toEqual({
        kind: "unexpected",
      });
    } finally {
      await page.close();
    }
  });
});
