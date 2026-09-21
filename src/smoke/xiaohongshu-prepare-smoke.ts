import { randomUUID } from "node:crypto";
import {
  mkdirSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import { deflateSync } from "node:zlib";

import type { BrowserProvider } from "../browser/provider.js";
import { DockerCdpBrowserProvider } from "../browser/providers/docker-cdp.js";
import {
  createMvpPrepublishApplication,
  type CreateMvpPrepublishApplicationOptions,
} from "../app/mvp-prepublish-application.js";
import { createControlledMaterialSource } from "../app/prepublish-material-source.js";
import type {
  ImageAssetReference,
  ImageTextMaterialPack,
} from "../materials/contracts.js";
import {
  inspectXiaohongshuPublishEntry,
  openXiaohongshuPublishEntry,
} from "../platforms/xiaohongshu/login-entry.js";

export const XHS_REAL_ACCOUNT_SMOKE_ENV = "XHS_REAL_ACCOUNT_SMOKE" as const;
export const XHS_SMOKE_DATA_ROOT_ENV = "XHS_SMOKE_DATA_ROOT" as const;
export const XHS_SMOKE_LOGIN_WAIT_MS_ENV = "XHS_SMOKE_LOGIN_WAIT_MS" as const;

const DEFAULT_LOGIN_WAIT_MS = 5 * 60 * 1000;
const MAX_LOGIN_WAIT_MS = 15 * 60 * 1000;
const LOGIN_POLL_MS = 2_500;

export interface XiaohongshuPrepareSmokeEvidence {
  readonly smoke: "xiaohongshu-prepare";
  readonly phase:
    | "job_created"
    | "waiting_for_login"
    | "waiting_for_approval";
  readonly jobId: string;
  readonly status:
    | "created"
    | "waiting_for_login"
    | "waiting_for_approval";
  readonly actionType: "login_required" | "approval_required" | null;
  readonly title?: string;
  readonly bodyLength?: number;
  readonly imageCount?: number;
}

export interface RunXiaohongshuPrepareSmokeOptions {
  readonly env?: NodeJS.ProcessEnv;
  readonly browserProvider?: BrowserProvider;
  readonly rootDirectory?: string;
  readonly runId?: string;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly onEvidence?: (evidence: XiaohongshuPrepareSmokeEvidence) => void;
  readonly xiaohongshu?: CreateMvpPrepublishApplicationOptions["xiaohongshu"];
}

export interface XiaohongshuPrepareSmokeResult {
  readonly evidence: XiaohongshuPrepareSmokeEvidence;
  readonly runDirectory: string;
}

export class XiaohongshuPrepareSmokeError extends Error {
  constructor(
    readonly code:
      | "OPT_IN_REQUIRED"
      | "INVALID_LOGIN_WAIT"
      | "LOGIN_TIMEOUT"
      | "UNSAFE_BROWSER_PAGE"
      | "SMOKE_BLOCKED"
      | "UNEXPECTED_FINAL_STATE",
    message: string,
    readonly detailCode?: string,
  ) {
    super(message);
    this.name = "XiaohongshuPrepareSmokeError";
  }
}

function assertOptIn(env: NodeJS.ProcessEnv): void {
  if (env[XHS_REAL_ACCOUNT_SMOKE_ENV] !== "1") {
    throw new XiaohongshuPrepareSmokeError(
      "OPT_IN_REQUIRED",
      "Refusing real Xiaohongshu prepare smoke without XHS_REAL_ACCOUNT_SMOKE=1.",
    );
  }
}

function resolveLoginWaitMs(env: NodeJS.ProcessEnv): number {
  const raw = env[XHS_SMOKE_LOGIN_WAIT_MS_ENV]?.trim();
  if (!raw) return DEFAULT_LOGIN_WAIT_MS;

  const value = Number(raw);
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > MAX_LOGIN_WAIT_MS
  ) {
    throw new XiaohongshuPrepareSmokeError(
      "INVALID_LOGIN_WAIT",
      `${XHS_SMOKE_LOGIN_WAIT_MS_ENV} must be an integer between 0 and ${MAX_LOGIN_WAIT_MS}.`,
    );
  }

  return value;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let value = 0; value < 256; value += 1) {
    let crc = value;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
    }
    table[value] = crc >>> 0;
  }
  return table;
}

const PNG_CRC_TABLE = crcTable();

function crc32(bytes: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc = PNG_CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function pngChunk(type: string, data: Buffer): Buffer {
  const typeBytes = Buffer.from(type, "ascii");
  const body = Buffer.concat([typeBytes, data]);
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.byteLength);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));
  return Buffer.concat([length, body, checksum]);
}

