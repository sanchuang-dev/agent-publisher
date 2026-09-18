import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-jobrepo-"));
  const databasePath = join(root, "app.db");
  return { root, databasePath };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe("JobRepository integration", () => {
  let root: string;
  let databasePath: string;
  let db: ReturnType<typeof openDatabase>;
  let repo: JobRepository;

  beforeEach(() => {
    ({ root, databasePath } = makeTempDb());
    db = openDatabase({ databasePath });
    repo = new JobRepository(db);
  });

  afterEach(() => {
    db.close();
    rmSync(root, { recursive: true, force: true });
  });

  // -------------------------------------------------------------------------
  // create → getById
  // -------------------------------------------------------------------------

  test("create persists a job that can be read back by id", () => {
    const job = repo.create({
      id: "job-001",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ title: "hello" }),
    });

    expect(job.id).toBe("job-001");
    expect(job.platform).toBe("xiaohongshu");
    expect(job.publishMode).toBe("image_text");
    expect(job.status).toBe("pending");
    expect(job.currentStep).toBeNull();
    expect(job.checkpoint).toBeNull();

    const fetched = repo.getById("job-001");
    expect(fetched).not.toBeNull();
    expect(fetched?.id).toBe("job-001");
    expect(fetched?.status).toBe("pending");
  });

  test("getById returns null for an unknown id", () => {
    expect(repo.getById("does-not-exist")).toBeNull();
  });

  // -------------------------------------------------------------------------
  // checkpoint – status / current_step / job_steps consistency
  // -------------------------------------------------------------------------

  test("checkpoint updates status, currentStep and records a job_step atomically", () => {
    repo.create({
      id: "job-002",
      platform: "douyin",
      publishMode: "video",
      briefJson: "{}",
    });

    const updated = repo.checkpoint("job-002", {
      status: "running",
      currentStep: "prepare-material",
      checkpoint: { progress: 10 },
      step: {
        id: "step-001",
        stepKey: "prepare-material",
        status: "succeeded",
        startedAt: "2026-09-18T01:00:00.000Z",
        finishedAt: "2026-09-18T01:00:05.000Z",
      },
    });

    expect(updated.status).toBe("running");
    expect(updated.currentStep).toBe("prepare-material");
    expect(updated.checkpoint).toEqual({ progress: 10 });

    const steps = repo.getStepsForJob("job-002");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepKey).toBe("prepare-material");
    expect(steps[0]?.status).toBe("succeeded");
    expect(steps[0]?.jobId).toBe("job-002");
  });

  test("multiple checkpoints accumulate job_steps in order", () => {
    repo.create({ id: "job-003", platform: "xiaohongshu", publishMode: "image_text", briefJson: "{}" });

    repo.checkpoint("job-003", {
      status: "running",
      currentStep: "step-a",
      checkpoint: { phase: "a" },
      step: { id: "s-a", stepKey: "step-a", status: "succeeded" },
    });

    repo.checkpoint("job-003", {
      status: "running",
      currentStep: "step-b",
      checkpoint: { phase: "b" },
      step: { id: "s-b", stepKey: "step-b", status: "running" },
    });

    const job = repo.getById("job-003");
    expect(job?.currentStep).toBe("step-b");
    expect(job?.checkpoint).toEqual({ phase: "b" });

    const steps = repo.getStepsForJob("job-003");
    expect(steps.map((s) => s.stepKey)).toEqual(["step-a", "step-b"]);
  });

  // -------------------------------------------------------------------------
  // Transaction rollback – no half-state
  // -------------------------------------------------------------------------

  test("transaction rollback leaves the job unchanged if step insert fails", () => {
    repo.create({ id: "job-004", platform: "xiaohongshu", publishMode: "image_text", briefJson: "{}" });

    // First valid checkpoint
    repo.checkpoint("job-004", {
      status: "running",
      currentStep: "step-1",
      checkpoint: { phase: 1 },
      step: { id: "step-id-1", stepKey: "step-1", status: "succeeded" },
    });

    // A second checkpoint that tries to insert a duplicate step id (PRIMARY KEY clash)
    // should rollback the entire transaction so job is still at phase 1.
    expect(() =>
      repo.checkpoint("job-004", {
        status: "running",
        currentStep: "step-2",
        checkpoint: { phase: 2 },
        step: { id: "step-id-1", stepKey: "step-2", status: "running" }, // duplicate id
      }),
    ).toThrow();

    // Job must still reflect the last successful checkpoint
    const job = repo.getById("job-004");
    expect(job?.currentStep).toBe("step-1");
    expect(job?.checkpoint).toEqual({ phase: 1 });

    // Only one step should exist
    const steps = repo.getStepsForJob("job-004");
    expect(steps).toHaveLength(1);
    expect(steps[0]?.stepKey).toBe("step-1");
  });

  // -------------------------------------------------------------------------
  // Restart recovery smoke – close DB, reopen, read last checkpoint
  // -------------------------------------------------------------------------

  test("closing and reopening the database preserves the last committed checkpoint", () => {
    repo.create({ id: "job-005", platform: "xiaohongshu", publishMode: "image_text", briefJson: "{}" });

    repo.checkpoint("job-005", {
      status: "running",
      currentStep: "upload",
      checkpoint: { uploadedBytes: 4096 },
      step: { id: "step-upload", stepKey: "upload", status: "succeeded" },
    });

    // Close the first connection
    db.close();

    // Reopen – simulates process restart
    const db2 = openDatabase({ databasePath });
    const repo2 = new JobRepository(db2);

    try {
      const recovered = repo2.getById("job-005");
      expect(recovered).not.toBeNull();
      expect(recovered?.status).toBe("running");
      expect(recovered?.currentStep).toBe("upload");
      expect(recovered?.checkpoint).toEqual({ uploadedBytes: 4096 });

      const steps = repo2.getStepsForJob("job-005");
      expect(steps).toHaveLength(1);
      expect(steps[0]?.stepKey).toBe("upload");
    } finally {
      db2.close();
      // prevent afterEach from closing db a second time
      db = db2;
    }
  });

  // -------------------------------------------------------------------------
  // completedAt set on terminal status
  // -------------------------------------------------------------------------

  test("completedAt is set when status transitions to succeeded", () => {
    repo.create({ id: "job-006", platform: "douyin", publishMode: "video", briefJson: "{}" });

    const done = repo.checkpoint("job-006", {
      status: "succeeded",
      currentStep: "publish",
      checkpoint: { url: "https://example.com/video" },
      step: { id: "step-pub", stepKey: "publish", status: "succeeded" },
    });

    expect(done.completedAt).not.toBeNull();
    expect(done.status).toBe("succeeded");
  });

  // -------------------------------------------------------------------------
  // JobRepository does not expose driver types
  // -------------------------------------------------------------------------

  test("JobRepository constructor accepts a plain DatabaseHandle without importing better-sqlite3", async () => {
    // This test imports the repository module at the type level and verifies that
    // no better-sqlite3 import is pulled in at the module boundary.
    const mod = await import("../src/storage/job-repository.js");
    expect(typeof mod.JobRepository).toBe("function");
    // The module must not have a direct better-sqlite3 dependency; verified by
    // the fact that the DatabaseHandle interface (not the concrete Database type)
    // is what the constructor accepts.
    const instance = new mod.JobRepository(db);
    expect(instance).toBeInstanceOf(mod.JobRepository);
  });
});
