import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import test from "node:test";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";
import { build, preview } from "vite";

import { createMvpPrepublishApplication } from "../../src/app/mvp-prepublish-application.js";
import { createControlledMaterialSource } from "../../src/app/prepublish-material-source.js";
import type { BrowserProvider, BrowserSession } from "../../src/browser/provider.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
  prepareXiaohongshuPublication,
  XiaohongshuPageStateError,
  XiaohongshuPrepareCheckpointError,
  XiaohongshuPrepareInteractionError,
} from "../../src/platforms/xiaohongshu/image-text-prepare.js";
import { createImageTextMaterialPackFixture } from "../../src/materials/testing/fake-providers.js";

const baseUrl = "http://127.0.0.1:4173";
const states = [
  "preparing_materials",
  "preparing_publish",
  "waiting_for_login",
  "waiting_for_approval",
  "succeeded",
  "failed",
] as const;

function findChrome(): string {
  const candidates = [
    process.env.CHROME_PATH,
    "/usr/bin/google-chrome",
    "/usr/bin/chromium",
    "/usr/bin/chromium-browser",
    "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  ].filter((value): value is string => Boolean(value));

  const executable = candidates.find(existsSync);
  assert.ok(
    executable,
    "1440px browser smoke requires an installed Chrome/Chromium executable",
  );

  return executable;
}

async function waitForServer(process: ChildProcess, url = baseUrl): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) {
      assert.fail(`Vite exited before smoke started: ${process.exitCode}`);
    }

    try {
      const response = await fetch(url);
      if (response.ok) return;
    } catch {
      // Retry until Vite is accepting requests.
    }

    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  assert.fail("Timed out waiting for Vite smoke server");
}

async function assertThreeColumnLayout(page: Page): Promise<void> {
  const selectors = [".context-panel", ".timeline-panel", ".work-surface"];
  const boxes = [];

  for (const selector of selectors) {
    const locator = page.locator(selector);
    await locator.waitFor({ state: "visible" });
    const box = await locator.boundingBox();
    assert.ok(box, `${selector} must have a rendered box`);
    assert.ok(box.width >= 240, `${selector} is unexpectedly narrow`);
    boxes.push(box);
  }

  assert.ok(boxes[0]!.x < boxes[1]!.x, "context must stay left of timeline");
  assert.ok(boxes[1]!.x < boxes[2]!.x, "timeline must stay left of work surface");

  const rightEdge = boxes[2]!.x + boxes[2]!.width;
  assert.ok(
    rightEdge <= 1440.5,
    `three-column shell must fit the 1440px viewport; got ${rightEdge}`,
  );

  assert.ok(
    boxes[0]!.width >= 270 && boxes[0]!.width <= 305,
    `context column should preserve the approved ~288px geometry; got ${boxes[0]!.width}`,
  );
  assert.ok(
    boxes[2]!.width >= 475 && boxes[2]!.width <= 525,
    `work surface should preserve the approved ~508px geometry; got ${boxes[2]!.width}`,
  );
}

