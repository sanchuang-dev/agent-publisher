import {
  JobNotFoundError,
  type ActionRequest,
  type ActionRequestRepository,
  type ActionRequestType,
  type Job,
  type JobCheckpoint,
  type JobRepository,
  type JobStatus,
} from "../contracts/job.js";

export interface WaitingForActionDecision {
  readonly kind: "waiting_for_action";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint;
  readonly action: ActionRequest;
}

export interface ReadyToContinueDecision {
  readonly kind: "ready_to_continue";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint | null;
  readonly resolvedAction: ActionRequest | null;
}

export interface TerminalDecision {
  readonly kind: "terminal";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint | null;
}

export type ResumeDecision =
  | WaitingForActionDecision
  | ReadyToContinueDecision
  | TerminalDecision;

export class ResumeInvariantError extends Error {
  constructor(readonly jobId: string, message: string) {
    super(`Cannot safely resume job ${jobId}: ${message}`);
    this.name = "ResumeInvariantError";
  }
}

const expectedWaitingActionType: Partial<Record<JobStatus, ActionRequestType>> = {
  waiting_for_login: "login_required",
  waiting_for_approval: "approval_required",
};

function isTerminal(status: JobStatus): boolean {
  return status === "succeeded" || status === "failed";
}

export class ResumeService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;

  constructor(dependencies: {
    readonly jobs: JobRepository;
    readonly actionRequests: ActionRequestRepository;
  }) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
  }

  resume(jobId: string): ResumeDecision {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    const checkpoint = this.#jobs.loadLastCheckpoint(jobId);
    const openAction = this.#actionRequests.getCurrentOpenForJob(jobId);

    if (isTerminal(job.status)) {
      if (openAction) {
        throw new ResumeInvariantError(jobId, "terminal job still has an open ActionRequest");
      }

      return { kind: "terminal", job, checkpoint };
    }

    const expectedActionType = expectedWaitingActionType[job.status];

    if (openAction) {
      if (expectedActionType && openAction.type !== expectedActionType) {
        throw new ResumeInvariantError(
          jobId,
          `${job.status} requires ${expectedActionType}, found ${openAction.type}`,
        );
      }

      if (!expectedActionType && openAction.type !== "clarification_required") {
        throw new ResumeInvariantError(
          jobId,
          `non-waiting status ${job.status} cannot own open ${openAction.type}`,
        );
      }

      if (!checkpoint) {
        throw new ResumeInvariantError(jobId, "open ActionRequest has no committed checkpoint");
      }

      return {
        kind: "waiting_for_action",
        job,
        checkpoint,
        action: openAction,
      };
    }

    if (expectedActionType) {
      if (!checkpoint) {
        throw new ResumeInvariantError(jobId, `${job.status} has no committed checkpoint`);
      }

      const latestAction = this.#actionRequests.getLatestForJob(jobId, expectedActionType);
      if (!latestAction) {
        throw new ResumeInvariantError(
          jobId,
          `${job.status} has no persisted ${expectedActionType} ActionRequest`,
        );
      }

      if (latestAction.status !== "resolved") {
        throw new ResumeInvariantError(
          jobId,
          `${expectedActionType} is ${latestAction.status}, not resolved`,
        );
      }

      return {
        kind: "ready_to_continue",
        job,
        checkpoint,
        resolvedAction: latestAction,
      };
    }

    return {
      kind: "ready_to_continue",
      job,
      checkpoint,
      resolvedAction: null,
    };
  }
}
