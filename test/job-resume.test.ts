import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import {
  InvalidActionRequestResolutionError,
} from "../src/contracts/job.js";
import {
  ApprovalNotGrantedError,
  JobControlService,
} from "../src/jobs/job-control-service.js";
import { ResumeInvariantError, ResumeService } from "../src/jobs/resume-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-resume-"));
  return { root, databasePath: join(root, "app.db") };
}

function createControl(
  db: ReturnType<typeof openDatabase>,
  jobs: JobRepository,
  actions: ActionRequestRepository,
): JobControlService {
  return new JobControlService({
    jobs,
    actionRequests: actions,
    runInTransaction: (work) => db.transaction(work)(),
  });
}

function advanceToPreparingPublish(jobs: JobRepository, jobId: string): void {
  jobs.commitCheckpoint(jobId, {
    status: "preparing_materials",
    checkpoint: { phase: "copy" },
    step: { id: `${jobId}-copy`, stepKey: "generate_copy", status: "succeeded" },
  });
  jobs.commitCheckpoint(jobId, {
    status: "preparing_publish",
    checkpoint: { phase: "browser" },
    step: { id: `${jobId}-browser`, stepKey: "open_platform", status: "succeeded" },
  });
}

function createJob(jobs: JobRepository, id: string): void {
  jobs.create({
    id,
    platform: "xiaohongshu",
    publishMode: "image_text",
    briefJson: "{}",
  });
}

