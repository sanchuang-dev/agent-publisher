import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type {
  BrowserProvider,
  BrowserSession,
} from "../src/browser/provider.js";
import type { ImageTextMaterialPack, MaterialPack } from "../src/materials/contracts.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
  XiaohongshuComposerNotFreshError,
  type PrepareXiaohongshuPublicationInput,
} from "../src/platforms/xiaohongshu/image-text-prepare.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import {
  runXiaohongshuPrepareSmoke,
  XiaohongshuPrepareSmokeError,
  type XiaohongshuPrepareSmokeEvidence,
} from "../src/smoke/xiaohongshu-prepare-smoke.js";

class FakeBrowserProvider implements BrowserProvider {
  acquireCalls = 0;
  releaseCalls = 0;
  readonly #profiles: readonly string[];
  readonly #pageUrl: string;

  constructor(
    profiles: readonly string[] = ["smoke-profile"],
    pageUrl = "about:blank",
  ) {
    this.#profiles = profiles;
    this.#pageUrl = pageUrl;
  }

  async acquire(): Promise<BrowserSession> {
    const profile =
      this.#profiles[Math.min(this.acquireCalls, this.#profiles.length - 1)]!;
    this.acquireCalls += 1;
    return {
      id: "smoke-session-" + this.acquireCalls,
      profileRef: profile,
      page: {
        url: () => this.#pageUrl,
      } as BrowserSession["page"],
    };
  }

  async release(): Promise<void> {
    this.releaseCalls += 1;
  }

  async health() {
    return { status: "reachable" as const };
  }
}

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
  }
});

function tempRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-xhs-smoke-test-"));
  cleanupRoots.push(root);
  return root;
}

function imageTextPack(pack: MaterialPack): ImageTextMaterialPack {
  if (pack.mode !== "image_text") {
    throw new Error("XHS-03 test fixture only supports image_text.");
  }
  return pack;
}

function preparedFromInput(input: PrepareXiaohongshuPublicationInput) {
  const pack = imageTextPack(input.materialPack);
  const imageAssetIds = [
    ...new Set([pack.cover, ...pack.images].map((asset) => asset.assetId)),
  ];

  return {
    platform: "xiaohongshu" as const,
    mode: "image_text" as const,
    planId: pack.planId,
    title: pack.copy.title,
    bodyLength: pack.copy.body.length,
    tags: pack.copy.tags,
    imageAssetIds,
    imageCount: imageAssetIds.length,
    contentFingerprint:
      fingerprintXiaohongshuImageTextMaterialPack(pack),
    verifiedAt: "2026-09-21T00:00:00.000Z",
  };
}

function successfulXhsOverrides() {
  return {
    openEntry: async () => ({ kind: "authenticated" as const }),
    inspectEntry: async () => ({ kind: "authenticated" as const }),
    preparePage: async (input: PrepareXiaohongshuPublicationInput) => {
      await input.onMutationStarted?.();
      return preparedFromInput(input);
    },
    verifyPreparedPage: async (input: {
      readonly materialPack: PrepareXiaohongshuPublicationInput["materialPack"];
    }) => {
      const pack = imageTextPack(input.materialPack);
      return {
        title: pack.copy.title,
        bodyLength: pack.copy.body.length,
        tags: pack.copy.tags,
        imageCount: new Set([
          pack.cover.assetId,
          ...pack.images.map((asset) => asset.assetId),
        ]).size,
      };
    },
  };
}

