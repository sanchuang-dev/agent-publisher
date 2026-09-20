import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, test } from "vitest";

import {
  ExternalActionIdentityConflictError,
  ExternalActionNotFoundError,
  ExternalActionStateError,
  requiresVerifyFirst,
  type ExternalActionRepository as ExternalActionRepositoryContract,
} from "../src/contracts/external-action.js";
import { JobNotFoundError } from "../src/contracts/job.js";
import { openDatabase } from "../src/storage/db.js";
import { ExternalActionRepository } from "../src/storage/external-action-repository.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-external-actions-"));
  return { root, databasePath: join(root, "app.db") };
}

describe("ExternalActionRepository integration", () => {
  let root: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase> | null;
  let jobs: JobRepository;
  let actions: ExternalActionRepository;

  beforeEach(() => {
    ({ root, databasePath } = makeTempDb());
    db = openDatabase({ databasePath });
    jobs = new JobRepository(db);
    actions = new ExternalActionRepository(db);

    const contract: ExternalActionRepositoryContract = actions;
    expect(contract).toBe(actions);

    jobs.create({
      id: "job-external",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
    });
  });

  afterEach(() => {
    db?.close();
    rmSync(root, { recursive: true, force: true });
  });

  test("prepare is idempotent by job_id + action_key and preserves durable identity/state", () => {
    const first = actions.prepare({
      id: "external-001",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:primary",
    });

    expect(first).toMatchObject({
      id: "external-001",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:primary",
      status: "prepared",
      startedAt: null,
      finishedAt: null,
    });

    const duplicate = actions.prepare({
      id: "external-002",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:primary",
    });
    expect(duplicate).toEqual(first);

    const started = actions.start(first.id);
    expect(started.status).toBe("started");

    const replayAfterStart = actions.prepare({
      id: "external-003",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:primary",
    });
    expect(replayAfterStart.id).toBe(first.id);
    expect(replayAfterStart.status).toBe("started");

    expect(
      db!
        .prepare(
          "SELECT COUNT(*) AS count FROM external_actions WHERE job_id = ? AND action_key = ?",
        )
        .get("job-external", "publish:primary"),
    ).toEqual({ count: 1 });
  });

  test("prepare rejects an action-type mismatch without changing the existing action", () => {
    const first = actions.prepare({
      id: "external-type",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:type-bound",
    });

    expect(() =>
      actions.prepare({
        id: "external-type-replay",
        jobId: "job-external",
        actionType: "delete",
        actionKey: "publish:type-bound",
      }),
    ).toThrow(ExternalActionIdentityConflictError);

    expect(actions.getByKey("job-external", "publish:type-bound")).toEqual(first);
  });

  test("prepare requires an existing job and missing actions fail explicitly on mutation", () => {
    expect(() =>
      actions.prepare({
        id: "external-missing-job",
        jobId: "missing-job",
        actionType: "publish",
        actionKey: "publish:missing",
      }),
    ).toThrow(JobNotFoundError);

    expect(actions.getById("missing-action")).toBeNull();
    expect(() => actions.start("missing-action")).toThrow(
      ExternalActionNotFoundError,
    );
  });

  test("only prepared -> started -> terminal transitions are allowed", () => {
    const prepared = actions.prepare({
      id: "external-prepared",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:prepared",
    });

    expect(() => actions.markSucceeded(prepared.id)).toThrow(
      ExternalActionStateError,
    );
    expect(() => actions.markUnknown(prepared.id)).toThrow(
      ExternalActionStateError,
    );
    expect(() => actions.markFailed(prepared.id)).toThrow(
      ExternalActionStateError,
    );
    expect(actions.getById(prepared.id)?.status).toBe("prepared");

    const started = actions.start(prepared.id);
    expect(started.status).toBe("started");
    expect(started.startedAt).not.toBeNull();
    expect(() => actions.start(prepared.id)).toThrow(
      ExternalActionStateError,
    );
    expect(actions.getById(prepared.id)?.status).toBe("started");

    const outcomes = [
      {
        id: "external-success",
        key: "publish:success",
        finish: (id: string) =>
          actions.markSucceeded(id, { externalRef: "post-123" }),
        expected: "succeeded",
      },
      {
        id: "external-unknown",
        key: "publish:unknown",
        finish: (id: string) =>
          actions.markUnknown(id, {
            errorCode: "PUBLISH_RESULT_UNKNOWN",
            errorMessage: "connection lost after publish click",
          }),
        expected: "unknown",
      },
      {
        id: "external-failed",
        key: "publish:failed",
        finish: (id: string) =>
          actions.markFailed(id, {
            errorCode: "PUBLISH_FAILED",
            errorMessage: "platform rejected submission",
          }),
        expected: "failed",
      },
    ] as const;

    for (const outcome of outcomes) {
      const action = actions.prepare({
        id: outcome.id,
        jobId: "job-external",
        actionType: "publish",
        actionKey: outcome.key,
      });
      actions.start(action.id);
      const finished = outcome.finish(action.id);

      expect(finished.status).toBe(outcome.expected);
      expect(finished.finishedAt).not.toBeNull();
      expect(() => actions.start(action.id)).toThrow(
        ExternalActionStateError,
      );
      expect(() => actions.markSucceeded(action.id)).toThrow(
        ExternalActionStateError,
      );
      expect(() => actions.markUnknown(action.id)).toThrow(
        ExternalActionStateError,
      );
      expect(() => actions.markFailed(action.id)).toThrow(
        ExternalActionStateError,
      );
      expect(actions.getById(action.id)?.status).toBe(outcome.expected);
    }

    expect(actions.getById("external-success")?.externalRef).toBe("post-123");
    expect(actions.getById("external-unknown")).toMatchObject({
      errorCode: "PUBLISH_RESULT_UNKNOWN",
      errorMessage: "connection lost after publish click",
    });
  });

  test("started -> unknown survives reopen and requires verify-first recovery", () => {
    const action = actions.prepare({
      id: "external-restart",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:restart",
    });

    const started = actions.start(action.id);
    expect(requiresVerifyFirst(started)).toBe(true);

    const unknown = actions.markUnknown(action.id, {
      errorCode: "PUBLISH_RESULT_UNKNOWN",
    });
    expect(unknown.status).toBe("unknown");
    expect(requiresVerifyFirst(unknown)).toBe(true);

    db!.close();
    db = openDatabase({ databasePath });
    actions = new ExternalActionRepository(db);

    const reopened = actions.getByKey("job-external", "publish:restart");
    expect(reopened).not.toBeNull();
    expect(reopened).toMatchObject({
      id: "external-restart",
      status: "unknown",
      errorCode: "PUBLISH_RESULT_UNKNOWN",
    });
    expect(requiresVerifyFirst(reopened!)).toBe(true);

    expect(() => actions.start(reopened!.id)).toThrow(
      ExternalActionStateError,
    );
    expect(actions.getById(reopened!.id)?.status).toBe("unknown");

    const replayedPrepare = actions.prepare({
      id: "external-restart-new-id",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:restart",
    });
    expect(replayedPrepare.id).toBe("external-restart");
    expect(replayedPrepare.status).toBe("unknown");

    const verified = actions.resolveAfterVerification(reopened!.id, {
      status: "succeeded",
      externalRef: "post-after-recovery",
    });
    expect(verified).toMatchObject({
      id: "external-restart",
      status: "succeeded",
      externalRef: "post-after-recovery",
    });
    expect(requiresVerifyFirst(verified)).toBe(false);
    expect(() => actions.start(verified.id)).toThrow(
      ExternalActionStateError,
    );
  });

  test("verify-first resolution can settle started/unknown but cannot re-enter execution", () => {
    const prepared = actions.prepare({
      id: "external-verified-not-published",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:verified-not-published",
    });

    expect(() =>
      actions.resolveAfterVerification(prepared.id, {
        status: "failed",
        errorCode: "VERIFY_FAILED",
      }),
    ).toThrow(ExternalActionStateError);
    expect(actions.getById(prepared.id)?.status).toBe("prepared");

    const started = actions.start(prepared.id);
    expect(requiresVerifyFirst(started)).toBe(true);

    const verifiedNotPublished = actions.resolveAfterVerification(started.id, {
      status: "failed",
      errorCode: "PUBLISH_NOT_OBSERVED",
      errorMessage: "verification established that the publish did not occur",
    });
    expect(verifiedNotPublished).toMatchObject({
      id: prepared.id,
      status: "failed",
      errorCode: "PUBLISH_NOT_OBSERVED",
    });
    expect(requiresVerifyFirst(verifiedNotPublished)).toBe(false);
    expect(() => actions.start(verifiedNotPublished.id)).toThrow(
      ExternalActionStateError,
    );
    expect(() =>
      actions.resolveAfterVerification(verifiedNotPublished.id, {
        status: "succeeded",
        externalRef: "late-post",
      }),
    ).toThrow(ExternalActionStateError);
  });

  test("prepared recovery remains startable while succeeded/failed are settled", () => {
    const prepared = actions.prepare({
      id: "external-recovery-prepared",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:recovery-prepared",
    });
    expect(requiresVerifyFirst(prepared)).toBe(false);

    const success = actions.prepare({
      id: "external-recovery-success",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:recovery-success",
    });
    actions.start(success.id);
    expect(requiresVerifyFirst(actions.markSucceeded(success.id))).toBe(false);

    const failed = actions.prepare({
      id: "external-recovery-failed",
      jobId: "job-external",
      actionType: "publish",
      actionKey: "publish:recovery-failed",
    });
    actions.start(failed.id);
    expect(requiresVerifyFirst(actions.markFailed(failed.id))).toBe(false);
  });
});
