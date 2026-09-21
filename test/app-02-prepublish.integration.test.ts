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
  failAcquire = false;

  async acquire(): Promise<BrowserSession> {
    this.acquireCalls += 1;
    if (this.failAcquire) {
      throw new Error("fixture browser unavailable");
    }
    return this.session;
  }

  async release(sessionId: string): Promise<void> {
    expect(sessionId).toBe(this.session.id);
    this.releaseCalls += 1;
  }

  async health(): Promise<BrowserProviderHealth> {
    return { status: "reachable" };
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
      publishPage: async ({ onMutationStarted }) => {
        await onMutationStarted?.();
      },
      verifyPublishResult: async () => ({
        kind: "published",
        resultUrl: "https://www.xiaohongshu.com/explore/app02pub123",
        contentId: "app02pub123",
        confirmationRef: "xhs-result-page",
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

  test("resolved approval survives browser acquisition failure and resumes without re-approval", async () => {
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
      const created = await application.runtime.orchestrator.createJob({
        brief: "approval must survive temporary browser loss",
      });

      const prepared = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(prepared.projection.status).toBe("waiting_for_approval");
      const approvalId = prepared.projection.humanAction?.id;
      expect(approvalId).toBeTruthy();

      const approved = application.runtime.orchestrator.resolveApproval(
        approvalId!,
        true,
      );
      expect(approved).toMatchObject({
        status: "publishing",
        needsHuman: false,
      });
      expect(
        application.runtime.externalActions.getByKey(
          created.id,
          "publish:xiaohongshu:final",
        ),
      ).toMatchObject({
        status: "prepared",
      });

      browser.failAcquire = true;
      const blocked = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(blocked).toMatchObject({
        blocked: true,
        error: { code: "BROWSER_UNAVAILABLE" },
        projection: {
          status: "publishing",
          needsHuman: false,
        },
      });
      expect(
        application.runtime.externalActions.getByKey(
          created.id,
          "publish:xiaohongshu:final",
        )?.status,
      ).toBe("prepared");
      expect(application.runtime.evidence.getByJob(created.id)).toEqual([]);

      browser.failAcquire = false;
      const resumed = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(resumed).toMatchObject({
        blocked: false,
        error: null,
        projection: { status: "succeeded" },
      });
      expect(
        application.runtime.externalActions.getByKey(
          created.id,
          "publish:xiaohongshu:final",
        )?.status,
      ).toBe("succeeded");
      expect(application.runtime.evidence.getByJob(created.id)).toHaveLength(3);
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

  test("API rejects unsupported modes, exposes no direct publish route, and binds approval to continue", async () => {
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

      const approvalActionId = run.json().job.humanAction.id as string;
      const negativeResolve = await application.server.inject({
        method: "POST",
        url: "/api/actions/" + approvalActionId + "/resolve",
        payload: { approved: false },
      });
      expect(negativeResolve.statusCode).toBe(400);
      expect(
        application.runtime.actionRequests.getById(approvalActionId)?.status,
      ).toBe("open");

      const resolve = await application.server.inject({
        method: "POST",
        url: "/api/actions/" + approvalActionId + "/resolve",
        payload: { approved: true },
      });
      expect(resolve.statusCode).toBe(200);
      expect(resolve.json().job).toMatchObject({
        status: "publishing",
        needsHuman: false,
      });

      const publishOnce = await application.server.inject({
        method: "POST",
        url: "/api/jobs/" + jobId + "/continue",
      });
      expect(publishOnce.statusCode).toBe(200);
      expect(publishOnce.json().job).toMatchObject({
        status: "succeeded",
        needsHuman: false,
      });
      expect(publishOnce.json().job.evidence).toHaveLength(3);
      expect(
        application.runtime.externalActions.getByKey(
          jobId,
          "publish:xiaohongshu:final",
        )?.status,
      ).toBe("succeeded");
      expect(application.runtime.evidence.getByJob(jobId)).toHaveLength(3);
    } finally {
      await application.stop();
    }
  });
});
