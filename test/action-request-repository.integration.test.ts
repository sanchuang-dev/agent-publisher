import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ActionRequestStateError,
  OpenActionRequestConflictError,
  type ActionRequestRepository as ActionRequestRepositoryContract,
} from "../src/contracts/job.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-action-request-"));
  return { root, databasePath: join(root, "app.db") };
}

describe("ActionRequestRepository integration", () => {
  let root: string;
  let db: ReturnType<typeof openDatabase> | null;
  let jobs: JobRepository;
  let actionRequests: ActionRequestRepository;

  beforeEach(() => {
    const temp = makeTempDb();
    root = temp.root;
    db = openDatabase({ databasePath: temp.databasePath });
    jobs = new JobRepository(db);
    actionRequests = new ActionRequestRepository(db);

    const contract: ActionRequestRepositoryContract = actionRequests;
    expect(contract).toBe(actionRequests);

    jobs.create({
      id: "job-action",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("open reuses the existing open request for the same job and type", () => {
    const first = actionRequests.open({
      id: "action-001",
      jobId: "job-action",
      type: "login_required",
      payload: { profileId: "profile-001" },
    });

    const replay = actionRequests.open({
      id: "action-002",
      jobId: "job-action",
      type: "login_required",
      payload: { replay: true },
    });

    expect(replay).toEqual(first);
    expect(actionRequests.getCurrentOpenForJob("job-action")).toEqual(first);
    expect(actionRequests.getById(first.id)).toEqual(first);
    expect(
      db!.prepare("SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ?").get("job-action"),
    ).toEqual({ count: 1 });
  });

  test("a job cannot own two different open human actions at once", () => {
    actionRequests.open({
      id: "action-login",
      jobId: "job-action",
      type: "login_required",
    });

    expect(() =>
      actionRequests.open({
        id: "action-approval",
        jobId: "job-action",
        type: "approval_required",
      }),
    ).toThrow(OpenActionRequestConflictError);

    expect(
      db!.prepare("SELECT COUNT(*) AS count FROM action_requests WHERE status = 'open'").get(),
    ).toEqual({ count: 1 });
  });

  test("resolve closes the action and allows the next human action", () => {
    const login = actionRequests.open({
      id: "action-login-resolve",
      jobId: "job-action",
      type: "login_required",
    });

    const resolved = actionRequests.resolve(login.id, { loginDetected: true });
    expect(resolved.status).toBe("resolved");
    expect(resolved.resolution).toEqual({ loginDetected: true });
    expect(resolved.resolvedAt).not.toBeNull();
    expect(actionRequests.getCurrentOpenForJob("job-action")).toBeNull();
    expect(actionRequests.getLatestForJob("job-action", "login_required")).toEqual(resolved);

    const approval = actionRequests.open({
      id: "action-approval",
      jobId: "job-action",
      type: "approval_required",
    });
    expect(approval.status).toBe("open");
  });

  test("cancel is durable and a conflicting second close is rejected", () => {
    const action = actionRequests.open({
      id: "action-cancel",
      jobId: "job-action",
      type: "clarification_required",
      payload: { field: "title" },
    });

    const cancelled = actionRequests.cancel(action.id, { reason: "user aborted" });
    expect(cancelled.status).toBe("cancelled");
    expect(cancelled.resolution).toEqual({ reason: "user aborted" });
    expect(actionRequests.getCurrentOpenForJob("job-action")).toBeNull();

    expect(() => actionRequests.resolve(action.id)).toThrow(ActionRequestStateError);
  });
});