test("1440px MVP shell exposes every fixture state and required work surface", async (t) => {
  const vitePath = resolve("node_modules/vite/bin/vite.js");
  assert.ok(existsSync(vitePath), "Vite must be installed before browser smoke");

  const server = spawn(
    process.execPath,
    [vitePath, "web", "--host", "127.0.0.1", "--port", "4173", "--strictPort"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let browser: Browser | undefined;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
    }
  });

  await waitForServer(server);

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  const expectedText: Record<(typeof states)[number], string> = {
    preparing_materials: "Material Pack",
    preparing_publish: "执行秘书正在操作",
    waiting_for_login: "等待 Browser Live View",
    waiting_for_approval: "执行秘书已准备好发布",
    succeeded: "发布已完成",
    failed: "任务在安全边界内停止",
  };

  for (const state of states) {
    await page.goto(`${baseUrl}/#/fixture/${state}`, {
      waitUntil: "domcontentloaded",
    });

    assert.equal(await page.locator(".fixture-nav").count(), 0);
    const headerBox = await page.locator(".app-header").boundingBox();
    assert.ok(headerBox, "app header must render");
    assert.ok(
      Math.abs(headerBox.height - 64) <= 1,
      `header must preserve the approved 64px height; got ${headerBox.height}`,
    );

    await assertThreeColumnLayout(page);
    await page.getByText(expectedText[state], { exact: false }).first().waitFor({
      state: "visible",
    });
  }

  await page.goto(`${baseUrl}/#/fixture/waiting_for_login`, {
    waitUntil: "domcontentloaded",
  });
  const fixtureFrame = page.locator('iframe[title="Browser Live View"]');
  await fixtureFrame.waitFor({ state: "visible" });
  assert.equal(
    await fixtureFrame.getAttribute("src"),
    "/browser-live-view-placeholder.html",
  );
  await page.getByText("等待 Browser Live View").waitFor({ state: "visible" });
  await page.getByText("Live View 未连接").waitFor({ state: "visible" });
  assert.equal(
    await fixtureFrame.evaluate((element) => getComputedStyle(element).pointerEvents),
    "none",
  );
  assert.equal(await fixtureFrame.getAttribute("tabindex"), "-1");
  assert.equal(await page.getByText("控制权已让给你").count(), 0);

  await page.goto(`${baseUrl}/#/fixture/waiting_for_approval`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("发布后将产生外部不可逆副作用").waitFor({
    state: "visible",
  });

  await page.goto(`${baseUrl}/#/fixture/succeeded`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("结果地址").waitFor({ state: "visible" });
  await page.getByText("平台确认").waitFor({ state: "visible" });
});

test("real Web assignment reaches APP-02 waiting_for_approval without publish", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-f3-real-ui-"));
  const databasePath = join(root, "app.db");
  const pack = createImageTextMaterialPackFixture();
  const prepared = {
    platform: "xiaohongshu" as const,
    mode: "image_text" as const,
    planId: pack.planId,
    title: pack.copy.title,
    bodyLength: pack.copy.body.length,
    tags: pack.copy.tags,
    imageAssetIds: [pack.cover, ...pack.images].map((asset) => asset.assetId),
    imageCount: new Set([pack.cover.assetId, ...pack.images.map((asset) => asset.assetId)]).size,
    contentFingerprint: fingerprintXiaohongshuImageTextMaterialPack(pack),
    verifiedAt: "2026-09-20T12:00:00.000Z",
  };

  const browserProvider: BrowserProvider = {
    async acquire(): Promise<BrowserSession> {
      return {
        id: "f3-browser-session",
        profileRef: "f3-profile",
        page: {} as BrowserSession["page"],
      };
    },
    async release() {},
    async health() {
      return { status: "reachable" as const };
    },
  };

  const application = createMvpPrepublishApplication({
    databasePath,
    browserProvider,
    materialSource: createControlledMaterialSource(async () => pack),
    resolveAssetPath: (asset) => "/controlled/" + asset.assetId + ".png",
    xiaohongshu: {
      openEntry: async () => ({ kind: "authenticated" }),
      inspectEntry: async () => ({ kind: "authenticated" }),
      preparePage: async (input) => {
        await input.onMutationStarted?.();
        return prepared;
      },
      verifyPreparedPage: async () => ({
        title: prepared.title,
        bodyLength: prepared.bodyLength,
        tags: prepared.tags,
        imageCount: prepared.imageCount,
      }),
    },
  });

  const backendOrigin = await application.start({
    host: "127.0.0.1",
    port: 3011,
  });

  const vitePath = resolve("node_modules/vite/bin/vite.js");
  const uiOrigin = "http://127.0.0.1:4174";
  const server = spawn(
    process.execPath,
    [vitePath, "web", "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
    {
      cwd: process.cwd(),
      env: { ...process.env, WEB_API_PROXY_TARGET: backendOrigin },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let browser: Browser | undefined;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
    }
    await application.stop();
    rmSync(root, { recursive: true, force: true });
  });

  await waitForServer(server, uiOrigin);

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(uiOrigin + "/#/", { waitUntil: "domcontentloaded" });

  const brief = "真人 Web → APP-02 预发布接线 smoke";
  await page.locator("#brief").fill(brief);
  await page.getByRole("button", { name: "交给内容秘书" }).click();

  await page.waitForURL(/#\/task\/[^/]+$/);
  assert.equal(page.url().includes("#/fixture/"), false);

  await page.getByText("执行秘书已准备好发布").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText("受控测试物料 · generatedFromBrief=false").waitFor({
    state: "visible",
  });
  await page.getByText(pack.copy.title, { exact: true }).first().waitFor({
    state: "visible",
  });

  const publishButton = page.getByRole("button", { name: "批准发布" });
  assert.equal(await publishButton.isDisabled(), true);
  assert.equal(
    await page.getByText("当前仅到审批前，最终发布尚未启用。").count(),
    1,
  );

  const durableUrl = page.url();
  await page.reload({ waitUntil: "domcontentloaded" });
  assert.equal(page.url(), durableUrl);
  await page.getByText("执行秘书已准备好发布").waitFor({
    state: "visible",
    timeout: 10_000,
  });
  await page.getByText(pack.copy.title, { exact: true }).first().waitFor({
    state: "visible",
  });

  await assertThreeColumnLayout(page);
});

test("runtime config supports interactive takeover then revokes input on agent resume", async (t) => {
  const vitePath = resolve("node_modules/vite/bin/vite.js");
  const injectedBaseUrl = "http://127.0.0.1:4175";
  const fakeLiveViewUrl = "/fake-novnc/vnc.html";
  const server = spawn(
    process.execPath,
    [vitePath, "web", "--host", "127.0.0.1", "--port", "4175", "--strictPort"],
    {
      cwd: process.cwd(),
      env: { ...process.env, VITE_LIVE_VIEW_URL: fakeLiveViewUrl },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  let browser: Browser | undefined;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
    }
  });

  await waitForServer(server, injectedBaseUrl);

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(`${injectedBaseUrl}/#/fixture/waiting_for_login`, {
    waitUntil: "domcontentloaded",
  });

  const frame = page.locator('iframe[title="Browser Live View"]');
  await frame.waitFor({ state: "visible" });
  assert.equal(await frame.getAttribute("src"), fakeLiveViewUrl);
  assert.equal(
    await frame.evaluate((element) => getComputedStyle(element).pointerEvents),
    "auto",
  );
  assert.equal(await frame.getAttribute("tabindex"), "0");
  await page.getByText("控制权已让给你").waitFor({ state: "visible" });

  await frame.focus();
  assert.equal(
    await page.evaluate(() => document.activeElement?.getAttribute("title")),
    "Browser Live View",
  );

  await page.evaluate(() => {
    window.location.hash = "#/fixture/preparing_publish";
  });
  await page.getByText("执行秘书正在操作").waitFor({ state: "visible" });
  await page.waitForFunction(
    () => document.activeElement?.getAttribute("title") !== "Browser Live View",
  );

  const agentFrame = page.locator('iframe[title="Browser Live View"]');
  assert.equal(await agentFrame.getAttribute("src"), fakeLiveViewUrl);
  assert.equal(
    await agentFrame.evaluate((element) => getComputedStyle(element).pointerEvents),
    "none",
  );
  assert.equal(await agentFrame.getAttribute("tabindex"), "-1");
  await page.getByText("执行秘书控制").waitFor({ state: "visible" });
  await assertThreeColumnLayout(page);
});


