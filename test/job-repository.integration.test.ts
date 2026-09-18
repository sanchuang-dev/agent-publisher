import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "vitest";

import { JobNotFoundError, type JobRepository as JobRepositoryContract } from "../src/contracts/job.js";
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
          id: "step-id-2",
          stepKey: "generate_copy",
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

  test("reopen recovery loads the last committed checkpoint and step history", () => {
    repo.create({
      id: "job-005",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: "{}",
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

      expect(reopenedRepo.getStepsForJob("job-005")).toHaveLength(1);
      expect(reopenedRepo.getStepsForJob("job-005")[0]?.stepKey).toBe("upload_assets");
    } finally {
      reopenedDb.close();
    }
  });
});
