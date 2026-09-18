import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "vitest";

import { JobControlService } from "../src/jobs/job-control-service.js";
import { ResumeInvariantError, ResumeService } from "../src/jobs/resume-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-resume-"));
  return { root, databasePath: join(root, "app.db") };
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

describe("ResumeService restart recovery", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("restart keeps waiting on the existing login action without duplication", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });

    jobs.create({
      id: "job-resume-open",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
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
    const resume = new ResumeService({ jobs: reopenedJobs, actionRequests: reopenedActions });

    try {
      expect(resume.resume("job-resume-open")).toMatchObject({
        kind: "waiting_for_action",
        job: { status: "waiting_for_login" },
        checkpoint: {
          status: "waiting_for_login",
          currentStep: "ensure_login",
          checkpoint: { reason: "login_required" },
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
    const control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });

    jobs.create({
      id: "job-resume-resolved",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
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
    const resume = new ResumeService({ jobs: reopenedJobs, actionRequests: reopenedActions });

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

  test("terminal jobs never resume into deterministic execution", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);

    jobs.create({
      id: "job-terminal-resume",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
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

  test("a waiting half-state without its persisted action is rejected instead of bypassed", () => {
    const { root, databasePath } = makeTempDb();
    cleanupRoots.push(root);

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);

    jobs.create({
      id: "job-broken-wait",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
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