test("production build preserves injected Live View runtime config", async (t) => {
  const outDir = mkdtempSync(
    join(tmpdir(), "agent-publisher-live-view-build-"),
  );
  const productionBaseUrl = "http://127.0.0.1:4176";
  const fakeLiveViewUrl = "/fake-novnc/vnc.html";
  const previousLiveViewUrl = process.env.VITE_LIVE_VIEW_URL;

  process.env.VITE_LIVE_VIEW_URL = fakeLiveViewUrl;
  try {
    await build({
      root: resolve("web"),
      configFile: resolve("web/vite.config.ts"),
      logLevel: "silent",
      build: {
        outDir,
        emptyOutDir: true,
      },
    });
  } finally {
    if (previousLiveViewUrl === undefined) {
      delete process.env.VITE_LIVE_VIEW_URL;
    } else {
      process.env.VITE_LIVE_VIEW_URL = previousLiveViewUrl;
    }
  }

  const previewServer = await preview({
    root: resolve("web"),
    configFile: resolve("web/vite.config.ts"),
    logLevel: "silent",
    build: {
      outDir,
    },
    preview: {
      host: "127.0.0.1",
      port: 4176,
      strictPort: true,
    },
  });

  let browser: Browser | undefined;

  t.after(async () => {
    await browser?.close();
    await new Promise<void>((resolveClose, rejectClose) => {
      previewServer.httpServer.close((error) => {
        if (error) rejectClose(error);
        else resolveClose();
      });
    });
    rmSync(outDir, {
      recursive: true,
      force: true,
      maxRetries: 10,
      retryDelay: 50,
    });
  });

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(`${productionBaseUrl}/#/fixture/waiting_for_login`, {
    waitUntil: "domcontentloaded",
  });

  const frame = page.locator('iframe[title="Browser Live View"]');
  await frame.waitFor({ state: "visible" });
  assert.equal(await frame.getAttribute("src"), fakeLiveViewUrl);
  assert.equal(
    await frame.evaluate((element) => getComputedStyle(element).pointerEvents),
    "auto",
  );
  assert.equal(await frame.getAttribute("tabindex"), "0");
  await page.getByText("控制权已让给你").waitFor({ state: "visible" });
});


