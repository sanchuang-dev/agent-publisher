import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import type { BrowserSession } from "../src/browser/provider.js";
import { JobControlService } from "../src/jobs/job-control-service.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
  XiaohongshuPageStateError,
  XiaohongshuPreparedValidationError,
  XiaohongshuUnsupportedPublishModeError,
  type PreparedImageTextPublication,
} from "../src/platforms/xiaohongshu/image-text-prepare.js";
import {
  XiaohongshuPrepareRecoveryRequiredError,
  XiaohongshuPrepareService,
  XiaohongshuPrepareStateError,
} from "../src/platforms/xiaohongshu/prepare-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";
import {
  createImageTextMaterialPackFixture,
  createVideoMaterialPackFixture,
} from "../src/materials/testing/fake-providers.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-xhs-prepare-"));
  return { root, databasePath: join(root, "app.db") };
}

function fakeSession(
  profileRef = "profile-ref",
  id = "browser-session",
): BrowserSession {
  return {
    id,
    profileRef,
    page: {} as BrowserSession["page"],
  };
}

describe("XiaohongshuPrepareService", () => {
  let root: string;
  let db: ReturnType<typeof openDatabase>;
  let jobs: JobRepository;
  let actions: ActionRequestRepository;
  let control: JobControlService;

  beforeEach(() => {
    const temp = makeTempDb();
    root = temp.root;
    db = openDatabase({ databasePath: temp.databasePath });
    jobs = new JobRepository(db);
    actions = new ActionRequestRepository(db);
    control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  function createPreparingPublishJob(
    id: string,
    mode: "image_text" | "video" = "image_text",
  ) {
    jobs.create({
      id,
      platform: "xiaohongshu",
      publishMode: mode,
      briefJson: "{}",
    });
    jobs.commitCheckpoint(id, {
      status: "preparing_materials",
      checkpoint: { phase: "materials" },
      step: {
        id: id + "-materials",
        stepKey: "generate_plan",
        status: "succeeded",
      },
    });
    jobs.commitCheckpoint(id, {
      status: "preparing_publish",
      checkpoint: { phase: "browser", authenticated: true },
      step: {
        id: id + "-browser",
        stepKey: "ensure_login",
        status: "succeeded",
      },
    });
  }

  function preparedFixture() {
    const pack = createImageTextMaterialPackFixture();
    const prepared: PreparedImageTextPublication = {
      platform: "xiaohongshu",
      mode: "image_text",
      planId: pack.planId,
      title: pack.copy.title,
      bodyLength: pack.copy.body.length,
      tags: pack.copy.tags,
      imageAssetIds: [pack.cover, ...pack.images].map(
        (asset) => asset.assetId,
      ),
      imageCount: 3,
      contentFingerprint:
        fingerprintXiaohongshuImageTextMaterialPack(pack),
      verifiedAt: "2026-09-20T05:00:00.000Z",
    };
    return { pack, prepared };
  }

  test("successful prepare durably pauses once for approval with a safe summary", async () => {
    const jobId = "job-xhs-prepare";
    createPreparingPublishJob(jobId);
    const { pack, prepared } = preparedFixture();
    let prepareCalls = 0;
    let verifyCalls = 0;
    let idCounter = 0;

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        prepareCalls += 1;
        await input.onMutationStarted?.();
        return prepared;
      },
      verifyPreparedPage: async () => {
        verifyCalls += 1;
        return {
          title: prepared.title,
          bodyLength: prepared.bodyLength,
          tags: prepared.tags,
          imageCount: prepared.imageCount,
        };
      },
      createId: (kind) => "xhs-" + kind + "-" + ++idCounter,
    });

    const first = await service.prepareForApproval({
      jobId,
      session: fakeSession(),
      materialPack: pack,
    });

    expect(first.reused).toBe(false);
    expect(first.job).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        phase: "prepared_for_approval",
        actionRequestId: first.approval.id,
      },
    });
    expect(first.approval).toMatchObject({
      type: "approval_required",
      status: "open",
      payload: {
        platform: "xiaohongshu",
        mode: "image_text",
        planId: pack.planId,
        title: pack.copy.title,
        bodyLength: pack.copy.body.length,
        tags: pack.copy.tags,
        imageCount: 3,
        warningCodes: [],
        contentFingerprint: prepared.contentFingerprint,
      },
    });

    const approvalJson = JSON.stringify(first.approval.payload);
    expect(approvalJson).not.toContain(pack.copy.body);
    expect(approvalJson).not.toContain("asset://");
    expect(approvalJson).not.toContain("/fixtures/");

    const durableCheckpoint = jobs.loadLastCheckpoint(jobId);
    expect(durableCheckpoint).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        phase: "prepared_for_approval",
        actionRequestId: first.approval.id,
        preparedPublication: {
          contentFingerprint: prepared.contentFingerprint,
          imageCount: 3,
        },
      },
    });

    const steps = jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "verify_prepared");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      status: "succeeded",
      attempt: 1,
      errorCode: null,
    });

    const second = await service.prepareForApproval({
      jobId,
      session: fakeSession(),
      materialPack: pack,
    });

    expect(second.reused).toBe(true);
    expect(second.approval.id).toBe(first.approval.id);
    expect(second.prepared).toEqual(first.prepared);
    expect(prepareCalls).toBe(1);
    expect(verifyCalls).toBe(1);

    await expect(
      service.prepareForApproval({
        jobId,
        session: fakeSession("different-profile"),
        materialPack: pack,
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPrepareStateError);
    expect(verifyCalls).toBe(1);

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ? AND type = 'approval_required'",
        )
        .get(jobId),
    ).toEqual({ count: 1 });
  });

  test("post-mutation validation failure is durable and pauses for recovery, not approval", async () => {
    const jobId = "job-xhs-validation-failure";
    createPreparingPublishJob(jobId);
    const pack = createImageTextMaterialPackFixture();

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        await input.onMutationStarted?.();
        throw new XiaohongshuPreparedValidationError(["title"]);
      },
      createId: (() => {
        let value = 0;
        return (kind) => "validation-" + kind + "-" + ++value;
      })(),
    });

    await expect(
      service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      }),
    ).rejects.toMatchObject({
      name: "XiaohongshuPrepareRecoveryRequiredError",
      code: "PREPARE_RECOVERY_REQUIRED",
      failureCode: "PREPARED_VALIDATION_FAILED",
    });

    expect(jobs.getById(jobId)).toMatchObject({
      status: "preparing_publish",
      currentStep: "verify_prepared",
      checkpoint: {
        phase: "xhs_prepare_recovery_required",
        failureCode: "PREPARED_VALIDATION_FAILED",
      },
    });

    const openAction = actions.getCurrentOpenForJob(jobId);
    expect(openAction).toMatchObject({
      type: "clarification_required",
      status: "open",
      payload: {
        reason: "prepare_recovery_required",
        failureCode: "PREPARED_VALIDATION_FAILED",
      },
    });

    expect(
      db
        .prepare(
          "SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ? AND type = 'approval_required'",
        )
        .get(jobId),
    ).toEqual({ count: 0 });

    expect(
      jobs
        .getStepsForJob(jobId)
        .filter((step) => step.stepKey === "verify_prepared"),
    ).toEqual([
      expect.objectContaining({
        status: "failed",
        attempt: 1,
        errorCode: "PREPARED_VALIDATION_FAILED",
      }),
    ]);
  });

  test("retry resumes this job's prepared composer after recovery acknowledgement", async () => {
    const jobId = "job-xhs-recovery";
    createPreparingPublishJob(jobId);
    const { pack, prepared } = preparedFixture();
    let prepareCalls = 0;
    let verifyCalls = 0;
    let idCounter = 0;

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        prepareCalls += 1;
        await input.onMutationStarted?.();
        throw new XiaohongshuPageStateError(
          "PLATFORM_UPLOAD_TIMEOUT",
          "fixture upload timed out after mutation",
        );
      },
      verifyPreparedPage: async () => {
        verifyCalls += 1;
        return {
          title: prepared.title,
          bodyLength: prepared.bodyLength,
          tags: prepared.tags,
          imageCount: prepared.imageCount,
        };
      },
      createId: (kind) => "recovery-" + kind + "-" + ++idCounter,
      now: () => new Date("2026-09-20T05:10:00.000Z"),
    });

    let recovery: XiaohongshuPrepareRecoveryRequiredError | null = null;
    try {
      await service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      });
    } catch (error) {
      expect(error).toBeInstanceOf(XiaohongshuPrepareRecoveryRequiredError);
      recovery = error as XiaohongshuPrepareRecoveryRequiredError;
    }

    expect(recovery).not.toBeNull();
    expect(recovery?.failureCode).toBe("PLATFORM_UPLOAD_TIMEOUT");
    expect(prepareCalls).toBe(1);
    expect(verifyCalls).toBe(0);

    const clarification = actions.getById(recovery!.actionRequestId);
    expect(clarification).toMatchObject({
      type: "clarification_required",
      status: "open",
    });

    actions.resolve(recovery!.actionRequestId, {
      acknowledged: true,
    });

    const resumed = await service.prepareForApproval({
      jobId,
      session: fakeSession(),
      materialPack: pack,
    });

    expect(resumed).toMatchObject({
      reused: true,
      job: { status: "waiting_for_approval" },
      approval: { type: "approval_required", status: "open" },
      prepared: {
        contentFingerprint: prepared.contentFingerprint,
        title: prepared.title,
        imageCount: prepared.imageCount,
      },
    });
    expect(prepareCalls).toBe(1);
    expect(verifyCalls).toBe(1);

    const attempts = jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "verify_prepared");
    expect(attempts).toHaveLength(2);
    expect(attempts[0]).toMatchObject({
      attempt: 1,
      status: "failed",
      errorCode: "PLATFORM_UPLOAD_TIMEOUT",
    });
    expect(attempts[1]).toMatchObject({
      attempt: 2,
      status: "succeeded",
    });
  });

  test("crash recovery closes the persisted running attempt instead of orphaning it", async () => {
    const jobId = "job-xhs-crash-recovery";
    createPreparingPublishJob(jobId);
    const { pack, prepared } = preparedFixture();
    const fingerprint =
      fingerprintXiaohongshuImageTextMaterialPack(pack);
    const session = fakeSession();
    const profileFingerprint = createHash("sha256")
      .update(session.profileRef)
      .digest("hex");
    let prepareCalls = 0;

    jobs.commitCheckpoint(jobId, {
      status: "preparing_publish",
      checkpoint: {
        phase: "xhs_prepare_attempt",
        contentFingerprint: fingerprint,
        browserProfileFingerprint: profileFingerprint,
        attempt: 1,
      },
      step: {
        id: "crash-running-step",
        stepKey: "verify_prepared",
        status: "running",
        attempt: 1,
      },
    });

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async () => {
        prepareCalls += 1;
        throw new Error("crash recovery must not re-enter the mutating prepare path");
      },
      verifyPreparedPage: async () => ({
        title: prepared.title,
        bodyLength: prepared.bodyLength,
        tags: prepared.tags,
        imageCount: prepared.imageCount,
      }),
      createId: (() => {
        let value = 0;
        return (kind) => "crash-" + kind + "-" + ++value;
      })(),
      now: () => new Date("2026-09-20T05:15:00.000Z"),
    });

    const recovered = await service.prepareForApproval({
      jobId,
      session,
      materialPack: pack,
    });

    expect(recovered).toMatchObject({
      reused: true,
      job: { status: "waiting_for_approval" },
      approval: { type: "approval_required", status: "open" },
    });
    expect(prepareCalls).toBe(0);

    const attempts = jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "verify_prepared");
    expect(attempts).toHaveLength(1);
    expect(attempts[0]).toMatchObject({
      id: "crash-running-step",
      attempt: 1,
      status: "succeeded",
    });
  });

  test("recovery never re-uploads until a human confirms the composer was reset", async () => {
    const jobId = "job-xhs-recovery-reset";
    createPreparingPublishJob(jobId);
    const { pack, prepared } = preparedFixture();
    let prepareCalls = 0;
    let idCounter = 0;

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        prepareCalls += 1;
        await input.onMutationStarted?.();
        if (prepareCalls === 1) {
          throw new XiaohongshuPageStateError(
            "PLATFORM_UPLOAD_TIMEOUT",
            "fixture upload timed out after mutation",
          );
        }
        return prepared;
      },
      verifyPreparedPage: async () => {
        throw new XiaohongshuPageStateError(
          "PLATFORM_UPLOAD_TIMEOUT",
          "fixture composer is not yet a complete prepared page",
        );
      },
      createId: (kind) => "reset-" + kind + "-" + ++idCounter,
    });

    let firstRecovery: XiaohongshuPrepareRecoveryRequiredError | null = null;
    try {
      await service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      });
    } catch (error) {
      firstRecovery = error as XiaohongshuPrepareRecoveryRequiredError;
    }
    expect(firstRecovery).toBeInstanceOf(
      XiaohongshuPrepareRecoveryRequiredError,
    );
    expect(prepareCalls).toBe(1);

    actions.resolve(firstRecovery!.actionRequestId, {
      acknowledged: true,
    });

    let secondRecovery: XiaohongshuPrepareRecoveryRequiredError | null = null;
    try {
      await service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      });
    } catch (error) {
      secondRecovery = error as XiaohongshuPrepareRecoveryRequiredError;
    }

    expect(secondRecovery).toBeInstanceOf(
      XiaohongshuPrepareRecoveryRequiredError,
    );
    expect(secondRecovery?.actionRequestId).not.toBe(
      firstRecovery?.actionRequestId,
    );
    expect(prepareCalls).toBe(
      1,
      "unconfirmed recovery must not call the mutating prepare path again",
    );

    actions.resolve(secondRecovery!.actionRequestId, {
      composerReset: true,
    });

    const recovered = await service.prepareForApproval({
      jobId,
      session: fakeSession(),
      materialPack: pack,
    });

    expect(prepareCalls).toBe(2);
    expect(recovered).toMatchObject({
      reused: false,
      job: { status: "waiting_for_approval" },
      approval: { type: "approval_required", status: "open" },
    });

    const attempts = jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "verify_prepared");
    expect(attempts.map((step) => [step.attempt, step.status])).toEqual([
      [1, "failed"],
      [2, "failed"],
      [3, "succeeded"],
    ]);
  });

  test("video input fails explicitly before any page mutation", async () => {
    const jobId = "job-xhs-video";
    createPreparingPublishJob(jobId, "video");
    const pack = createVideoMaterialPackFixture();
    let prepareCalls = 0;

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId,
      preparePage: async () => {
        prepareCalls += 1;
        throw new Error("page preparer must not run");
      },
    });

    await expect(
      service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      }),
    ).rejects.toBeInstanceOf(XiaohongshuUnsupportedPublishModeError);

    expect(prepareCalls).toBe(0);
    expect(jobs.getById(jobId)).toMatchObject({
      status: "preparing_publish",
    });
    expect(actions.getCurrentOpenForJob(jobId)).toBeNull();
  });

  test("concurrent prepare for the same job is rejected before a second page mutation", async () => {
    const jobId = "job-xhs-concurrent";
    createPreparingPublishJob(jobId);
    const { pack, prepared } = preparedFixture();
    let prepareCalls = 0;
    let releasePrepare!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        prepareCalls += 1;
        await input.onMutationStarted?.();
        markStarted();
        await gate;
        return prepared;
      },
      createId: (() => {
        let value = 0;
        return (kind) => "concurrent-" + kind + "-" + ++value;
      })(),
    });

    const first = service.prepareForApproval({
      jobId,
      session: fakeSession(),
      materialPack: pack,
    });
    await started;

    await expect(
      service.prepareForApproval({
        jobId,
        session: fakeSession(),
        materialPack: pack,
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPrepareStateError);

    expect(prepareCalls).toBe(1);
    releasePrepare();

    await expect(first).resolves.toMatchObject({
      reused: false,
      job: { status: "waiting_for_approval" },
      approval: { status: "open", type: "approval_required" },
    });
    expect(prepareCalls).toBe(1);
  });

  test("the same browser session cannot be driven by two jobs concurrently", async () => {
    const firstJobId = "job-xhs-session-a";
    const secondJobId = "job-xhs-session-b";
    createPreparingPublishJob(firstJobId);
    createPreparingPublishJob(secondJobId);
    const { pack, prepared } = preparedFixture();
    const sharedSession = fakeSession("shared-profile", "shared-session");
    let releasePrepare!: () => void;
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => {
      markStarted = resolve;
    });
    const gate = new Promise<void>((resolve) => {
      releasePrepare = resolve;
    });

    const service = new XiaohongshuPrepareService({
      jobs,
      actionRequests: actions,
      jobControl: control,
      resolveAssetPath: (asset) => "/fixtures/" + asset.assetId + ".png",
      preparePage: async (input) => {
        await input.onMutationStarted?.();
        markStarted();
        await gate;
        return prepared;
      },
      createId: (() => {
        let value = 0;
        return (kind) => "session-" + kind + "-" + ++value;
      })(),
    });

    const first = service.prepareForApproval({
      jobId: firstJobId,
      session: sharedSession,
      materialPack: pack,
    });
    await started;

    await expect(
      service.prepareForApproval({
        jobId: secondJobId,
        session: sharedSession,
        materialPack: pack,
      }),
    ).rejects.toBeInstanceOf(XiaohongshuPrepareStateError);

    expect(jobs.getById(secondJobId)).toMatchObject({
      status: "preparing_publish",
      currentStep: "ensure_login",
    });

    releasePrepare();
    await first;
  });
});
