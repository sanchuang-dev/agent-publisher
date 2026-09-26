import { mkdtempSync, rmSync } from "node:fs";
import { get } from "node:http";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";

import type {
  BrowserProvider,
  BrowserProviderHealth,
  BrowserSession,
} from "../src/browser/provider.js";
import type { PublishingSecretaryExecutionInput } from "../src/agent/publishing-secretary-contract.js";
import {
  createMvpPrepublishApplication,
  type MvpPrepublishApplication,
} from "../src/app/mvp-prepublish-application.js";
import {
  PrepublishMaterialResolutionError,
  createControlledMaterialSource,
} from "../src/app/prepublish-material-source.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
  type PreparedImageTextPublication,
} from "../src/platforms/xiaohongshu/image-text-prepare.js";
import type { XiaohongshuEntryState } from "../src/platforms/xiaohongshu/login-entry.js";
import { createImageTextMaterialPackFixture } from "../src/materials/testing/fake-providers.js";

interface TestSseClient {
  readonly chunks: string[];
  readonly closed: Promise<void>;
  disconnect(): void;
}

class FakeBrowserProvider implements BrowserProvider {
  readonly session: BrowserSession = {
    id: "app-02-browser-session",
    profileRef: "app-02-profile",
    page: {} as BrowserSession["page"],
    liveView: { url: "http://127.0.0.1:6080" },
  };

  acquireCalls = 0;
  releaseCalls = 0;

  async acquire(): Promise<BrowserSession> {
    this.acquireCalls += 1;
    return this.session;
  }

  async release(sessionId: string): Promise<void> {
    expect(sessionId).toBe(this.session.id);
    this.releaseCalls += 1;
  }

  async health(): Promise<BrowserProviderHealth> {
    return { status: "reachable" };
  }

  async resolveAutomationAttachment(sessionId: string) {
    expect(sessionId).toBe(this.session.id);
    return {
      sessionId,
      cdpEndpoint:
        "ws://browser-runtime:9222/devtools/browser/app-02-observability",
    };
  }
}

function makeTempDatabase(): { readonly root: string; readonly path: string } {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-app-02-"));
  return { root, path: join(root, "app.db") };
}

function preparedFixture(): {
  readonly pack: ReturnType<typeof createImageTextMaterialPackFixture>;
  readonly prepared: PreparedImageTextPublication;
} {
  const pack = createImageTextMaterialPackFixture();
  const imageAssetIds = [
    ...new Set([pack.cover, ...pack.images].map((asset) => asset.assetId)),
  ];

  return {
    pack,
    prepared: {
      platform: "xiaohongshu",
      mode: "image_text",
      planId: pack.planId,
      title: pack.copy.title,
      bodyLength: pack.copy.body.length,
      tags: pack.copy.tags,
      imageAssetIds,
      imageCount: imageAssetIds.length,
      contentFingerprint:
        fingerprintXiaohongshuImageTextMaterialPack(pack),
      verifiedAt: "2026-09-20T10:00:00.000Z",
    },
  };
}

