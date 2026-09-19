import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JobNotFoundError, type JobRepository as JobRepositoryContract } from "../src/contracts/job.js";
import { IllegalJobStatusTransitionError } from "../src/jobs/state-machine.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-jobrepo-"));
  const databasePath = join(root, "app.db");
  return { root, databasePath };
}

describe("JobRepository integration", () => {
  let root: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase> | null;
  let repo: JobRepository;

  beforeEach(() => {
    ({ root, databasePath } = makeTempDb());
    db = openDatabase({ databasePath });
    repo = new JobRepository(db);

    const contract: JobRepositoryContract = repo;
    expect(contract).toBe(repo);
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("create persists a created job that can be read back by id", () => {
    const job = repo.create({
      id: "job-001",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ title: "hello" }),
    });

    expect(job).toMatchObject({
      id: "job-001",
      platform: "xiaohongshu",
      publishMode: "image_text",
      status: "created",
      currentStep: null,
      checkpoint: null,
      completedAt: null,
    });

    expect(repo.getById("job-001")).toEqual(job);
  });

  test("missing jobs have explicit read and mutation behavior", () => {
    expect(repo.getById("missing")).toBeNull();
    expect(() => repo.loadLastCheckpoint("missing")).toThrow(JobNotFoundError);
    expect(() => repo.getStepsForJob("missing")).toThrow(JobNotFoundError);

    expect(() =>
      repo.commitCheckpoint("missing", {
        status: "preparing_materials",
        checkpoint: { phase: "plan" },
        step: { id: "missing-step", stepKey: "generate_plan", status: "running" },
      }),
    ).toThrow(JobNotFoundError);
  });

  test("loadLastCheckpoint returns null before the first committed checkpoint", () => {
    repo.create({
      id: "job-no-checkpoint",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    expect(repo.loadLastCheckpoint("job-no-checkpoint")).toBeNull();
  });

  test("commitCheckpoint atomically updates job state and records its matching step", () => {
    repo.create({
      id: "job-002",
      platform: "douyin",
      publishMode: "video",
      briefJson: "{}",
    });

    const updated = repo.commitCheckpoint("job-002", {
      status: "preparing_materials",
      checkpoint: { progress: 10 },
      step: {
        id: "step-001",
        stepKey: "generate_plan",
        status: "succeeded",
        startedAt: "2026-09-18T01:00:00.000Z",
        finishedAt: "2026-09-18T01:00:05.000Z",
      },
    });

    expect(updated.status).toBe("preparing_materials");
    expect(updated.currentStep).toBe("generate_plan");
    expect(updated.checkpoint).toEqual({ progress: 10 });

    expect(repo.loadLastCheckpoint("job-002")).toMatchObject({
      jobId: "job-002",
      status: "preparing_materials",
      currentStep: "generate_plan",
      checkpoint: { progress: 10 },
    });

    const steps = repo.getStepsForJob("job-002");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      jobId: "job-002",
      stepKey: "generate_plan",
      status: "succeeded",
      attempt: 1,
    });
  });

  test("repeated checkpoint commits for the same step attempt update the durable step idempotently", () => {
    repo.create({
      id: "job-replay",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-replay", {
      status: "preparing_materials",
      checkpoint: { phase: "copy", progress: 10 },
      step: {
        id: "step-replay",
        stepKey: "generate_copy",
        status: "running",
        attempt: 1,
        startedAt: "2026-09-18T01:00:00.000Z",
      },
    });

    repo.commitCheckpoint("job-replay", {
      status: "preparing_materials",
      checkpoint: { phase: "copy", progress: 100 },
      step: {
        id: "step-replay",
        stepKey: "generate_copy",
        status: "succeeded",
        attempt: 1,
        startedAt: "2026-09-18T01:00:00.000Z",
        finishedAt: "2026-09-18T01:00:05.000Z",
      },
    });

    expect(repo.loadLastCheckpoint("job-replay")).toMatchObject({
      status: "preparing_materials",
      currentStep: "generate_copy",
      checkpoint: { phase: "copy", progress: 100 },
    });

    const steps = repo.getStepsForJob("job-replay");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      id: "step-replay",
      stepKey: "generate_copy",
      status: "succeeded",
      attempt: 1,
      startedAt: "2026-09-18T01:00:00.000Z",
      finishedAt: "2026-09-18T01:00:05.000Z",
    });
  });

  test("terminal checkpoint records completion time", () => {
    repo.create({
      id: "job-terminal",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-terminal", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: {
        id: "step-prepare-terminal",
        stepKey: "generate_copy",
        status: "succeeded",
      },
    });

    const completed = repo.commitCheckpoint("job-terminal", {
      status: "failed",
      checkpoint: { phase: "done" },
      step: {
        id: "step-terminal",
        stepKey: "verify_result",
        status: "failed",
      },
    });

    expect(completed.completedAt).not.toBeNull();
    expect(Number.isNaN(Date.parse(completed.completedAt ?? ""))).toBe(false);
  });

  test("the latest committed checkpoint is the recovery state after multiple steps", () => {
    repo.create({
      id: "job-003",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-003", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "s-a", stepKey: "generate_copy", status: "succeeded" },
    });

    repo.commitCheckpoint("job-003", {
      status: "preparing_publish",
      checkpoint: { phase: "browser" },
      step: { id: "s-b", stepKey: "acquire_browser", status: "running" },
    });

    expect(repo.loadLastCheckpoint("job-003")).toMatchObject({
      status: "preparing_publish",
      currentStep: "acquire_browser",
      checkpoint: { phase: "browser" },
    });

    expect(repo.getStepsForJob("job-003").map((step) => step.stepKey)).toEqual([
      "generate_copy",
      "acquire_browser",
    ]);
  });

  test("an outer transaction can atomically compose commitCheckpoint with later persistence", () => {
    repo.create({
      id: "job-outer-transaction",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-outer-transaction", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: {
        id: "step-outer-prepare",
        stepKey: "generate_copy",
        status: "succeeded",
      },
    });
    repo.commitCheckpoint("job-outer-transaction", {
      status: "preparing_publish",
      checkpoint: { phase: "browser" },
      step: {
        id: "step-outer-browser",
        stepKey: "open_platform",
        status: "succeeded",
      },
    });

    const outerTransaction = db!.transaction(() => {
      repo.commitCheckpoint("job-outer-transaction", {
        status: "waiting_for_login",
        checkpoint: { reason: "login_required" },
        step: {
          id: "step-login",
          stepKey: "ensure_login",
          status: "succeeded",
        },
      });

      // Simulates a later ActionRequest write failing in M2-03.
      throw new Error("action request insert failed");
    });

    expect(outerTransaction).toThrow("action request insert failed");

    expect(repo.getById("job-outer-transaction")).toMatchObject({
      status: "preparing_publish",
      currentStep: "open_platform",
      checkpoint: { phase: "browser" },
    });
    expect(repo.loadLastCheckpoint("job-outer-transaction")).toMatchObject({
      status: "preparing_publish",
      currentStep: "open_platform",
      checkpoint: { phase: "browser" },
    });
    expect(repo.getStepsForJob("job-outer-transaction")).toHaveLength(2);
  });

  test("step insert failure rolls back status, current_step and checkpoint together", () => {
    repo.create({
      id: "job-004",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-004", {
      status: "preparing_materials",
      checkpoint: { phase: 1 },
      step: {
        id: "step-id-1",
        stepKey: "generate_copy",
        status: "succeeded",
        attempt: 1,
      },
    });

    expect(() =>
      repo.commitCheckpoint("job-004", {
        status: "preparing_publish",
        checkpoint: { phase: 2 },
        step: {
          // Same primary-key id but a different logical step forces a real
          // step-write failure; same-step retries are intentionally upserted.
          id: "step-id-1",
          stepKey: "open_platform",
          status: "running",
          attempt: 1,
        },
      }),
    ).toThrow();

    expect(repo.getById("job-004")).toMatchObject({
      status: "preparing_materials",
      currentStep: "generate_copy",
      checkpoint: { phase: 1 },
    });
    expect(repo.loadLastCheckpoint("job-004")).toMatchObject({
      status: "preparing_materials",
      currentStep: "generate_copy",
      checkpoint: { phase: 1 },
    });
    expect(repo.getStepsForJob("job-004")).toHaveLength(1);
  });

  test("illegal status transitions fail without mutating the persisted checkpoint", () => {
    repo.create({
      id: "job-illegal-transition",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-illegal-transition", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "step-copy", stepKey: "generate_copy", status: "succeeded" },
    });

    expect(() =>
      repo.commitCheckpoint("job-illegal-transition", {
        status: "publishing",
        checkpoint: { phase: "publish" },
        step: { id: "step-publish", stepKey: "publish_once", status: "running" },
      }),
    ).toThrow(IllegalJobStatusTransitionError);

    expect(repo.getById("job-illegal-transition")).toMatchObject({
      status: "preparing_materials",
      currentStep: "generate_copy",
      checkpoint: { phase: "copy" },
    });
    expect(repo.loadLastCheckpoint("job-illegal-transition")).toMatchObject({
      status: "preparing_materials",
      currentStep: "generate_copy",
      checkpoint: { phase: "copy" },
    });
    expect(repo.getStepsForJob("job-illegal-transition")).toHaveLength(1);
  });

  test("direct publishing transition is rejected without affirmative persisted approval", () => {
    repo.create({
      id: "job-approval-gate",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-approval-gate", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "gate-copy", stepKey: "generate_copy", status: "succeeded" },
    });
    repo.commitCheckpoint("job-approval-gate", {
      status: "preparing_publish",
      checkpoint: { phase: "browser" },
      step: { id: "gate-browser", stepKey: "open_platform", status: "succeeded" },
    });
    repo.commitCheckpoint("job-approval-gate", {
      status: "waiting_for_approval",
      checkpoint: {
        reason: "approval_required",
        actionRequestId: "approval-gate-action",
      },
      step: { id: "gate-approval", stepKey: "verify_prepared", status: "succeeded" },
    });

    expect(() =>
      repo.commitCheckpoint("job-approval-gate", {
        status: "publishing",
        checkpoint: { phase: "publishing" },
        step: { id: "gate-publish", stepKey: "publish_once", status: "running" },
      }),
    ).toThrow(/affirmative approval is not persisted/);

    db!.prepare(
      `INSERT INTO action_requests (
        id, job_id, type, status, resolution_json, created_at, resolved_at
      ) VALUES (?, ?, 'approval_required', 'resolved', ?, ?, ?)`,
    ).run(
      "approval-gate-action",
      "job-approval-gate",
      JSON.stringify({ approved: false }),
      "2026-09-18T02:00:00.000Z",
      "2026-09-18T02:00:01.000Z",
    );

    expect(() =>
      repo.commitCheckpoint("job-approval-gate", {
        status: "publishing",
        checkpoint: { phase: "publishing" },
        step: { id: "gate-publish-2", stepKey: "publish_once", status: "running", attempt: 2 },
      }),
    ).toThrow(/affirmative approval is not persisted/);

    expect(repo.getById("job-approval-gate")).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        reason: "approval_required",
        actionRequestId: "approval-gate-action",
      },
    });
  });

  test("direct publishing gate rejects unresolved, wrong-type, and wrong-job approvals without mutation", () => {
    const createWaitingApprovalJob = (jobId: string, actionRequestId: string) => {
      repo.create({
        id: jobId,
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: "{}",
      });
      repo.commitCheckpoint(jobId, {
        status: "preparing_materials",
        checkpoint: { phase: "copy" },
        step: { id: `${jobId}-copy`, stepKey: "generate_copy", status: "succeeded" },
      });
      repo.commitCheckpoint(jobId, {
        status: "preparing_publish",
        checkpoint: { phase: "browser" },
        step: { id: `${jobId}-browser`, stepKey: "open_platform", status: "succeeded" },
      });
      repo.commitCheckpoint(jobId, {
        status: "waiting_for_approval",
        checkpoint: { reason: "approval_required", actionRequestId },
        step: { id: `${jobId}-approval`, stepKey: "verify_prepared", status: "succeeded" },
      });
    };

    const expectPublishingRejectedWithoutMutation = (jobId: string, attempt: number) => {
      const before = repo.getById(jobId);
      const stepCount = repo.getStepsForJob(jobId).length;

      expect(() =>
        repo.commitCheckpoint(jobId, {
          status: "publishing",
          checkpoint: { phase: "publishing" },
          step: {
            id: `${jobId}-publish-${attempt}`,
            stepKey: "publish_once",
            status: "running",
            attempt,
          },
        }),
      ).toThrow();

      expect(repo.getById(jobId)).toEqual(before);
      expect(repo.getStepsForJob(jobId)).toHaveLength(stepCount);
    };

    createWaitingApprovalJob("job-approval-unresolved", "approval-unresolved");
    db!.prepare(
      `INSERT INTO action_requests (
        id, job_id, type, status, resolution_json, created_at
      ) VALUES (?, ?, 'approval_required', 'open', ?, ?)`,
    ).run(
      "approval-unresolved",
      "job-approval-unresolved",
      JSON.stringify({ approved: true }),
      "2026-09-18T02:20:00.000Z",
    );
    expectPublishingRejectedWithoutMutation("job-approval-unresolved", 1);

    createWaitingApprovalJob("job-approval-wrong-type", "approval-wrong-type");
    db!.prepare(
      `INSERT INTO action_requests (
        id, job_id, type, status, resolution_json, created_at, resolved_at
      ) VALUES (?, ?, 'login_required', 'resolved', ?, ?, ?)`,
    ).run(
      "approval-wrong-type",
      "job-approval-wrong-type",
      JSON.stringify({ approved: true }),
      "2026-09-18T02:21:00.000Z",
      "2026-09-18T02:21:01.000Z",
    );
    expectPublishingRejectedWithoutMutation("job-approval-wrong-type", 1);

    repo.create({
      id: "job-approval-other-owner",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
    createWaitingApprovalJob("job-approval-wrong-job", "approval-wrong-job");
    db!.prepare(
      `INSERT INTO action_requests (
        id, job_id, type, status, resolution_json, created_at, resolved_at
      ) VALUES (?, ?, 'approval_required', 'resolved', ?, ?, ?)`,
    ).run(
      "approval-wrong-job",
      "job-approval-other-owner",
      JSON.stringify({ approved: true }),
      "2026-09-18T02:22:00.000Z",
      "2026-09-18T02:22:01.000Z",
    );
    expectPublishingRejectedWithoutMutation("job-approval-wrong-job", 1);
  });

  test("direct publishing transition succeeds only with the checkpoint-bound affirmative approval", () => {
    repo.create({
      id: "job-approval-gate-ok",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-approval-gate-ok", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "gate-ok-copy", stepKey: "generate_copy", status: "succeeded" },
    });
    repo.commitCheckpoint("job-approval-gate-ok", {
      status: "preparing_publish",
      checkpoint: { phase: "browser" },
      step: { id: "gate-ok-browser", stepKey: "open_platform", status: "succeeded" },
    });
    repo.commitCheckpoint("job-approval-gate-ok", {
      status: "waiting_for_approval",
      checkpoint: {
        reason: "approval_required",
        actionRequestId: "approval-gate-ok-action",
      },
      step: { id: "gate-ok-approval", stepKey: "verify_prepared", status: "succeeded" },
    });

    db!.prepare(
      `INSERT INTO action_requests (
        id, job_id, type, status, resolution_json, created_at, resolved_at
      ) VALUES (?, ?, 'approval_required', 'resolved', ?, ?, ?)`,
    ).run(
      "approval-gate-ok-action",
      "job-approval-gate-ok",
      JSON.stringify({ approved: true }),
      "2026-09-18T02:10:00.000Z",
      "2026-09-18T02:10:01.000Z",
    );

    expect(
      repo.commitCheckpoint("job-approval-gate-ok", {
        status: "publishing",
        checkpoint: { phase: "publishing" },
        step: { id: "gate-ok-publish", stepKey: "publish_once", status: "running" },
      }),
    ).toMatchObject({
      status: "publishing",
      currentStep: "publish_once",
      checkpoint: { phase: "publishing" },
    });
  });

  test("reopen recovery loads the last committed checkpoint and step history", () => {
    repo.create({
      id: "job-005",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });

    repo.commitCheckpoint("job-005", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "step-copy", stepKey: "generate_copy", status: "succeeded" },
    });

    repo.commitCheckpoint("job-005", {
      status: "preparing_publish",
      checkpoint: { uploadedBytes: 4096 },
      step: { id: "step-upload", stepKey: "upload_assets", status: "succeeded" },
    });

    db?.close();
    db = null;

    const reopenedDb = openDatabase({ databasePath });
    const reopenedRepo = new JobRepository(reopenedDb);

    try {
      expect(reopenedRepo.loadLastCheckpoint("job-005")).toMatchObject({
        jobId: "job-005",
        status: "preparing_publish",
        currentStep: "upload_assets",
        checkpoint: { uploadedBytes: 4096 },
      });

      expect(reopenedRepo.getStepsForJob("job-005")).toHaveLength(2);
      expect(reopenedRepo.getStepsForJob("job-005").map((step) => step.stepKey)).toEqual([
        "generate_copy",
        "upload_assets",
      ]);
    } finally {
      reopenedDb.close();
    }
  });
});