describe("ResumeService restart recovery", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart keeps waiting on the checkpoint-bound login action without duplication", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-resume-open");
    advanceToPreparingPublish(jobs, "job-resume-open");
    control.enterWaiting({
      jobId: "job-resume-open",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required" },
      step: { id: "step-login", stepKey: "ensure_login", status: "running" },
      action: { id: "action-login-1", payload: { profileId: "profile-001" } },
    });
    db.close();

    const reopenedDb = openDatabase({ databasePath });
    const reopenedJobs = new JobRepository(reopenedDb);
    const reopenedActions = new ActionRequestRepository(reopenedDb);
    const resume = new ResumeService({
      jobs: reopenedJobs,
      actionRequests: reopenedActions,
    });

    try {
      expect(resume.resume("job-resume-open")).toMatchObject({
        kind: "waiting_for_action",
        job: { status: "waiting_for_login" },
        checkpoint: {
          status: "waiting_for_login",
          currentStep: "ensure_login",
          checkpoint: {
            reason: "login_required",
            actionRequestId: "action-login-1",
          },
        },
        action: {
          id: "action-login-1",
          type: "login_required",
          status: "open",
        },
      });

      expect(
        reopenedActions.open({
          id: "action-login-2",
          jobId: "job-resume-open",
          type: "login_required",
          payload: { replay: true },
        }),
      ).toMatchObject({ id: "action-login-1", status: "open" });

      expect(
        reopenedDb
          .prepare("SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ?")
          .get("job-resume-open"),
      ).toEqual({ count: 1 });
    } finally {
      reopenedDb.close();
    }
  });

  test("resolved login action resumes as ready and permits the legal return transition", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-resume-resolved");
    advanceToPreparingPublish(jobs, "job-resume-resolved");
    control.enterWaiting({
      jobId: "job-resume-resolved",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required" },
      step: { id: "step-login-resolve", stepKey: "ensure_login", status: "running" },
      action: { id: "action-login-resolve" },
    });
    db.close();

    const reopenedDb = openDatabase({ databasePath });
    const reopenedJobs = new JobRepository(reopenedDb);
    const reopenedActions = new ActionRequestRepository(reopenedDb);
    const resume = new ResumeService({
      jobs: reopenedJobs,
      actionRequests: reopenedActions,
    });

    try {
      reopenedActions.resolve("action-login-resolve", { loginDetected: true });

      expect(resume.resume("job-resume-resolved")).toMatchObject({
        kind: "ready_to_continue",
        job: { status: "waiting_for_login" },
        resolvedAction: {
          id: "action-login-resolve",
          status: "resolved",
        },
      });

      expect(() =>
        reopenedJobs.commitCheckpoint("job-resume-resolved", {
          status: "preparing_publish",
          checkpoint: { phase: "post-login" },
          step: { id: "step-upload", stepKey: "upload_assets", status: "running" },
        }),
      ).not.toThrow();
    } finally {
      reopenedDb.close();
    }
  });

  test("affirmative approval is the only path through the control service into publishing", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-approval-positive");
    advanceToPreparingPublish(jobs, "job-approval-positive");
    control.enterWaiting({
      jobId: "job-approval-positive",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required" },
      step: { id: "approval-step", stepKey: "verify_prepared", status: "succeeded" },
      action: { id: "approval-action" },
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-approval-positive")).toMatchObject({
      kind: "waiting_for_action",
      action: { id: "approval-action", type: "approval_required", status: "open" },
    });

    actions.resolve("approval-action", { approved: true });

    expect(resume.resume("job-approval-positive")).toMatchObject({
      kind: "ready_to_continue",
      job: { status: "waiting_for_approval" },
      resolvedAction: {
        id: "approval-action",
        status: "resolved",
        resolution: { approved: true },
      },
    });

    const publishing = control.beginPublishingAfterApproval({
      jobId: "job-approval-positive",
      checkpoint: { phase: "publishing" },
      step: { id: "publish-step", stepKey: "publish_once", status: "running" },
    });

    expect(publishing).toMatchObject({
      status: "publishing",
      currentStep: "publish_once",
      checkpoint: { phase: "publishing" },
    });
    db.close();
  });

  test("rejected approval is non-continuable and returns to preparing_publish for revision", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-approval-rejected");
    advanceToPreparingPublish(jobs, "job-approval-rejected");
    control.enterWaiting({
      jobId: "job-approval-rejected",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required" },
      step: { id: "approval-reject-step", stepKey: "verify_prepared", status: "succeeded" },
      action: { id: "approval-reject-action" },
    });

    actions.resolve("approval-reject-action", { approved: false });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-approval-rejected")).toMatchObject({
      kind: "approval_rejected",
      job: { status: "waiting_for_approval" },
      action: {
        id: "approval-reject-action",
        status: "resolved",
        resolution: { approved: false },
      },
      nextStatus: "preparing_publish",
    });

    expect(() =>
      control.beginPublishingAfterApproval({
        jobId: "job-approval-rejected",
        checkpoint: { phase: "publishing" },
        step: { id: "unsafe-publish", stepKey: "publish_once", status: "running" },
      }),
    ).toThrow(ApprovalNotGrantedError);

    const revision = jobs.commitCheckpoint("job-approval-rejected", {
      status: "preparing_publish",
      checkpoint: { phase: "revision" },
      step: { id: "revision-step", stepKey: "fill_form", status: "running", attempt: 2 },
    });
    expect(revision.status).toBe("preparing_publish");
    db.close();
  });

  test("approval cannot be resolved without an explicit boolean decision", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-approval-missing-decision");
    advanceToPreparingPublish(jobs, "job-approval-missing-decision");
    control.enterWaiting({
      jobId: "job-approval-missing-decision",
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required" },
      step: { id: "approval-missing-step", stepKey: "verify_prepared", status: "succeeded" },
      action: { id: "approval-missing-action" },
    });

    expect(() => actions.resolve("approval-missing-action")).toThrow(
      InvalidActionRequestResolutionError,
    );
    expect(actions.getById("approval-missing-action")).toMatchObject({
      status: "open",
      resolution: null,
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-approval-missing-decision")).toMatchObject({
      kind: "waiting_for_action",
      action: { id: "approval-missing-action", status: "open" },
    });

    expect(() =>
      control.beginPublishingAfterApproval({
        jobId: "job-approval-missing-decision",
        checkpoint: { phase: "publishing" },
        step: { id: "missing-decision-publish", stepKey: "publish_once", status: "running" },
      }),
    ).toThrow(ApprovalNotGrantedError);
    db.close();
  });

  test("cancelled waiting action is surfaced as non-continuable recovery state", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-login-cancelled");
    advanceToPreparingPublish(jobs, "job-login-cancelled");
    control.enterWaiting({
      jobId: "job-login-cancelled",
      status: "waiting_for_login",
      checkpoint: { reason: "login_required" },
      step: { id: "cancel-login-step", stepKey: "ensure_login", status: "running" },
      action: { id: "cancel-login-action" },
    });
    actions.cancel("cancel-login-action", { reason: "operator aborted" });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-login-cancelled")).toMatchObject({
      kind: "action_cancelled",
      job: { status: "waiting_for_login" },
      action: {
        id: "cancel-login-action",
        type: "login_required",
        status: "cancelled",
      },
    });
    db.close();
  });

  test("clarification_required pauses the current state and resolves without inventing a new Job status", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = createControl(db, jobs, actions);

    createJob(jobs, "job-clarification");
    jobs.commitCheckpoint("job-clarification", {
      status: "preparing_materials",
      checkpoint: { phase: "brief" },
      step: { id: "clarify-step-start", stepKey: "generate_plan", status: "running" },
    });

    control.requestClarification({
      jobId: "job-clarification",
      checkpoint: { phase: "brief", reason: "clarification_required" },
      step: { id: "clarify-step", stepKey: "generate_plan", status: "running", attempt: 2 },
      action: {
        id: "clarification-action",
        payload: { field: "audience" },
      },
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-clarification")).toMatchObject({
      kind: "waiting_for_action",
      job: { status: "preparing_materials" },
      checkpoint: {
        checkpoint: {
          reason: "clarification_required",
          actionRequestId: "clarification-action",
        },
      },
      action: { id: "clarification-action", type: "clarification_required", status: "open" },
    });

    actions.resolve("clarification-action", { answer: "engineering managers" });
    expect(resume.resume("job-clarification")).toMatchObject({
      kind: "ready_to_continue",
      job: { status: "preparing_materials" },
      resolvedAction: { id: "clarification-action", status: "resolved" },
    });
    db.close();
  });

  test("terminal jobs never resume into deterministic execution", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);

    createJob(jobs, "job-terminal-resume");
    jobs.commitCheckpoint("job-terminal-resume", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "terminal-copy", stepKey: "generate_copy", status: "failed" },
    });
    jobs.commitCheckpoint("job-terminal-resume", {
      status: "failed",
      checkpoint: { phase: "failed" },
      step: { id: "terminal-failed", stepKey: "generate_copy", status: "failed", attempt: 2 },
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(resume.resume("job-terminal-resume")).toMatchObject({
      kind: "terminal",
      job: { status: "failed" },
    });
    db.close();
  });

  test("terminal job with an open ActionRequest fails closed as an invariant violation", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);

    createJob(jobs, "job-terminal-open-action");
    jobs.commitCheckpoint("job-terminal-open-action", {
      status: "preparing_materials",
      checkpoint: { phase: "copy" },
      step: { id: "terminal-open-copy", stepKey: "generate_copy", status: "failed" },
    });
    jobs.commitCheckpoint("job-terminal-open-action", {
      status: "failed",
      checkpoint: { phase: "failed" },
      step: {
        id: "terminal-open-failed",
        stepKey: "generate_copy",
        status: "failed",
        attempt: 2,
      },
    });

    actions.open({
      id: "terminal-open-action",
      jobId: "job-terminal-open-action",
      type: "clarification_required",
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(() => resume.resume("job-terminal-open-action")).toThrow(ResumeInvariantError);
    db.close();
  });

  test("a waiting half-state without a checkpoint-bound action is rejected instead of bypassed", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);

    createJob(jobs, "job-broken-wait");
    advanceToPreparingPublish(jobs, "job-broken-wait");
    jobs.commitCheckpoint("job-broken-wait", {
      status: "waiting_for_approval",
      checkpoint: { reason: "approval_required" },
      step: { id: "broken-approval", stepKey: "verify_prepared", status: "succeeded" },
    });

    const resume = new ResumeService({ jobs, actionRequests: actions });
    expect(() => resume.resume("job-broken-wait")).toThrow(ResumeInvariantError);
    db.close();
  });
});