function createTestApplication(input: {
  readonly databasePath: string;
  readonly browser: FakeBrowserProvider;
  readonly state: { value: XiaohongshuEntryState };
}): MvpPrepublishApplication {
  const { pack, prepared } = preparedFixture();

  return createMvpPrepublishApplication({
    databasePath: input.databasePath,
    browserProvider: input.browser,
    browserLiveViewUrl: "http://127.0.0.1:6080",
    materialSource: createControlledMaterialSource(async () => pack),
    resolveAssetPath: (asset) => "/controlled-assets/" + asset.assetId + ".png",
    xiaohongshu: {
      openEntry: async () => input.state.value,
      inspectEntry: async () => input.state.value,
      preparePage: async (prepareInput) => {
        await prepareInput.onMutationStarted?.();
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
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = 1_500,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;

  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for APP-02 test state");
    }

    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function connectSse(url: string): Promise<TestSseClient> {
  return new Promise((resolve, reject) => {
    const request = get(url, (response) => {
      response.setEncoding("utf8");
      response.once("error", reject);

      const chunks: string[] = [];
      const closed = new Promise<void>((resolveClosed) => {
        response.once("close", resolveClosed);
      });

      response.on("data", (chunk) => {
        chunks.push(String(chunk));
      });

      response.once("data", () => {
        resolve({
          chunks,
          closed,
          disconnect: () => response.destroy(),
        });
      });
    });

    request.once("error", reject);
  });
}

describe("APP-02 real Job API and Xiaohongshu pre-publish orchestration", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  test("real HTTP/SSE flow pauses for login, resumes, prepares, and stops at approval", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "login_required" },
    };
    const application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });
    const origin = await application.start({ host: "127.0.0.1", port: 0 });

    try {
      const createResponse = await fetch(origin + "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: "请写一个与受控烟测素材不同的任意 brief",
          platform: "xiaohongshu",
          publishMode: "image_text",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        job: {
          id: string;
          status: string;
          material: {
            source: string;
            generatedFromBrief: boolean;
            title: string;
          } | null;
        };
      };

      expect(created.job).toMatchObject({
        status: "created",
        material: null,
      });

      const jobId = created.job.id;

      const getResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId),
      );
      expect(getResponse.status).toBe(200);
      const loaded = (await getResponse.json()) as {
        job: {
          id: string;
          status: string;
          material: { source: string; generatedFromBrief: boolean } | null;
        };
      };
      expect(loaded.job).toMatchObject({
        id: jobId,
        status: "created",
        material: null,
      });

      const sse = await connectSse(
        origin + "/api/jobs/" + encodeURIComponent(jobId) + "/events",
      );

      const firstRunResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId) + "/continue",
        { method: "POST" },
      );
      expect(firstRunResponse.status).toBe(200);
      const firstRun = (await firstRunResponse.json()) as {
        job: {
          status: string;
          humanAction: { id: string; type: string } | null;
          liveView: { mode: string; controlOwner: string } | null;
        };
        run: { blocked: boolean; error: unknown };
      };

      expect(firstRun).toMatchObject({
        job: {
          status: "waiting_for_login",
          humanAction: { type: "login_required" },
          liveView: { mode: "runtime", controlOwner: "human" },
        },
        run: { blocked: true, error: null },
      });

      await waitFor(() =>
        sse.chunks.join("").includes('"status":"waiting_for_login"'),
      );

      const loginActionId = firstRun.job.humanAction!.id;
      expect(application.runtime.actionRequests.getById(loginActionId)).toMatchObject({
        status: "open",
        type: "login_required",
      });

      state.value = { kind: "authenticated" };

      const secondRunResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId) + "/continue",
        { method: "POST" },
      );
      expect(secondRunResponse.status).toBe(200);
      const secondRun = (await secondRunResponse.json()) as {
        job: {
          status: string;
          humanAction: { id: string; type: string } | null;
          approval: {
            title: string;
            imageCount: number;
          } | null;
        };
        run: { blocked: boolean; error: unknown };
      };

      expect(secondRun).toMatchObject({
        job: {
          status: "waiting_for_approval",
          humanAction: { type: "approval_required" },
          approval: {
            title: "把发布工作交给 AI 员工",
            imageCount: 3,
          },
        },
        run: { blocked: true, error: null },
      });

      expect(application.runtime.actionRequests.getById(loginActionId)).toMatchObject({
        status: "resolved",
        type: "login_required",
      });
      expect(application.runtime.jobs.getById(jobId)?.materialSummaryJson).toBeNull();

      await waitFor(() =>
        sse.chunks.join("").includes('"status":"waiting_for_approval"'),
      );

      const eventStream = sse.chunks.join("");
      const createdIndex = eventStream.indexOf('"status":"created"');
      const materialIndex = eventStream.indexOf('"status":"preparing_materials"');
      const publishPrepIndex = eventStream.indexOf('"status":"preparing_publish"');
      const loginIndex = eventStream.indexOf('"status":"waiting_for_login"');
      const approvalIndex = eventStream.indexOf('"status":"waiting_for_approval"');

      expect(createdIndex).toBeGreaterThanOrEqual(0);
      expect(materialIndex).toBeGreaterThan(createdIndex);
      expect(publishPrepIndex).toBeGreaterThan(materialIndex);
      expect(loginIndex).toBeGreaterThan(publishPrepIndex);
      expect(approvalIndex).toBeGreaterThan(loginIndex);

      const thirdRunResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId) + "/continue",
        { method: "POST" },
      );
      const thirdRun = (await thirdRunResponse.json()) as {
        job: { status: string; humanAction: { id: string } | null };
      };

      expect(thirdRun.job.status).toBe("waiting_for_approval");
      expect(thirdRun.job.humanAction?.id).toBe(
        secondRun.job.humanAction?.id,
      );
      expect(application.runtime.jobs.getById(jobId)?.status).not.toBe(
        "publishing",
      );
      expect(browser.acquireCalls).toBe(2);
      expect(browser.releaseCalls).toBe(2);

      sse.disconnect();
      await sse.closed;
    } finally {
      await application.stop();
    }
  });

  test("restart reuses the durable login pause instead of creating a second workflow", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "login_required" },
    };

    let application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });

    const created = await application.runtime.orchestrator.createJob({
      brief: "restart smoke",
    });
    const first = await application.runtime.orchestrator.continueJob(created.id);
    expect(first.projection).toMatchObject({
      status: "waiting_for_login",
      humanAction: { type: "login_required" },
    });
    const firstActionId = first.projection.humanAction!.id;
    await application.stop();

    application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });

    try {
      const resumed = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(resumed.projection).toMatchObject({
        status: "waiting_for_login",
        humanAction: {
          id: firstActionId,
          type: "login_required",
        },
      });
      expect(
        application.runtime.actionRequests.getCurrentOpenForJob(created.id),
      ).toMatchObject({
        id: firstActionId,
        type: "login_required",
        status: "open",
      });
    } finally {
      await application.stop();
    }
  });

  test("browser cleanup failure cannot overwrite a committed approval pause", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);

    class ReleaseFailingBrowserProvider extends FakeBrowserProvider {
      override async release(): Promise<void> {
        this.releaseCalls += 1;
        throw new Error("fixture cleanup failure");
      }
    }

    const browser = new ReleaseFailingBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "authenticated" },
    };
    const application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });
    const warning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined as never);

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "cleanup failure must not rewrite durable truth",
      });
      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(result).toMatchObject({
        projection: {
          status: "waiting_for_approval",
          humanAction: { type: "approval_required" },
        },
        blocked: true,
        error: null,
      });
      expect(application.runtime.jobs.getById(created.id)).toMatchObject({
        status: "waiting_for_approval",
      });
      expect(warning).toHaveBeenCalledWith(
        "Browser session cleanup failed after durable APP-02 state was committed.",
        { code: "APP_BROWSER_RELEASE_FAILED" },
      );
    } finally {
      warning.mockRestore();
      await application.stop();
    }
  });

  test("streams bounded Publishing Secretary progress over SSE before the run finishes", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const { pack } = preparedFixture();
    let releaseRun!: () => void;
    let markEntered!: () => void;
    const entered = new Promise<void>((resolve) => {
      markEntered = resolve;
    });
    const released = new Promise<void>((resolve) => {
      releaseRun = resolve;
    });
    const execute = vi.fn(async (input: PublishingSecretaryExecutionInput) => {
      input.onProgress?.({ stage: "observing", status: "running" });
      input.onProgress?.({ stage: "navigating", status: "running" });
      input.onProgress?.({ stage: "finding", status: "running" });
      input.onProgress?.({ stage: "acting", status: "running" });
      input.onProgress?.({ stage: "filling", status: "running" });
      input.onProgress?.({ stage: "uploading", status: "running" });
      input.onProgress?.({ stage: "waiting", status: "running" });
      markEntered();
      await released;
      input.onProgress?.({ stage: "waiting", status: "succeeded" });
      return {
        kind: "progress" as const,
        summary: "bounded progress fixture",
        semanticMilestone: "creator_observed",
        identitySurface: null,
        browserToolCalls: 7,
      };
    });
    const application = createMvpPrepublishApplication({
      databasePath: temp.path,
      browserProvider: browser,
      browserLiveViewUrl:
        "/browser-live-view/vnc.html?path=browser-live-view/websockify",
      publishingSecretary: { execute },
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) =>
        "/controlled-assets/" + asset.assetId + ".png",
    });
    const origin = await application.start({ host: "127.0.0.1", port: 0 });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "observe the live Publishing Secretary run",
      });
      const sse = await connectSse(
        origin + "/api/jobs/" + encodeURIComponent(created.id) + "/events",
      );
      let continueSettled = false;
      const continuation = fetch(
        origin + "/api/jobs/" + encodeURIComponent(created.id) + "/continue",
        { method: "POST" },
      ).finally(() => {
        continueSettled = true;
      });

      await entered;
      await waitFor(() => {
        const stream = sse.chunks.join("");
        return (
          stream.includes('"stepKey":"publishing_secretary_observing"') &&
          stream.includes('"stepKey":"publishing_secretary_uploading"') &&
          stream.includes('"stepKey":"publishing_secretary_waiting"') &&
          stream.includes('"controlOwner":"agent"') &&
          stream.includes(
            '"url":"/browser-live-view/vnc.html?path=browser-live-view/websockify"',
          )
        );
      });

      expect(continueSettled).toBe(false);
      const inFlightStream = sse.chunks.join("");
      for (const stepKey of [
        "publishing_secretary_observing",
        "publishing_secretary_navigating",
        "publishing_secretary_finding",
        "publishing_secretary_acting",
        "publishing_secretary_filling",
        "publishing_secretary_uploading",
        "publishing_secretary_waiting",
      ]) {
        expect(inFlightStream).toContain(`"stepKey":"${stepKey}"`);
      }
      expect(inFlightStream).not.toContain("browser-runtime:9222");
      expect(inFlightStream).not.toContain("devtools/browser");

      releaseRun();
      const response = await continuation;
      expect(response.status).toBe(200);
      expect(execute).toHaveBeenCalledOnce();

      sse.disconnect();
      await sse.closed;
    } finally {
      releaseRun();
      await application.stop();
    }
  });

  test("progress projection failure stays observational and does not block browser execution", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const { pack } = preparedFixture();
    const execute = vi.fn(async () => ({
      kind: "progress" as const,
      summary: "execution survived observer failure",
      semanticMilestone: "creator_observed",
      identitySurface: null,
      browserToolCalls: 1,
    }));
    const application = createMvpPrepublishApplication({
      databasePath: temp.path,
      browserProvider: browser,
      browserLiveViewUrl: "/browser-live-view/vnc.html",
      publishingSecretary: { execute },
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) =>
        "/controlled-assets/" + asset.assetId + ".png",
    });
    const originalCommit =
      application.runtime.jobs.commitCheckpoint.bind(application.runtime.jobs);
    const warning = vi.spyOn(process, "emitWarning").mockImplementation(() => {});
    vi.spyOn(application.runtime.jobs, "commitCheckpoint").mockImplementation(
      (jobId, input) => {
        if (input.checkpoint.phase === "publishing_secretary_running") {
          throw new Error("fixture projection storage failure");
        }
        return originalCommit(jobId, input);
      },
    );

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "observer failure must not seize control",
      });
      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(execute).toHaveBeenCalledOnce();
      expect(result.error).toBeNull();
      expect(result.projection).toMatchObject({
        status: "preparing_publish",
        phase: "publishing_secretary_progress",
      });
      expect(warning).toHaveBeenCalledWith(
        "Publishing Secretary progress could not be projected; browser execution continues.",
        { code: "APP_PUBLISHING_PROGRESS_OBSERVER_FAILED" },
      );
    } finally {
      warning.mockRestore();
      await application.stop();
    }
  });

  test("sensitive Live View URLs are never projected to the Web boundary", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "login_required" },
    };
    const { pack, prepared } = preparedFixture();

    const application = createMvpPrepublishApplication({
      databasePath: temp.path,
      browserProvider: browser,
      browserLiveViewUrl: "http://127.0.0.1:6080/vnc.html#token=secret",
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) =>
        "/controlled-assets/" + asset.assetId + ".png",
      xiaohongshu: {
        openEntry: async () => state.value,
        inspectEntry: async () => state.value,
        preparePage: async (prepareInput) => {
          await prepareInput.onMutationStarted?.();
          return prepared;
        },
      },
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "live view secret boundary",
      });
      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(result.projection).toMatchObject({
        status: "waiting_for_login",
        liveView: {
          mode: "unavailable",
          url: null,
          controlOwner: "human",
        },
      });
      const serializedProjection = JSON.stringify(result.projection);
      expect(serializedProjection).not.toContain("token=secret");
      expect(serializedProjection).not.toContain(
        "http://127.0.0.1:6080/vnc.html#token=secret",
      );
    } finally {
      await application.stop();
    }
  });

  test("material source runs only after the durable Job exists", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "authenticated" },
    };
    const { pack, prepared } = preparedFixture();
    let application!: MvpPrepublishApplication;
    let observedDurableJob = false;

    application = createMvpPrepublishApplication({
      databasePath: temp.path,
      browserProvider: browser,
      browserLiveViewUrl: "http://127.0.0.1:6080",
      materialSource: createControlledMaterialSource(async ({ jobId }) => {
        observedDurableJob = application.runtime.jobs.getById(jobId) !== null;
        return pack;
      }),
      resolveAssetPath: (asset) =>
        "/controlled-assets/" + asset.assetId + ".png",
      xiaohongshu: {
        openEntry: async () => state.value,
        inspectEntry: async () => state.value,
        preparePage: async (prepareInput) => {
          await prepareInput.onMutationStarted?.();
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

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "provider seam needs a durable job",
      });

      expect(application.runtime.jobs.getById(created.id)).not.toBeNull();
      expect(observedDurableJob).toBe(false);

      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(observedDurableJob).toBe(true);
      expect(result.projection.status).toBe("waiting_for_approval");
      expect(result.projection.material).toMatchObject({
        source: "controlled_smoke",
        generatedFromBrief: false,
      });
      expect(application.runtime.jobs.getById(created.id)?.materialSummaryJson).toBeNull();
    } finally {
      await application.stop();
    }
  });

  test("retryable material source failure stays resumable instead of terminally failing the Job", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "authenticated" },
    };
    const { pack, prepared } = preparedFixture();
    let materialAttempts = 0;

    const application = createMvpPrepublishApplication({
      databasePath: temp.path,
      browserProvider: browser,
      browserLiveViewUrl: "http://127.0.0.1:6080",
      materialSource: {
        async resolve() {
          materialAttempts += 1;
          if (materialAttempts === 1) {
            throw new PrepublishMaterialResolutionError(
              "MATERIAL_PROVIDER_UNAVAILABLE",
              true,
              "fixture provider is temporarily unavailable",
            );
          }
          return {
            source: "provider_pipeline",
            generatedFromBrief: true,
            pack,
          };
        },
      },
      resolveAssetPath: (asset) =>
        "/controlled-assets/" + asset.assetId + ".png",
      xiaohongshu: {
        openEntry: async () => state.value,
        inspectEntry: async () => state.value,
        preparePage: async (prepareInput) => {
          await prepareInput.onMutationStarted?.();
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

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "retryable material source",
      });

      const first = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(first).toMatchObject({
        blocked: true,
        error: { code: "MATERIAL_SOURCE_UNAVAILABLE" },
        projection: {
          status: "created",
        },
      });
      expect(application.runtime.jobs.getById(created.id)?.status).toBe(
        "created",
      );
      expect(application.runtime.jobs.getById(created.id)?.status).not.toBe(
        "failed",
      );

      const second = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(second).toMatchObject({
        blocked: true,
        error: null,
        projection: {
          status: "waiting_for_approval",
          material: {
            source: "provider_pipeline",
            generatedFromBrief: true,
          },
        },
      });
      expect(materialAttempts).toBe(2);
    } finally {
      await application.stop();
    }
  });

  test("browser acquisition failure is durable and remains visible after reread", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);

    class UnavailableBrowserProvider extends FakeBrowserProvider {
      override async acquire(): Promise<BrowserSession> {
        this.acquireCalls += 1;
        throw new Error("fixture browser unavailable");
      }
    }

    const browser = new UnavailableBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "authenticated" },
    };
    const application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "browser outage must survive refresh",
      });
      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(result).toMatchObject({
        blocked: true,
        error: {
          code: "BROWSER_UNAVAILABLE",
          message: "The controlled browser runtime is currently unavailable.",
        },
        projection: {
          status: "preparing_publish",
          currentStep: "acquire_browser",
          failure: {
            step: "acquire_browser",
            code: "BROWSER_UNAVAILABLE",
          },
        },
      });

      const reread = application.runtime.orchestrator.getJob(created.id);
      expect(reread).toMatchObject({
        status: "preparing_publish",
        currentStep: "acquire_browser",
        failure: {
          step: "acquire_browser",
          code: "BROWSER_UNAVAILABLE",
        },
      });
    } finally {
      await application.stop();
    }
  });

  test("API rejects unsupported modes and exposes no final-publish route", async () => {
    const temp = makeTempDatabase();
    cleanupRoots.push(temp.root);
    const browser = new FakeBrowserProvider();
    const state: { value: XiaohongshuEntryState } = {
      value: { kind: "authenticated" },
    };
    const application = createTestApplication({
      databasePath: temp.path,
      browser,
      state,
    });

    try {
      const video = await application.server.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          brief: "video is outside APP-02",
          platform: "xiaohongshu",
          publishMode: "video",
        },
      });
      expect(video.statusCode).toBe(400);

      const created = await application.server.inject({
        method: "POST",
        url: "/api/jobs",
        payload: {
          brief: "bounded API smoke",
          platform: "xiaohongshu",
          publishMode: "image_text",
        },
      });
      expect(created.statusCode).toBe(201);
      const jobId = created.json().job.id as string;

      const publish = await application.server.inject({
        method: "POST",
        url: "/api/jobs/" + jobId + "/publish",
      });
      expect(publish.statusCode).toBe(404);

      const approval = await application.server.inject({
        method: "POST",
        url: "/api/jobs/" + jobId + "/approval",
        payload: { approved: true },
      });
      expect(approval.statusCode).toBe(404);

      const run = await application.server.inject({
        method: "POST",
        url: "/api/jobs/" + jobId + "/continue",
      });
      expect(run.statusCode).toBe(200);
      expect(run.json().job.status).toBe("waiting_for_approval");
      expect(application.runtime.jobs.getById(jobId)?.status).not.toBe(
        "publishing",
      );
    } finally {
      await application.stop();
    }
  });
});
