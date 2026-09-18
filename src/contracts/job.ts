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

export const actionRequestTypes = [
  "login_required",
  "approval_required",
  "clarification_required",
] as const;

export type ActionRequestType = (typeof actionRequestTypes)[number];

export const actionRequestStatuses = ["open", "resolved", "cancelled"] as const;

export type ActionRequestStatus = (typeof actionRequestStatuses)[number];

export interface ActionRequest {
  readonly id: string;
  readonly jobId: string;
  readonly type: ActionRequestType;
  readonly status: ActionRequestStatus;
  readonly payload: JsonValue | null;
  readonly resolution: JsonValue | null;
  readonly createdAt: string;
  readonly resolvedAt: string | null;
}

export interface OpenActionRequestInput {
  readonly id: string;
  readonly jobId: string;
  readonly type: ActionRequestType;
  readonly payload?: JsonValue | null;
}

export type ApprovalResolution = Readonly<Record<string, JsonValue>> & {
  readonly approved: boolean;
};

export const humanActionCheckpointKey = "actionRequestId" as const;

export function isApprovalResolution(value: JsonValue | null): value is ApprovalResolution {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    typeof value.approved === "boolean"
  );
}

export function getCheckpointActionRequestId(checkpoint: CheckpointData): string | null {
  const value = checkpoint[humanActionCheckpointKey];
  return typeof value === "string" && value.length > 0 ? value : null;
}

export class JobNotFoundError extends Error {
  constructor(readonly jobId: string) {
    super(`Job not found: ${jobId}`);
    this.name = "JobNotFoundError";
  }
}

export class ActionRequestNotFoundError extends Error {
  constructor(readonly actionRequestId: string) {
    super(`ActionRequest not found: ${actionRequestId}`);
    this.name = "ActionRequestNotFoundError";
  }
}

export class OpenActionRequestConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly existingType: ActionRequestType,
    readonly requestedType: ActionRequestType,
  ) {
    super(
      `Job ${jobId} already has open ActionRequest ${existingType}; cannot open ${requestedType}`,
    );
    this.name = "OpenActionRequestConflictError";
  }
}

export class ActionRequestStateError extends Error {
  constructor(
    readonly actionRequestId: string,
    readonly currentStatus: ActionRequestStatus,
    readonly requestedStatus: "resolved" | "cancelled",
  ) {
    super(
      `Cannot mark ActionRequest ${actionRequestId} as ${requestedStatus} from ${currentStatus}`,
    );
    this.name = "ActionRequestStateError";
  }
}

export class InvalidActionRequestResolutionError extends Error {
  constructor(
    readonly actionRequestId: string,
    readonly actionRequestType: ActionRequestType,
  ) {
    super(
      `ActionRequest ${actionRequestId} (${actionRequestType}) has an invalid resolution payload`,
    );
    this.name = "InvalidActionRequestResolutionError";
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

export interface ActionRequestRepository {
  open(input: OpenActionRequestInput): ActionRequest;
  getById(id: string): ActionRequest | null;
  getCurrentOpenForJob(jobId: string): ActionRequest | null;
  resolve(id: string, resolution?: JsonValue | null): ActionRequest;
  cancel(id: string, resolution?: JsonValue | null): ActionRequest;
}