test("Xiaohongshu image-text page fixture verifies platform previews and never publishes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-xhs-page-"));
  const pack = createImageTextMaterialPackFixture();
  const assetPaths = new Map<string, string>();

  for (const asset of [pack.cover, ...pack.images]) {
    const path = join(root, asset.assetId + ".png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assetPaths.set(asset.assetId, path);
  }

  const resolveAssetPath = (asset: (typeof pack.images)[number]) => {
    const path = assetPaths.get(asset.assetId);
    assert.ok(path, "fixture asset path must exist");
    return path;
  };

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  t.after(async () => {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab" id="image-text-tab" aria-selected="false">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <div id="upload-status">等待上传</div>
        <div style="display:none"><div data-testid="uploaded-image">hidden stale preview</div></div>
        <div id="previews"></div>
        <input id="title" placeholder="填写标题" />
        <div contenteditable="true">unrelated editor</div>
        <textarea id="body" placeholder="填写正文"></textarea>
        <input id="tags" placeholder="添加话题" />
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
          document.querySelector("#image-text-tab").addEventListener("click", (event) => {
            event.currentTarget.setAttribute("aria-selected", "true");
          });
          document.querySelector("#image-upload").addEventListener("change", (event) => {
            const previews = document.querySelector("#previews");
            for (const file of event.currentTarget.files) {
              const preview = document.createElement("div");
              preview.dataset.testid = "uploaded-image";
              preview.textContent = file.name;
              previews.append(preview);
            }
            document.querySelector("#upload-status").textContent = "上传成功";
          });
          document.querySelector("#publish").addEventListener("click", () => {
            window.__publishClicks += 1;
          });
        </script>
      </body>
    </html>
  `);

  const prepared = await prepareXiaohongshuPublication({
    page,
    materialPack: pack,
    resolveAssetPath,
    timeoutMs: 2_000,
    now: () => new Date("2026-09-20T05:00:00.000Z"),
  });

  assert.equal(
    await page.locator("#image-text-tab").getAttribute("aria-selected"),
    "true",
  );
  assert.equal(
    await page.locator('#previews [data-testid="uploaded-image"]').count(),
    3,
  );
  assert.equal(await page.locator("#title").inputValue(), pack.copy.title);
  assert.equal(await page.locator("#body").inputValue(), pack.copy.body);
  assert.equal(
    await page.locator("#tags").inputValue(),
    pack.copy.tags.map((tag) => "#" + tag).join(" "),
  );
  assert.deepEqual(prepared.tags, pack.copy.tags);
  assert.equal(prepared.imageCount, 3);
  assert.equal(prepared.bodyLength, pack.copy.body.length);
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <div id="upload-status">等待上传</div>
        <div id="previews"></div>
        <input id="title" placeholder="填写标题" />
        <textarea id="body" placeholder="填写正文"></textarea>
        <input id="tags" placeholder="添加话题" />
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
          document.querySelector("#image-upload").addEventListener("change", (event) => {
            const previews = document.querySelector("#previews");
            for (const file of event.currentTarget.files) {
              const preview = document.createElement("div");
              preview.dataset.testid = "uploaded-image";
              preview.textContent = file.name;
              previews.append(preview);
            }
          });
          document.querySelector("#title").addEventListener("input", (event) => {
            event.currentTarget.value = "页面改写后的标题";
          });
          document.querySelector("#publish").addEventListener("click", () => {
            window.__publishClicks += 1;
          });
        </script>
      </body>
    </html>
  `);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 2_000,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "readback");
      assert.equal(error.code, "PREPARED_VALIDATION_FAILED");
      assert.equal(error.interactionErrorType, "prepared_validation");
      return true;
    },
  );

  assert.equal(await page.locator('[data-testid="uploaded-image"]').count(), 3);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 250,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "verify_fresh_composer");
      assert.equal(error.code, "COMPOSER_NOT_FRESH");
      assert.equal(error.interactionErrorType, "composer_not_fresh");
      return true;
    },
  );
  assert.equal(
    await page.locator('[data-testid="uploaded-image"]').count(),
    3,
    "retry must fail closed instead of appending duplicate attachments",
  );
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <input placeholder="填写标题" />
        <textarea placeholder="填写正文"></textarea>
        <input placeholder="添加话题" />
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
        </script>
      </body>
    </html>
  `);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 250,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "upload");
      assert.equal(error.code, "PLATFORM_UPLOAD_TIMEOUT");
      assert.equal(error.interactionErrorType, "page_state");
      return true;
    },
    "holding local input files without platform previews must not count as ready",
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <div id="upload-status"></div>
        <input placeholder="填写标题" />
        <textarea placeholder="填写正文"></textarea>
        <input placeholder="添加话题" />
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
          document.querySelector("#image-upload").addEventListener("change", () => {
            document.querySelector("#upload-status").textContent = "上传失败";
          });
        </script>
      </body>
    </html>
  `);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 250,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "upload");
      assert.equal(error.code, "PLATFORM_UPLOAD_FAILED");
      assert.equal(error.interactionErrorType, "page_state");
      return true;
    },
    "explicit platform upload failure must fail closed",
  );
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <div id="previews"></div>
        <input placeholder="填写标题" />
        <textarea placeholder="填写正文"></textarea>
        <input placeholder="添加话题" />
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
        </script>
      </body>
    </html>
  `);

  const assetCause = new Error("controlled asset is unavailable");
  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath: async () => {
          throw assetCause;
        },
        timeoutMs: 250,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPageStateError);
      assert.equal(error.code, "ASSET_RESOLUTION_FAILED");
      assert.equal(error.cause, assetCause);
      return true;
    },
  );
  assert.equal(await page.locator('[data-testid="uploaded-image"]').count(), 0);
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <div id="previews"></div>
        <input placeholder="填写标题" />
        <textarea placeholder="填写正文"></textarea>
        <input placeholder="添加话题" />
        <script>
          document.querySelector("#image-upload").addEventListener("change", (event) => {
            const previews = document.querySelector("#previews");
            for (const file of event.currentTarget.files) {
              const preview = document.createElement("div");
              preview.dataset.testid = "uploaded-image";
              preview.textContent = file.name;
              previews.append(preview);
            }
          });
        </script>
      </body>
    </html>
  `);

  const checkpointCause = new Error("fixture persistence unavailable");
  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 250,
        onMutationStarted: () => {
          throw checkpointCause;
        },
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareCheckpointError);
      assert.equal(error.code, "PREPARE_CHECKPOINT_FAILED");
      assert.equal(error.cause, checkpointCause);
      return true;
    },
  );
  assert.equal(
    await page.locator('[data-testid="uploaded-image"]').count(),
    0,
    "failed durable checkpoint must abort before setInputFiles",
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab">图文</button>
        <input id="image-upload" type="file" accept="image/png" multiple />
        <input placeholder="填写标题" />
        <input placeholder="备用标题" />
        <textarea placeholder="填写正文"></textarea>
        <input placeholder="添加话题" />
      </body>
    </html>
  `);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 250,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "verify_fresh_composer");
      assert.equal(error.code, "PLATFORM_EDITOR_STATE_CHANGED");
      assert.equal(error.interactionErrorType, "page_state");
      return true;
    },
  );

  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab" id="image-text-tab">图文</button>
        <div id="composer"></div>
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;
          document.querySelector("#image-text-tab").addEventListener("click", () => {
            setTimeout(() => {
              document.querySelector("#composer").innerHTML = \`
                <input id="image-upload" type="file" accept="image/png" multiple />
                <input id="title" placeholder="填写标题" value="已有草稿标题" />
                <textarea id="body" placeholder="填写正文">已有草稿正文</textarea>
                <input id="tags" placeholder="添加话题" value="#已有话题" />
              \`;
            }, 50);
          });
          document.querySelector("#publish").addEventListener("click", () => {
            window.__publishClicks += 1;
          });
        </script>
      </body>
    </html>
  `);

  await assert.rejects(
    () =>
      prepareXiaohongshuPublication({
        page,
        materialPack: pack,
        resolveAssetPath,
        timeoutMs: 1_000,
      }),
    (error) => {
      assert.ok(error instanceof XiaohongshuPrepareInteractionError);
      assert.equal(error.stage, "verify_fresh_composer");
      assert.equal(error.code, "COMPOSER_NOT_FRESH");
      assert.equal(error.interactionErrorType, "composer_not_fresh");
      return true;
    },
    "draft content restored after tab activation must be observed before mutation",
  );
  assert.equal(await page.locator("#title").inputValue(), "已有草稿标题");
  assert.equal(await page.locator("#body").inputValue(), "已有草稿正文");
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );

  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );
});


