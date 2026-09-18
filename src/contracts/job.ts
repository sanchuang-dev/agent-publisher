/**
 * Minimal job domain contract for M2-02.
 *
 * Only exposes the fields needed by the JobRepository layer;
 * does not import or re-export any SQLite driver types.
 */

export const jobStatuses = [
  "pending",
  "running",
  "paused",
  "succeeded",
  "failed",
  "cancelled",
] as const;

export type JobStatus = (typeof jobStatuses)[number];

export const stepStatuses = ["pending", "running", "succeeded", "failed", "skipped"] as const;

export type StepStatus = (typeof stepStatuses)[number];

export const publishModes = ["image_text", "video"] as const;

export type PublishMode = (typeof publishModes)[number];

/** Persisted checkpoint data – arbitrary serialisable value. */
export type CheckpointData = Record<string, unknown>;

export interface Job {
  readonly id: string;
  readonly platform: string;
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

export interface CreateJobInput {
  readonly id: string;
  readonly platform: string;
  readonly publishMode: PublishMode;
  readonly briefJson: string;
}

export interface CheckpointInput {
  /** New status to apply to the job. */
  readonly status: JobStatus;
  /** The step key that was just completed/started. */
  readonly currentStep: string;
  /** Arbitrary checkpoint payload to persist. */
  readonly checkpoint: CheckpointData;
  /** Step record to append inside the same transaction. */
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
