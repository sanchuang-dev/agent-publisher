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
      checkpoint: {
        reason: "login_required",
        actionRequestId: "action-login",
      },
      step: { id: "step-login", stepKey: "ensure_login", status: "running" },
      action: {
        id: "action-login",
        payload: { profileId: "profile-001" },
      },
    });

    expect(result.job).toMatchObject({
      status: "waiting_for_login",
      currentStep: "ensure_login",
      checkpoint: { reason: "login_required" },
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
      checkpoint: {
        reason: "approval_required",
        actionRequestId: "action-approval",
      },
      step: { id: "step-approval", stepKey: "verify_prepared", status: "succeeded" },
      action: {
        id: "action-approval",
        payload: { summaryVersion: 1 },
      },
    });

    expect(result.job).toMatchObject({
      status: "waiting_for_approval",
      currentStep: "verify_prepared",
      checkpoint: { reason: "approval_required" },
    });
    expect(result.action).toMatchObject({
      id: "action-approval",
      type: "approval_required",
      status: "open",
    });
    expect(actions.getCurrentOpenForJob("job-control")).toEqual(result.action);
  });

  test("replaying the same waiting pause reuses the existing action and step attempt", () => {
    const first = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required" },
      step: {
        id: "step-login-replay",
        stepKey: "ensure_login",
        status: "running",
        attempt: 1,
      },
      action: { id: "action-login-replay" },
    });

    const replay = control.enterWaiting({
      jobId: "job-control",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required", replayed: true },
      step: {
        id: "different-step-id-is-ignored-by-upsert",
        stepKey: "ensure_login",
        status: "running",
        attempt: 1,
      },
      action: { id: "action-login-duplicate" },
    });

    expect(first.action.id).toBe("action-login-replay");
    expect(replay.action.id).toBe("action-login-replay");
    expect(replay.job).toMatchObject({
      status: "waiting_for_login",
      currentStep: "ensure_login",
      checkpoint: {
        reason: "login_required",
        replayed: true,
        actionRequestId: "action-login-replay",
      },
    });
    expect(
      db.prepare(
        "SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ? AND status = 'open'",
      ).get("job-control"),
    ).toEqual({ count: 1 });
    expect(
      jobs.getStepsForJob("job-control").filter((step) => step.stepKey === "ensure_login"),
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
