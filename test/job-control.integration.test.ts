import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JobControlService } from "../src/jobs/job-control-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-job-control-"));
  return { root, databasePath: join(root, "app.db") };
}

describe("JobControlService waiting atomicity", () => {
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

    jobs.create({
      id: "job-control",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
    jobs.commitCheckpoint("job-control", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "step-copy", stepKey: "generate_copy", status: "succeeded" },
    });
    jobs.commitCheckpoint("job-control", {
      status: "preparing_publish",
      checkpoint: { phase: "browser" },
      step: { id: "step-browser", stepKey: "open_platform", status: "succeeded" },
    });
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("entering waiting_for_login commits checkpoint and login action together", () => {
    const result = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required" },
      step: { id: "step-login", stepKey: "ensure_login", status: "running" },
      action: {
        id: "action-login",
        payload: { profileId: "profile-001" },
      },
    });

    expect(result.job).toMatchObject({
      status: "waiting_for_login",
      currentStep: "ensure_login",
      checkpoint: {
        reason: "login_required",
        actionRequestId: "action-login",
      },
    });
    expect(result.action).toMatchObject({
      id: "action-login",
      type: "login_required",
      status: "open",
    });
    expect(actions.getCurrentOpenForJob("job-control")).toEqual(result.action);
    expect(jobs.getStepsForJob("job-control").map((step) => step.stepKey)).toEqual([
      "generate_copy",
      "open_platform",
      "ensure_login",
    ]);
  });

  test("entering waiting_for_approval commits checkpoint and approval action together", () => {
    const result = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required" },
      step: { id: "step-approval", stepKey: "verify_prepared", status: "succeeded" },
      action: {
        id: "action-approval",
        payload: { summaryVersion: 1 },
      },
    });

    expect(result.job).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        reason: "approval_required",
        actionRequestId: "action-approval",
      },
    });
    expect(result.action).toMatchObject({
      id: "action-approval",
      type: "approval_required",
      status: "open",
    });
    expect(actions.getCurrentOpenForJob("job-control")).toEqual(result.action);
  });

  test("replaying an open approval freezes the checkpoint and human-facing payload", () => {
    const first = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required", summaryVersion: 1 },
      step: {
        id: "step-approval-replay",
        stepKey: "verify_prepared",
        status: "succeeded",
        attempt: 1,
      },
      action: {
        id: "action-approval-replay",
        payload: { summaryVersion: 1 },
      },
    });

    const replay = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required", summaryVersion: 2 },
      step: {
        id: "different-step-id-must-not-replace-the-pause",
        stepKey: "verify_prepared",
        status: "succeeded",
        attempt: 1,
      },
      action: {
        id: "action-approval-duplicate",
        payload: { summaryVersion: 2 },
      },
    });

    expect(first.action).toMatchObject({
      id: "action-approval-replay",
      payload: { summaryVersion: 1 },
    });

    expect(() =>
      jobs.commitCheckpoint("job-control", {
        status: "waiting_for_approval",
        checkpoint: { reason: "approval_required", summaryVersion: 99 },
        step: {
          id: "direct-repository-replay-must-not-mutate",
          stepKey: "verify_prepared",
          status: "succeeded",
          attempt: 2,
        },
      }),
    ).toThrow(/still open/);

    expect(replay.action).toEqual(first.action);
    expect(replay.job).toEqual(first.job);
    expect(replay.job).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        reason: "approval_required",
        summaryVersion: 1,
        actionRequestId: "action-approval-replay",
      },
    });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ? AND status = 'open'",
      ).get("job-control"),
    ).toEqual({ count: 1 });
    expect(
      jobs.getStepsForJob("job-control").filter((step) => step.stepKey === "verify_prepared"),
    ).toHaveLength(1);
  });

  test("stale approval is atomically cancelled and replaced with clarification", () => {
    const waiting = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_approval",
      checkpoint: { phase: "prepared", summaryVersion: 1 },
      step: {
        id: "step-approved-target",
        stepKey: "verify_prepared",
        status: "succeeded",
        attempt: 1,
      },
      action: {
        id: "approval-stale",
        payload: { summaryVersion: 1 },
      },
    });

    const recovered = control.invalidateApprovalForClarification({
      jobId: "job-control",
      approvalRequestId: waiting.action.id,
      cancellationResolution: {
        reason: "prepared_state_changed",
        failureCode: "PREPARED_VALIDATION_FAILED",
      },
      checkpoint: {
        phase: "xhs_prepare_recovery_required",
        failureCode: "PREPARED_VALIDATION_FAILED",
      },
      step: {
        id: "step-stale-target",
        stepKey: "verify_prepared",
        status: "failed",
        attempt: 2,
        errorCode: "PREPARED_VALIDATION_FAILED",
      },
      action: {
        id: "clarification-stale",
        payload: {
          reason: "prepare_recovery_required",
          failureCode: "PREPARED_VALIDATION_FAILED",
        },
      },
    });

    expect(actions.getById("approval-stale")).toMatchObject({
      status: "cancelled",
      resolution: {
        reason: "prepared_state_changed",
        failureCode: "PREPARED_VALIDATION_FAILED",
      },
    });
    expect(recovered.job).toMatchObject({
      status: "preparing_publish",
      currentStep: "verify_prepared",
      checkpoint: {
        phase: "xhs_prepare_recovery_required",
        actionRequestId: "clarification-stale",
      },
    });
    expect(recovered.action).toMatchObject({
      id: "clarification-stale",
      type: "clarification_required",
      status: "open",
    });
    expect(actions.getCurrentOpenForJob("job-control")).toEqual(
      recovered.action,
    );
  });

  test("stale approval replacement rolls back if clarification creation fails", () => {
    const occupied = actions.open({
      id: "clarification-collision",
      jobId: "job-control",
      type: "clarification_required",
    });
    actions.resolve(occupied.id, { answered: true });

    const waiting = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_approval",
      checkpoint: { phase: "prepared", summaryVersion: 1 },
      step: {
        id: "step-approval-rollback",
        stepKey: "verify_prepared",
        status: "succeeded",
        attempt: 1,
      },
      action: {
        id: "approval-rollback",
        payload: { summaryVersion: 1 },
      },
    });

    expect(() =>
      control.invalidateApprovalForClarification({
        jobId: "job-control",
        approvalRequestId: waiting.action.id,
        cancellationResolution: {
          reason: "prepared_state_changed",
        },
        checkpoint: {
          phase: "xhs_prepare_recovery_required",
        },
        step: {
          id: "step-approval-rollback-failed",
          stepKey: "verify_prepared",
          status: "failed",
          attempt: 2,
          errorCode: "PREPARED_VALIDATION_FAILED",
        },
        action: {
          id: "clarification-collision",
          payload: { reason: "prepared_state_changed" },
        },
      }),
    ).toThrow();

    expect(actions.getById(waiting.action.id)).toMatchObject({
      id: waiting.action.id,
      type: "approval_required",
      status: "open",
      resolution: null,
    });
    expect(actions.getCurrentOpenForJob("job-control")).toMatchObject({
      id: waiting.action.id,
      type: "approval_required",
      status: "open",
    });
    expect(jobs.getById("job-control")).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: {
        phase: "prepared",
        summaryVersion: 1,
        actionRequestId: waiting.action.id,
      },
    });
    expect(
      jobs
        .getStepsForJob("job-control")
        .filter((step) => step.stepKey === "verify_prepared"),
    ).toHaveLength(1);
  });

  test("an ActionRequest insert failure rolls back the waiting checkpoint and step", () => {
    const occupied = actions.open({
      id: "action-collision",
      jobId: "job-control",
      type: "clarification_required",
    });
    actions.resolve(occupied.id, { answered: true });

    expect(() =>
      control.enterWaiting({
        jobId: "job-control",
        status: "waiting_for_login",
        checkpoint: { reason: "login_required" },
        step: { id: "step-login-fail", stepKey: "ensure_login", status: "running" },
        action: { id: "action-collision" },
      }),
    ).toThrow();

    expect(jobs.getById("job-control")).toMatchObject({
      status: "preparing_publish",
      currentStep: "open_platform",
      checkpoint: { phase: "browser" },
    });
    expect(jobs.loadLastCheckpoint("job-control")).toMatchObject({
      status: "preparing_publish",
      currentStep: "open_platform",
      checkpoint: { phase: "browser" },
    });
    expect(jobs.getStepsForJob("job-control").map((step) => step.stepKey)).toEqual([
      "generate_copy",
      "open_platform",
    ]);
    expect(actions.getCurrentOpenForJob("job-control")).toBeNull();
    expect(actions.getById("action-collision")).toMatchObject({
      id: "action-collision",
      type: "clarification_required",
      status: "resolved",
      resolution: { answered: true },
    });
    expect(
      db.prepare("SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ?").get("job-control"),
    ).toEqual({ count: 1 });
  });
});
