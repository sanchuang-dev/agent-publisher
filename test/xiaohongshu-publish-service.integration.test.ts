import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { BrowserSession } from "../src/browser/provider.js";
import { JobControlService } from "../src/jobs/job-control-service.js";
import {
  XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
  XiaohongshuPublishApprovalError,
  XiaohongshuPublishService,
  XiaohongshuPublishUnknownError,
} from "../src/platforms/xiaohongshu/publish-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { EvidenceRepository } from "../src/storage/evidence-repository.js";
import { ExternalActionRepository } from "../src/storage/external-action-repository.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-publish-once-"));
  return { root, databasePath: join(root, "app.db") };
}

function fakeSession(): BrowserSession {
  return {
    id: "session-publish",
    profileRef: "profile-publish",
    page: {} as BrowserSession["page"],
  };
}

describe("XiaohongshuPublishService integration", () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let jobs: JobRepository;
  let actions: ActionRequestRepository;
  let externalActions: ExternalActionRepository;
  let evidence: EvidenceRepository;
  let control: JobControlService;
  let idCounter: number;

  beforeEach(() => {
    const temp = makeTempDb();
    root = temp.root;
    db = openDatabase({ databasePath: temp.databasePath });
    jobs = new JobRepository(db);
    actions = new ActionRequestRepository(db);
    externalActions = new ExternalActionRepository(db);
    evidence = new EvidenceRepository(db);
    control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });
    idCounter = 0;
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createId(kind: "external_action" | "step" | "evidence"): string {
    idCounter += 1;
    return kind + "-" + idCounter;
  }

  function seedApproval(jobId: string, approved?: boolean) {
    jobs.create({
      id: jobId,
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief: "PUB-02 fixture" }),
    });
    jobs.commitCheckpoint(jobId, {
      status: "preparing_materials",
      checkpoint: { phase: "material_ready" },
      step: {
        id: jobId + "-material",
        stepKey: "material_pack",
        status: "succeeded",
      },
    });
    jobs.commitCheckpoint(jobId, {
      status: "preparing_publish",
      checkpoint: { phase: "material_handoff" },
      step: {
        id: jobId + "-handoff",
        stepKey: "material_handoff",
        status: "succeeded",
      },
    });

    const pause = control.enterWaiting({
      jobId,
      status: "waiting_for_approval",
      checkpoint: {
        phase: "prepared_for_approval",
        preparedPublication: {
          platform: "xiaohongshu",
          mode: "image_text",
          planId: "plan-pub-02",
          title: "PUB-02",
          bodyLength: 12,
          tags: ["publisher"],
          imageAssetIds: ["cover-1", "image-1"],
          imageCount: 2,
          contentFingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          verifiedAt: "2026-09-21T00:00:00.000Z",
        },
      },
      step: {
        id: jobId + "-prepared",
        stepKey: "verify_prepared",
        status: "succeeded",
      },
      action: {
        id: jobId + "-approval",
        payload: {
          platform: "xiaohongshu",
          title: "PUB-02",
          contentFingerprint:
            "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        },
      },
    });

    if (approved !== undefined) {
      actions.resolve(pause.action.id, { approved });
    }

    return pause.action;
  }

  function createService(overrides: {
    publishPage?: ConstructorParameters<typeof XiaohongshuPublishService>[0]["publishPage"];
    verifyResult?: ConstructorParameters<typeof XiaohongshuPublishService>[0]["verifyResult"];
  } = {}) {
    return new XiaohongshuPublishService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      externalActions,
      evidence,
      createId,
      now: () => new Date("2026-09-21T01:02:03.000Z"),
      publishPage:
        overrides.publishPage ??
        (async ({ onMutationStarted }) => {
          await onMutationStarted?.();
        }),
      verifyResult:
        overrides.verifyResult ??
        (async () => ({
          kind: "published" as const,
          resultUrl: "https://www.xiaohongshu.com/explore/post123456",
          contentId: "post123456",
          confirmationRef: "xhs-result-page",
        })),
    });
  }

  test("cannot enter final publish without durable affirmative approval", async () => {
    seedApproval("job-no-approval");

    await expect(
      createService().publishAfterApproval({
        jobId: "job-no-approval",
        session: fakeSession(),
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPublishApprovalError);

    expect(
      externalActions.getByKey(
        "job-no-approval",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      ),
    ).toBeNull();
    expect(jobs.getById("job-no-approval")?.status).toBe(
      "waiting_for_approval",
    );

    actions.resolve("job-no-approval-approval", { approved: false });
    await expect(
      createService().publishAfterApproval({
        jobId: "job-no-approval",
        session: fakeSession(),
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPublishApprovalError);
    expect(
      externalActions.getByKey(
        "job-no-approval",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      ),
    ).toBeNull();
  });

  test("persists started before one publish interaction, verifies, stores evidence, and succeeds", async () => {
    seedApproval("job-success", true);
    let publishCalls = 0;

    const service = createService({
      publishPage: async ({ onMutationStarted }) => {
        const action = externalActions.getByKey(
          "job-success",
          XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        );
        expect(action?.status).toBe("started");
        expect(jobs.getById("job-success")?.status).toBe("publishing");
        await onMutationStarted?.();
        publishCalls += 1;
      },
    });

    const result = await service.publishAfterApproval({
      jobId: "job-success",
      session: fakeSession(),
    });

    expect(publishCalls).toBe(1);
    expect(result.job.status).toBe("succeeded");
    expect(result.action).toMatchObject({
      status: "succeeded",
      externalRef: "post123456",
    });
    expect(result.evidence.map((item) => item.kind)).toEqual([
      "result_url",
      "content_id",
      "confirmation_ref",
    ]);
    expect(evidence.getByJob("job-success")).toHaveLength(3);
    expect(jobs.getById("job-success")?.checkpoint).toMatchObject({
      phase: "publish_verified",
      actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
    });

    const replay = await service.publishAfterApproval({
      jobId: "job-success",
      session: fakeSession(),
    });
    expect(replay.reused).toBe(true);
    expect(publishCalls).toBe(1);
    expect(evidence.getByJob("job-success")).toHaveLength(3);
  });

  test("an uncertain post-click result becomes unknown and resume verifies first without republishing", async () => {
    seedApproval("job-unknown", true);
    let publishCalls = 0;
    let verifyCalls = 0;

    const first = createService({
      publishPage: async ({ onMutationStarted }) => {
        await onMutationStarted?.();
        publishCalls += 1;
        throw new Error("simulated disconnect after click");
      },
      verifyResult: async () => {
        verifyCalls += 1;
        throw new Error("verification unavailable");
      },
    });

    await expect(
      first.publishAfterApproval({
        jobId: "job-unknown",
        session: fakeSession(),
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPublishUnknownError);

    expect(publishCalls).toBe(1);
    expect(verifyCalls).toBe(0);
    expect(
      externalActions.getByKey(
        "job-unknown",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      ),
    ).toMatchObject({
      status: "unknown",
      errorCode: "PUBLISH_RESULT_UNKNOWN",
    });
    expect(jobs.getById("job-unknown")?.status).toBe("publishing");

    const resumed = createService({
      publishPage: async () => {
        publishCalls += 1;
        throw new Error("resume must never click publish");
      },
      verifyResult: async () => {
        verifyCalls += 1;
        return {
          kind: "published" as const,
          resultUrl: "https://www.xiaohongshu.com/explore/recovered123",
          contentId: "recovered123",
          confirmationRef: "xhs-result-page",
        };
      },
    });

    const result = await resumed.publishAfterApproval({
      jobId: "job-unknown",
      session: fakeSession(),
    });

    expect(result.verifyFirst).toBe(true);
    expect(result.job.status).toBe("succeeded");
    expect(publishCalls).toBe(1);
    expect(verifyCalls).toBe(1);
    expect(
      externalActions.getByKey(
        "job-unknown",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      )?.status,
    ).toBe("succeeded");
  });

  test("parallel callers cannot execute two publish interactions for one durable action", async () => {
    seedApproval("job-parallel", true);
    let publishCalls = 0;
    let released = false;
    let releasePublish!: () => void;
    let mutationStarted!: () => void;
    const publishGate = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    const mutationBoundary = new Promise<void>((resolve) => {
      mutationStarted = resolve;
    });

    const service = createService({
      publishPage: async ({ onMutationStarted }) => {
        await onMutationStarted?.();
        publishCalls += 1;
        mutationStarted();
        await publishGate;
      },
      verifyResult: async () => {
        if (!released) {
          throw new Error("result is not observable while first click is in flight");
        }
        return {
          kind: "published" as const,
          resultUrl: "https://www.xiaohongshu.com/explore/parallel123",
          contentId: "parallel123",
          confirmationRef: "xhs-result-page",
        };
      },
    });

    const first = service.publishAfterApproval({
      jobId: "job-parallel",
      session: fakeSession(),
    });
    await mutationBoundary;

    await expect(
      service.publishAfterApproval({
        jobId: "job-parallel",
        session: fakeSession(),
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPublishUnknownError);

    expect(publishCalls).toBe(1);
    expect(
      externalActions.getByKey(
        "job-parallel",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      )?.status,
    ).toBe("unknown");

    released = true;
    releasePublish();
    await expect(first).resolves.toMatchObject({
      job: { status: "succeeded" },
      action: { status: "succeeded" },
    });

    expect(publishCalls).toBe(1);
  });

  test("duplicate final-publish calls reuse the one durable action and never execute a second click", async () => {
    seedApproval("job-duplicate", true);
    let publishCalls = 0;

    const service = createService({
      publishPage: async ({ onMutationStarted }) => {
        await onMutationStarted?.();
        publishCalls += 1;
      },
    });

    const first = await service.publishAfterApproval({
      jobId: "job-duplicate",
      session: fakeSession(),
    });
    const second = await service.publishAfterApproval({
      jobId: "job-duplicate",
      session: fakeSession(),
    });

    expect(first.action.id).toBe(second.action.id);
    expect(second.reused).toBe(true);
    expect(publishCalls).toBe(1);
    expect(
      externalActions.getByKey(
        "job-duplicate",
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      )?.status,
    ).toBe("succeeded");
  });

  test("does not depend on any Agent runtime to execute the deterministic publish path", async () => {
    seedApproval("job-agent-disabled", true);

    const service = createService();
    const result = await service.publishAfterApproval({
      jobId: "job-agent-disabled",
      session: fakeSession(),
    });

    expect(result.job.status).toBe("succeeded");
    expect(result.evidence.length).toBeGreaterThan(0);
  });
});
