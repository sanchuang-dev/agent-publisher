import type { PublishPlatform } from "./publish-job.js";

/**
 * Minimal job persistence contracts for M2-02.
 *
 * Product/domain code depends on these types rather than the SQLite driver.
 * State-transition legality remains owned by M2-03.
 */

export const jobStatuses = [
  "created",
  "preparing_materials",
  "preparing_publish",
  "waiting_for_login",
  "waiting_for_approval",
  "publishing",
  "succeeded",
  "failed",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const stepStatuses = ["pending", "running", "succeeded", "failed", "skipped"] as const;

export type StepStatus = (typeof stepStatuses)[number];

export const publishModes = ["image_text", "video"] as const;

export type PublishMode = (typeof publishModes)[number];

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue =
  | JsonPrimitive
  | { readonly [key: string]: JsonValue }
  | readonly JsonValue[];

export type CheckpointData = Readonly<Record<string, JsonValue>>;

export interface Job {
  readonly id: string;
  readonly platform: PublishPlatform;
  readonly publishMode: PublishMode;
  readonly status: JobStatus;
  readonly currentStep: string | null;
  readonly briefJson: string;
  readonly checkpoint: CheckpointData | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly completedAt: string | null;
}

export interface JobStep {
  readonly id: string;
  readonly jobId: string;
  readonly stepKey: string;
  readonly status: StepStatus;
  readonly attempt: number;
  readonly inputJson: string | null;
  readonly outputJson: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface JobCheckpoint {
  readonly jobId: string;
  readonly status: JobStatus;
  readonly currentStep: string;
  readonly checkpoint: CheckpointData;
  readonly committedAt: string;
}

export interface CreateJobInput {
  readonly id: string;
  readonly platform: PublishPlatform;
  readonly publishMode: PublishMode;
  readonly briefJson: string;
}

export interface CheckpointInput {
  readonly status: JobStatus;
  readonly checkpoint: CheckpointData;
  /**
   * The durable current_step is derived from this stepKey. Keeping one source
   * prevents a checkpoint from claiming a different current step than the
   * job_steps record committed with it.
   */
  readonly step: {
    readonly id: string;
    readonly stepKey: string;
    readonly status: StepStatus;
    readonly attempt?: number;
    readonly inputJson?: string | null;
    readonly outputJson?: string | null;
    readonly errorCode?: string | null;
    readonly errorMessage?: string | null;
    readonly startedAt?: string | null;
    readonly finishedAt?: string | null;
  };
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

/**
 * Driver-agnostic contract consumed by orchestration/recovery code.
 *
 * Durable status/current-step progress is committed through commitCheckpoint;
 * standalone mutators are intentionally absent so callers cannot advance a job
 * without recording the corresponding step in the same transaction.
 */
export interface JobRepository {
  create(input: CreateJobInput): Job;
  getById(id: string): Job | null;
  commitCheckpoint(jobId: string, input: CheckpointInput): Job;
  loadLastCheckpoint(jobId: string): JobCheckpoint | null;
  getStepsForJob(jobId: string): readonly JobStep[];
}
