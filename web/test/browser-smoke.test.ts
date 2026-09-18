import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import test from "node:test";
import { resolve } from "node:path";

import { chromium, type Browser, type Page } from "playwright";

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

async function waitForServer(process: ChildProcess): Promise<void> {
  for (let attempt = 0; attempt < 80; attempt += 1) {
    if (process.exitCode !== null) {
      assert.fail(`Vite exited before smoke started: ${process.exitCode}`);
    }

    try {
      const response = await fetch(baseUrl);
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
    waiting_for_login: "请接管登录",
    waiting_for_approval: "执行秘书已准备好发布",
    succeeded: "发布已完成",
    failed: "任务在安全边界内停止",
  };

  for (const state of states) {
    await page.goto(`${baseUrl}/#/task/${state}`, {
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

  await page.goto(`${baseUrl}/#/task/waiting_for_login`, {
    waitUntil: "domcontentloaded",
  });
  await page.locator('iframe[title="Browser Live View placeholder"]').waitFor({
    state: "visible",
  });
  await page.getByText("控制权已让给你").waitFor({ state: "visible" });

  await page.goto(`${baseUrl}/#/task/waiting_for_approval`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("发布后将产生外部不可逆副作用").waitFor({
    state: "visible",
  });

  await page.goto(`${baseUrl}/#/task/succeeded`, {
    waitUntil: "domcontentloaded",
  });
  await page.getByText("结果地址").waitFor({ state: "visible" });
  await page.getByText("平台确认").waitFor({ state: "visible" });
});

test("Task Home assignment carries edited brief and video mode into detail", async (t) => {
  const vitePath = resolve("node_modules/vite/bin/vite.js");
  const server = spawn(
    process.execPath,
    [vitePath, "web", "--host", "127.0.0.1", "--port", "4174", "--strictPort"],
    {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"],
    },
  );

  const assignmentBaseUrl = "http://127.0.0.1:4174";
  let browser: Browser | undefined;

  t.after(async () => {
    await browser?.close();
    if (server.exitCode === null) {
      server.kill("SIGTERM");
    }
  });

  for (let attempt = 0; attempt < 80; attempt += 1) {
    try {
      const response = await fetch(assignmentBaseUrl);
      if (response.ok) break;
    } catch {
      // Retry until Vite is accepting requests.
    }
    await new Promise((resolveDelay) => setTimeout(resolveDelay, 100));
  }

  browser = await chromium.launch({
    executablePath: findChrome(),
    headless: true,
    args: ["--no-sandbox"],
  });

  const page = await browser.newPage({
    viewport: { width: 1440, height: 900 },
  });

  await page.goto(`${assignmentBaseUrl}/#/`, {
    waitUntil: "domcontentloaded",
  });

  const brief = "用自定义 brief 发布一条视频任务";
  await page.locator("#brief").fill(brief);
  await page.getByRole("button", { name: "视频" }).click();
  await page.getByRole("button", { name: "交给内容秘书" }).click();

  await page.getByRole("heading", { name: brief }).waitFor({
    state: "visible",
  });
  assert.equal(
    await page.locator(".segmented.compact .selected").textContent(),
    "视频",
  );
  await page.getByText("视频成片").waitFor({ state: "visible" });
  await page.getByText("VIDEO").first().waitFor({ state: "visible" });
});