test("Xiaohongshu ProseMirror fixture commits real topic entities and never publishes", async (t) => {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-xhs-topics-"));
  const pack = createImageTextMaterialPackFixture();
  const assetPaths = new Map<string, string>();

  for (const asset of [pack.cover, ...pack.images]) {
    const path = join(root, asset.assetId + ".png");
    writeFileSync(path, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    assetPaths.set(asset.assetId, path);
  }

  const browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  t.after(async () => {
    await browser.close();
    rmSync(root, { recursive: true, force: true });
  });

  const page = await browser.newPage();
  await page.setContent(`
    <!doctype html>
    <html lang="zh-CN">
      <body>
        <button role="tab" id="image-text-tab">上传图文</button>
        <input class="upload-input" type="file" accept="image/png" multiple />
        <div id="previews"></div>
        <input id="title" placeholder="填写标题" />
        <div id="body" class="tiptap ProseMirror" contenteditable="true" data-placeholder="正文"></div>
        <div id="suggestions"></div>
        <button id="publish">发布</button>
        <script>
          window.__publishClicks = 0;

          document.querySelector(".upload-input").addEventListener("change", (event) => {
            const previews = document.querySelector("#previews");
            for (const file of event.currentTarget.files) {
              const preview = document.createElement("div");
              preview.dataset.testid = "uploaded-image";
              preview.textContent = file.name;
              previews.append(preview);
            }
          });

          const editor = document.querySelector("#body");
          const suggestions = document.querySelector("#suggestions");

          function removeTrailingQuery(tag) {
            const walker = document.createTreeWalker(editor, NodeFilter.SHOW_TEXT);
            const nodes = [];
            let node;
            while ((node = walker.nextNode())) nodes.push(node);

            const needle = "#" + tag;
            for (let index = nodes.length - 1; index >= 0; index -= 1) {
              const current = nodes[index];
              const value = current.textContent || "";
              const offset = value.lastIndexOf(needle);
              if (offset < 0) continue;
              current.textContent =
                value.slice(0, offset).replace(/\\s+$/, "") +
                " " +
                value.slice(offset + needle.length);
              return;
            }
          }

          function renderSuggestion(tag) {
            suggestions.replaceChildren();
            const item = document.createElement("div");
            item.className = "item";
            const name = document.createElement("span");
            name.className = "name";
            name.textContent = "#" + tag;
            item.append(name);
            item.addEventListener("click", () => {
              removeTrailingQuery(tag);
              const topic = document.createElement("a");
              topic.className = "tiptap-topic";
              topic.dataset.topic = JSON.stringify({ name: tag });
              topic.textContent = "#" + tag;
              editor.append(topic);
              suggestions.replaceChildren();
            });
            suggestions.append(item);
          }

          editor.addEventListener("input", () => {
            const match = (editor.textContent || "").match(/#([^\\s#]+)$/);
            if (match) renderSuggestion(match[1]);
          });

          document.querySelector("#publish").addEventListener("click", () => {
            window.__publishClicks += 1;
          });
        </script>
      </body>
    </html>
  `);

  const prepared = await prepareXiaohongshuPublication({
    page,
    materialPack: pack,
    resolveAssetPath: (asset) => {
      const path = assetPaths.get(asset.assetId);
      assert.ok(path, "fixture asset path must exist");
      return path;
    },
    timeoutMs: 2_000,
  });

  assert.equal(
    await page.locator('[data-testid="uploaded-image"]').count(),
    3,
  );
  assert.equal(await page.locator("#title").inputValue(), pack.copy.title);
  assert.equal(
    (await page.locator("#body").textContent())?.includes(pack.copy.body),
    true,
  );
  assert.deepEqual(
    await page.locator("a.tiptap-topic").evaluateAll((elements) =>
      elements.map((element) =>
        JSON.parse(element.getAttribute("data-topic") || "{}").name,
      ),
    ),
    pack.copy.tags,
  );
  assert.deepEqual(prepared.tags, pack.copy.tags);
  assert.equal(
    await page.evaluate(() => Reflect.get(window, "__publishClicks")),
    0,
  );
});
