import {
  getCheckpointActionRequestId,
  isApprovalResolution,
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

export interface ApprovalRejectedDecision {
  readonly kind: "approval_rejected";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint;
  readonly action: ActionRequest;
  readonly nextStatus: "preparing_publish";
}

export interface ActionCancelledDecision {
  readonly kind: "action_cancelled";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint;
  readonly action: ActionRequest;
}

export interface TerminalDecision {
  readonly kind: "terminal";
  readonly job: Job;
  readonly checkpoint: JobCheckpoint | null;
}

export type ResumeDecision =
  | WaitingForActionDecision
  | ReadyToContinueDecision
  | ApprovalRejectedDecision
  | ActionCancelledDecision
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

    if (!checkpoint) {
      if (openAction) {
        throw new ResumeInvariantError(jobId, "open ActionRequest has no committed checkpoint");
      }
      if (expectedActionType) {
        throw new ResumeInvariantError(jobId, `${job.status} has no committed checkpoint`);
      }

      return {
        kind: "ready_to_continue",
        job,
        checkpoint: null,
        resolvedAction: null,
      };
    }

    const boundActionId = getCheckpointActionRequestId(checkpoint.checkpoint);
    if (!boundActionId) {
      if (openAction) {
        throw new ResumeInvariantError(
          jobId,
          `open ${openAction.type} is not bound to the committed checkpoint`,
        );
      }
      if (expectedActionType) {
        throw new ResumeInvariantError(
          jobId,
          `${job.status} checkpoint is not bound to ${expectedActionType}`,
        );
      }

      return {
        kind: "ready_to_continue",
        job,
        checkpoint,
        resolvedAction: null,
      };
    }

    const action = this.#actionRequests.getById(boundActionId);
    if (!action) {
      throw new ResumeInvariantError(
        jobId,
        `checkpoint references missing ActionRequest ${boundActionId}`,
      );
    }
    if (action.jobId !== jobId) {
      throw new ResumeInvariantError(
        jobId,
        `checkpoint ActionRequest ${boundActionId} belongs to another job`,
      );
    }

    if (expectedActionType) {
      if (action.type !== expectedActionType) {
        throw new ResumeInvariantError(
          jobId,
          `${job.status} requires ${expectedActionType}, found ${action.type}`,
        );
      }
    } else if (action.type !== "clarification_required") {
      throw new ResumeInvariantError(
        jobId,
        `non-waiting status ${job.status} cannot be bound to ${action.type}`,
      );
    }

    if (action.status === "open") {
      if (!openAction || openAction.id !== action.id) {
        throw new ResumeInvariantError(
          jobId,
          `checkpoint-bound ActionRequest ${action.id} is open but is not the current open action`,
        );
      }

      return {
        kind: "waiting_for_action",
        job,
        checkpoint,
        action,
      };
    }

    if (openAction) {
      throw new ResumeInvariantError(
        jobId,
        `checkpoint is bound to ${action.id}, but current open action is ${openAction.id}`,
      );
    }

    if (action.status === "cancelled") {
      return {
        kind: "action_cancelled",
        job,
        checkpoint,
        action,
      };
    }

    if (action.type === "approval_required") {
      if (!isApprovalResolution(action.resolution)) {
        throw new ResumeInvariantError(
          jobId,
          `approval ActionRequest ${action.id} has no valid approval decision`,
        );
      }

      if (!action.resolution.approved) {
        return {
          kind: "approval_rejected",
          job,
          checkpoint,
          action,
          nextStatus: "preparing_publish",
        };
      }
    }

    return {
      kind: "ready_to_continue",
      job,
      checkpoint,
      resolvedAction: action,
    };
  }
}