describe("XHS-03 real prepare smoke harness", () => {
  test("refuses to acquire the real browser without explicit opt-in", async () => {
    const browser = new FakeBrowserProvider();

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {},
        browserProvider: browser,
        rootDirectory: tempRoot(),
        runId: "no-opt-in",
      }),
    ).rejects.toMatchObject({
      code: "OPT_IN_REQUIRED",
    });

    expect(browser.acquireCalls).toBe(0);
  });

  test("reaches a durable approval pause without creating a publish external action", async () => {
    const browser = new FakeBrowserProvider();
    const root = tempRoot();
    const evidence: XiaohongshuPrepareSmokeEvidence[] = [];

    const result = await runXiaohongshuPrepareSmoke({
      env: {
        XHS_REAL_ACCOUNT_SMOKE: "1",
        XHS_SMOKE_LOGIN_WAIT_MS: "1000",
      },
      browserProvider: browser,
      rootDirectory: root,
      runId: "success",
      onEvidence: (item) => evidence.push(item),
      xiaohongshu: successfulXhsOverrides(),
    });

    expect(result.evidence).toMatchObject({
      phase: "waiting_for_approval",
      status: "waiting_for_approval",
      actionType: "approval_required",
      title: "Agent Publisher 预发布烟测",
      imageCount: 1,
    });
    expect(evidence.map((item) => item.phase)).toEqual([
      "job_created",
      "waiting_for_approval",
    ]);

    const db = openDatabase({
      databasePath: join(result.runDirectory, "app.db"),
    });
    try {
      const actions = new ActionRequestRepository(db);
      expect(
        actions.getCurrentOpenForJob(result.evidence.jobId),
      ).toMatchObject({
        type: "approval_required",
        status: "open",
      });

      const row = db
        .prepare("SELECT COUNT(*) AS count FROM external_actions")
        .get() as { count: number };
      expect(row.count).toBe(0);
    } finally {
      db.close();
    }
  });

  test("waits for human login and resumes on the same persistent profile", async () => {
    const browser = new FakeBrowserProvider(["shared-profile"]);
    const evidence: XiaohongshuPrepareSmokeEvidence[] = [];
    let inspectCalls = 0;

    const result = await runXiaohongshuPrepareSmoke({
      env: {
        XHS_REAL_ACCOUNT_SMOKE: "1",
        XHS_SMOKE_LOGIN_WAIT_MS: "1000",
      },
      browserProvider: browser,
      rootDirectory: tempRoot(),
      runId: "login-resume",
      sleep: async () => undefined,
      onEvidence: (item) => evidence.push(item),
      xiaohongshu: {
        ...successfulXhsOverrides(),
        openEntry: async () => ({ kind: "login_required" as const }),
        inspectEntry: async () => {
          inspectCalls += 1;
          return inspectCalls === 1
            ? { kind: "login_required" as const }
            : { kind: "authenticated" as const };
        },
      },
    });

    expect(result.evidence.status).toBe("waiting_for_approval");
    expect(evidence.map((item) => item.phase)).toEqual([
      "job_created",
      "waiting_for_login",
      "waiting_for_approval",
    ]);
    expect(browser.acquireCalls).toBeGreaterThanOrEqual(4);
    expect(browser.releaseCalls).toBe(browser.acquireCalls);
  });

  test("profile mismatch during human takeover fails before prepare mutation", async () => {
    const browser = new FakeBrowserProvider([
      "profile-a",
      "profile-a",
      "profile-b",
    ]);
    let prepareCalls = 0;

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {
          XHS_REAL_ACCOUNT_SMOKE: "1",
          XHS_SMOKE_LOGIN_WAIT_MS: "1000",
        },
        browserProvider: browser,
        rootDirectory: tempRoot(),
        runId: "profile-mismatch",
        sleep: async () => undefined,
        xiaohongshu: {
          ...successfulXhsOverrides(),
          openEntry: async () => ({ kind: "login_required" as const }),
          inspectEntry: async () => ({ kind: "authenticated" as const }),
          preparePage: async (input) => {
            prepareCalls += 1;
            await input.onMutationStarted?.();
            return preparedFromInput(input);
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "SMOKE_BLOCKED",
      detailCode: "LOGIN_REQUIRED",
    });

    expect(prepareCalls).toBe(0);
  });

  test("dirty composer fails closed before the mutation checkpoint", async () => {
    let mutationStarted = false;

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {
          XHS_REAL_ACCOUNT_SMOKE: "1",
          XHS_SMOKE_LOGIN_WAIT_MS: "1000",
        },
        browserProvider: new FakeBrowserProvider(),
        rootDirectory: tempRoot(),
        runId: "dirty-composer",
        xiaohongshu: {
          ...successfulXhsOverrides(),
          preparePage: async (input) => {
            mutationStarted = false;
            throw new XiaohongshuComposerNotFreshError(
              "fixture composer contains existing content",
            );
          },
        },
      }),
    ).rejects.toMatchObject({
      code: "SMOKE_BLOCKED",
      detailCode: "COMPOSER_NOT_FRESH",
    });

    expect(mutationStarted).toBe(false);
  });

  test("refuses to navigate an unrelated persistent browser page", async () => {
    const browser = new FakeBrowserProvider(
      ["smoke-profile"],
      "https://example.com/unrelated",
    );

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {
          XHS_REAL_ACCOUNT_SMOKE: "1",
          XHS_SMOKE_LOGIN_WAIT_MS: "1000",
        },
        browserProvider: browser,
        rootDirectory: tempRoot(),
        runId: "unsafe-page",
      }),
    ).rejects.toMatchObject({
      code: "UNSAFE_BROWSER_PAGE",
    });

    expect(browser.acquireCalls).toBe(1);
    expect(browser.releaseCalls).toBe(1);
  });

  test("refuses a same-origin Creator page outside the accepted publish path", async () => {
    const browser = new FakeBrowserProvider(
      ["smoke-profile"],
      "https://creator.xiaohongshu.com/dashboard",
    );

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {
          XHS_REAL_ACCOUNT_SMOKE: "1",
          XHS_SMOKE_LOGIN_WAIT_MS: "1000",
        },
        browserProvider: browser,
        rootDirectory: tempRoot(),
        runId: "unsafe-creator-dashboard",
      }),
    ).rejects.toMatchObject({
      code: "UNSAFE_BROWSER_PAGE",
    });

    expect(browser.acquireCalls).toBe(1);
    expect(browser.releaseCalls).toBe(1);
  });

  test("rejects an unsafe login wait configuration before browser acquisition", async () => {
    const browser = new FakeBrowserProvider();

    await expect(
      runXiaohongshuPrepareSmoke({
        env: {
          XHS_REAL_ACCOUNT_SMOKE: "1",
          XHS_SMOKE_LOGIN_WAIT_MS: "9999999",
        },
        browserProvider: browser,
        rootDirectory: tempRoot(),
        runId: "bad-timeout",
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPrepareSmokeError);

    expect(browser.acquireCalls).toBe(0);
  });
});