function createSmokePng(width = 1080, height = 1440): Buffer {
  const stride = width * 4 + 1;
  const raw = Buffer.alloc(stride * height);

  const palettes = [
    [91, 94, 247, 255],
    [124, 128, 255, 255],
    [240, 241, 255, 255],
  ] as const;

  for (let y = 0; y < height; y += 1) {
    const rowOffset = y * stride;
    raw[rowOffset] = 0;
    const palette = palettes[Math.min(2, Math.floor((y * 3) / height))]!;
    for (let x = 0; x < width; x += 1) {
      const offset = rowOffset + 1 + x * 4;
      raw[offset] = palette[0];
      raw[offset + 1] = palette[1];
      raw[offset + 2] = palette[2];
      raw[offset + 3] = palette[3];
    }
  }

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    pngChunk("IHDR", ihdr),
    pngChunk("IDAT", deflateSync(raw, { level: 9 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function safeRunId(input?: string): string {
  const value = input ?? randomUUID();
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw new Error("Smoke run id must be a bounded path-safe identifier.");
  }
  return value;
}

function createFixture(runDirectory: string): {
  readonly pack: ImageTextMaterialPack;
  readonly pathByAssetId: ReadonlyMap<string, string>;
} {
  const assetDirectory = resolve(runDirectory, "assets");
  mkdirSync(assetDirectory, { recursive: true });

  const assetId = "xhs-smoke-cover";
  const assetPath = resolve(assetDirectory, assetId + ".png");
  writeFileSync(assetPath, createSmokePng());

  const cover: ImageAssetReference = {
    kind: "image",
    assetId,
    uri: "asset://xhs-smoke/" + assetId,
    mimeType: "image/png",
    width: 1080,
    height: 1440,
  };

  const pack: ImageTextMaterialPack = {
    mode: "image_text",
    status: "ready",
    planId: "xhs-real-prepare-smoke-v1",
    copy: {
      title: "Agent Publisher 预发布烟测",
      body:
        "这是一条受控的真人预发布烟测内容，仅用于验证上传、填表与回读流程。烟测会停在发布审批前，不会执行最终发布。",
      tags: ["AgentPublisher", "预发布烟测"],
    },
    cover,
    images: [],
    design: null,
    warnings: [],
    degradations: [],
  };

  return {
    pack,
    pathByAssetId: new Map([[assetId, assetPath]]),
  };
}

function isSupportedExistingXhsPage(rawUrl: string): boolean {
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

function boundedFailureCode(error: { readonly code?: string } | null): string {
  return error?.code ?? "PREPUBLISH_BLOCKED";
}

export async function runXiaohongshuPrepareSmoke(
  options: RunXiaohongshuPrepareSmokeOptions = {},
): Promise<XiaohongshuPrepareSmokeResult> {
  const env = options.env ?? process.env;
  assertOptIn(env);
  const loginWaitMs = resolveLoginWaitMs(env);
  const root = resolve(
    options.rootDirectory ??
      env[XHS_SMOKE_DATA_ROOT_ENV] ??
      resolve("data", "smoke", "xiaohongshu-prepare"),
  );
  const runDirectory = resolve(root, safeRunId(options.runId));
  mkdirSync(runDirectory, { recursive: true });

  const fixture = createFixture(runDirectory);
  const browserProvider =
    options.browserProvider ?? new DockerCdpBrowserProvider({ env });

  const preflightSession = await browserProvider.acquire({});
  try {
    const currentUrl = preflightSession.page.url();
    if (
      currentUrl !== "about:blank" &&
      !isSupportedExistingXhsPage(currentUrl)
    ) {
      throw new XiaohongshuPrepareSmokeError(
        "UNSAFE_BROWSER_PAGE",
        "Refusing to navigate a persistent browser page outside creator.xiaohongshu.com. Open a disposable blank page or an existing Xiaohongshu publish page first.",
      );
    }
  } finally {
    await browserProvider.release(preflightSession.id);
  }

  const sleep =
    options.sleep ??
    ((milliseconds: number) =>
      new Promise<void>((resolveSleep) => setTimeout(resolveSleep, milliseconds)));
  const emit = options.onEvidence ?? (() => undefined);

  const application = createMvpPrepublishApplication({
    databasePath: resolve(runDirectory, "app.db"),
    browserProvider,
    materialSource: createControlledMaterialSource(async () => fixture.pack),
    resolveAssetPath: (asset) => {
      const expected = fixture.pack.cover;
      if (
        asset.assetId !== expected.assetId ||
        asset.uri !== expected.uri ||
        asset.mimeType !== expected.mimeType
      ) {
        throw new Error("Smoke attempted to resolve an unexpected asset reference.");
      }

      const filePath = fixture.pathByAssetId.get(asset.assetId);
      if (!filePath) {
        throw new Error("Controlled smoke asset is missing.");
      }
      return filePath;
    },
    xiaohongshu: {
      openEntry:
        options.xiaohongshu?.openEntry ??
        (async (page) => {
          const currentUrl = page.url();
          if (currentUrl === "about:blank") {
            return await openXiaohongshuPublishEntry(page, 8_000);
          }
          if (isSupportedExistingXhsPage(currentUrl)) {
            return await inspectXiaohongshuPublishEntry(page, 8_000);
          }
          throw new XiaohongshuPrepareSmokeError(
            "UNSAFE_BROWSER_PAGE",
            "Refusing to navigate a persistent browser page outside creator.xiaohongshu.com. Open a disposable blank page or an existing Xiaohongshu publish page first.",
          );
        }),
      inspectEntry:
        options.xiaohongshu?.inspectEntry ??
        ((page) => inspectXiaohongshuPublishEntry(page, 2_000)),
      ...(options.xiaohongshu?.preparePage === undefined
        ? {}
        : { preparePage: options.xiaohongshu.preparePage }),
      ...(options.xiaohongshu?.verifyPreparedPage === undefined
        ? {}
        : { verifyPreparedPage: options.xiaohongshu.verifyPreparedPage }),
    },
  });

  try {
    const created = await application.runtime.orchestrator.createJob({
      brief: "Controlled real-account Xiaohongshu prepare smoke.",
    });
    emit({
      smoke: "xiaohongshu-prepare",
      phase: "job_created",
      jobId: created.id,
      status: "created",
      actionType: null,
    });

    let result = await application.runtime.orchestrator.continueJob(created.id);
    const deadline = Date.now() + loginWaitMs;
    let loginNoticeEmitted = false;

    while (result.projection.status === "waiting_for_login") {
      if (result.error) {
        throw new XiaohongshuPrepareSmokeError(
          "SMOKE_BLOCKED",
          result.error.message,
          boundedFailureCode(result.error),
        );
      }

      if (!loginNoticeEmitted) {
        emit({
          smoke: "xiaohongshu-prepare",
          phase: "waiting_for_login",
          jobId: created.id,
          status: "waiting_for_login",
          actionType: "login_required",
        });
        loginNoticeEmitted = true;
      }

      if (Date.now() >= deadline) {
        throw new XiaohongshuPrepareSmokeError(
          "LOGIN_TIMEOUT",
          "Timed out waiting for Xiaohongshu login/verification. The browser was left unchanged so login can be completed in Live View before rerunning.",
        );
      }

      await sleep(Math.min(LOGIN_POLL_MS, Math.max(1, deadline - Date.now())));
      result = await application.runtime.orchestrator.continueJob(created.id);
    }

    if (result.error) {
      throw new XiaohongshuPrepareSmokeError(
        "SMOKE_BLOCKED",
        result.error.message,
        boundedFailureCode(result.error),
      );
    }

    if (result.projection.status !== "waiting_for_approval") {
      const actionType = result.projection.humanAction?.type;
      throw new XiaohongshuPrepareSmokeError(
        "UNEXPECTED_FINAL_STATE",
        actionType === "clarification_required"
          ? "Prepare stopped for human clarification. Inspect the current Creator composer and keep it unchanged until the recovery decision is made."
          : "Prepare smoke did not reach the durable approval boundary.",
        actionType ?? undefined,
      );
    }

    const approval =
      application.runtime.actionRequests.getCurrentOpenForJob(created.id);
    if (
      !approval ||
      approval.type !== "approval_required" ||
      approval.status !== "open"
    ) {
      throw new XiaohongshuPrepareSmokeError(
        "UNEXPECTED_FINAL_STATE",
        "waiting_for_approval is not backed by an open approval_required ActionRequest.",
      );
    }

    const summary = result.projection.approval;
    if (!summary) {
      throw new XiaohongshuPrepareSmokeError(
        "UNEXPECTED_FINAL_STATE",
        "Approval summary is missing from the bounded product projection.",
      );
    }

    const evidence: XiaohongshuPrepareSmokeEvidence = {
      smoke: "xiaohongshu-prepare",
      phase: "waiting_for_approval",
      jobId: created.id,
      status: "waiting_for_approval",
      actionType: "approval_required",
      title: summary.title,
      bodyLength: summary.bodyLength,
      imageCount: summary.imageCount,
    };
    emit(evidence);

    return { evidence, runDirectory };
  } finally {
    await application.stop();
  }
}
