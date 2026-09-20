import {
  getCheckpointActionRequestId,
  humanActionCheckpointKey,
  isApprovalResolution,
  JobNotFoundError,
  OpenActionRequestConflictError,
  type ActionRequest,
  type ActionRequestRepository,
  type ActionRequestType,
  type CheckpointData,
  type Job,
  type JobRepository,
  type JobStatus,
  type JsonValue,
  type StepStatus,
} from "../contracts/job.js";

export type WaitingJobStatus = "waiting_for_login" | "waiting_for_approval";

export type RunInTransaction = <T>(work: () => T) => T;

type CheckpointStep = {
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

export interface EnterWaitingInput {
  readonly jobId: string;
  readonly status: WaitingJobStatus;
  readonly checkpoint: CheckpointData;
  readonly step: CheckpointStep;
  readonly action: {
    readonly id: string;
    readonly payload?: JsonValue | null;
  };
}

export interface EnterWaitingResult {
  readonly job: Job;
  readonly action: ActionRequest;
}

export interface RequestClarificationInput {
  readonly jobId: string;
  readonly checkpoint: CheckpointData;
  readonly step: CheckpointStep;
  readonly action: {
    readonly id: string;
    readonly payload?: JsonValue | null;
  };
}

export interface BeginPublishingInput {
  readonly jobId: string;
  readonly checkpoint: CheckpointData;
  readonly step: CheckpointStep;
}

export interface CompleteLoginInput {
  readonly jobId: string;
  readonly actionRequestId: string;
  readonly resolution?: JsonValue | null;
  readonly checkpoint: CheckpointData;
  readonly step: CheckpointStep;
}

export interface InvalidateApprovalForClarificationInput {
  readonly jobId: string;
  readonly approvalRequestId: string;
  readonly cancellationResolution?: JsonValue | null;
  readonly checkpoint: CheckpointData;
  readonly step: CheckpointStep;
  readonly action: {
    readonly id: string;
    readonly payload?: JsonValue | null;
  };
}

export class ApprovalNotGrantedError extends Error {
  constructor(readonly jobId: string, reason: string) {
    super(`Cannot enter publishing for job ${jobId}: ${reason}`);
    this.name = "ApprovalNotGrantedError";
  }
}

export class LoginContinuationNotAllowedError extends Error {
  constructor(readonly jobId: string, reason: string) {
    super(`Cannot complete login for job ${jobId}: ${reason}`);
    this.name = "LoginContinuationNotAllowedError";
  }
}

const actionTypeByWaitingStatus = {
  waiting_for_login: "login_required",
  waiting_for_approval: "approval_required",
} as const;

export class JobControlService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #runInTransaction: RunInTransaction;

  constructor(dependencies: {
    readonly jobs: JobRepository;
    readonly actionRequests: ActionRequestRepository;
    readonly runInTransaction: RunInTransaction;
  }) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
    this.#runInTransaction = dependencies.runInTransaction;
  }

  enterWaiting(input: EnterWaitingInput): EnterWaitingResult {
    return this.#commitHumanPause(
      input.jobId,
      input.status,
      input.checkpoint,
      input.step,
      input.action,
      actionTypeByWaitingStatus[input.status],
    );
  }

  requestClarification(input: RequestClarificationInput): EnterWaitingResult {
    return this.#runInTransaction(() => {
      const currentJob = this.#jobs.getById(input.jobId);
      if (!currentJob) {
        throw new JobNotFoundError(input.jobId);
      }

      if (
        currentJob.status !== "created" &&
        currentJob.status !== "preparing_materials" &&
        currentJob.status !== "preparing_publish"
      ) {
        throw new Error(
          `clarification_required is not allowed while job ${input.jobId} is ${currentJob.status}`,
        );
      }

      return this.#commitHumanPause(
        input.jobId,
        currentJob.status,
        input.checkpoint,
        input.step,
        input.action,
        "clarification_required",
      );
    });
  }

  completeLogin(input: CompleteLoginInput): Job {
    return this.#runInTransaction(() => {
      const currentJob = this.#jobs.getById(input.jobId);
      if (!currentJob) {
        throw new JobNotFoundError(input.jobId);
      }
      if (currentJob.status !== "waiting_for_login") {
        throw new LoginContinuationNotAllowedError(
          input.jobId,
          `job is ${currentJob.status}, not waiting_for_login`,
        );
      }

      const checkpoint = this.#jobs.loadLastCheckpoint(input.jobId);
      const boundActionId = checkpoint
        ? getCheckpointActionRequestId(checkpoint.checkpoint)
        : null;
      if (!checkpoint || boundActionId !== input.actionRequestId) {
        throw new LoginContinuationNotAllowedError(
          input.jobId,
          "durable checkpoint is not bound to the requested login action",
        );
      }

      const action = this.#actionRequests.getById(input.actionRequestId);
      if (
        !action ||
        action.jobId !== input.jobId ||
        action.type !== "login_required"
      ) {
        throw new LoginContinuationNotAllowedError(
          input.jobId,
          "checkpoint action is not a login_required action for this job",
        );
      }
      if (action.status === "cancelled") {
        throw new LoginContinuationNotAllowedError(
          input.jobId,
          "login action was cancelled",
        );
      }

      if (action.status === "open") {
        this.#actionRequests.resolve(
          action.id,
          input.resolution ?? { loginDetected: true },
        );
      }

      const openAction = this.#actionRequests.getCurrentOpenForJob(input.jobId);
      if (openAction) {
        throw new LoginContinuationNotAllowedError(
          input.jobId,
          `human action remains open: ${openAction.type}`,
        );
      }

      return this.#jobs.commitCheckpoint(input.jobId, {
        status: "preparing_publish",
        checkpoint: input.checkpoint,
        step: input.step,
      });
    });
  }

  invalidateApprovalForClarification(
    input: InvalidateApprovalForClarificationInput,
  ): EnterWaitingResult {
    return this.#runInTransaction(() => {
      const currentJob = this.#jobs.getById(input.jobId);
      if (!currentJob) {
        throw new JobNotFoundError(input.jobId);
      }
      if (currentJob.status !== "waiting_for_approval") {
        throw new ApprovalNotGrantedError(
          input.jobId,
          `job is ${currentJob.status}, not waiting_for_approval`,
        );
      }

      const checkpoint = this.#jobs.loadLastCheckpoint(input.jobId);
      const boundActionId = checkpoint
        ? getCheckpointActionRequestId(checkpoint.checkpoint)
        : null;
      if (!checkpoint || boundActionId !== input.approvalRequestId) {
        throw new ApprovalNotGrantedError(
          input.jobId,
          "durable checkpoint is not bound to the requested approval action",
        );
      }

      const approval = this.#actionRequests.getById(input.approvalRequestId);
      if (
        !approval ||
        approval.jobId !== input.jobId ||
        approval.type !== "approval_required" ||
        approval.status !== "open"
      ) {
        throw new ApprovalNotGrantedError(
          input.jobId,
          "checkpoint action is not an open approval_required action for this job",
        );
      }

      this.#actionRequests.cancel(
        approval.id,
        input.cancellationResolution ?? { reason: "prepared_state_changed" },
      );

      const job = this.#jobs.commitCheckpoint(input.jobId, {
        status: "preparing_publish",
        checkpoint: this.#bindAction(input.checkpoint, input.action.id),
        step: input.step,
      });

      const action = this.#actionRequests.open({
        id: input.action.id,
        jobId: input.jobId,
        type: "clarification_required",
        payload: input.action.payload ?? null,
      });

      return { job, action };
    });
  }

  beginPublishingAfterApproval(input: BeginPublishingInput): Job {
    return this.#runInTransaction(() => {
      const currentJob = this.#jobs.getById(input.jobId);
      if (!currentJob) {
        throw new JobNotFoundError(input.jobId);
      }

      if (currentJob.status !== "waiting_for_approval") {
        throw new ApprovalNotGrantedError(
          input.jobId,
          `job is ${currentJob.status}, not waiting_for_approval`,
        );
      }

      const checkpoint = this.#jobs.loadLastCheckpoint(input.jobId);
      if (!checkpoint) {
        throw new ApprovalNotGrantedError(input.jobId, "approval checkpoint is missing");
      }

      const actionId = getCheckpointActionRequestId(checkpoint.checkpoint);
      if (!actionId) {
        throw new ApprovalNotGrantedError(
          input.jobId,
          "approval checkpoint is not bound to an ActionRequest",
        );
      }

      const approval = this.#actionRequests.getById(actionId);
      if (
        !approval ||
        approval.jobId !== input.jobId ||
        approval.type !== "approval_required" ||
        approval.status !== "resolved" ||
        !isApprovalResolution(approval.resolution) ||
        !approval.resolution.approved
      ) {
        throw new ApprovalNotGrantedError(input.jobId, "affirmative approval is not persisted");
      }

      const openAction = this.#actionRequests.getCurrentOpenForJob(input.jobId);
      if (openAction) {
        throw new ApprovalNotGrantedError(
          input.jobId,
          `another human action remains open: ${openAction.type}`,
        );
      }

      return this.#jobs.commitCheckpoint(input.jobId, {
        status: "publishing",
        checkpoint: input.checkpoint,
        step: input.step,
      });
    });
  }

  #commitHumanPause(
    jobId: string,
    status: JobStatus,
    checkpoint: CheckpointData,
    step: CheckpointStep,
    actionInput: EnterWaitingInput["action"],
    actionType: ActionRequestType,
  ): EnterWaitingResult {
    return this.#runInTransaction(() => {
      const existing = this.#actionRequests.getCurrentOpenForJob(jobId);
      if (existing) {
        if (existing.type !== actionType) {
          throw new OpenActionRequestConflictError(jobId, existing.type, actionType);
        }

        const currentJob = this.#jobs.getById(jobId);
        if (!currentJob) {
          throw new JobNotFoundError(jobId);
        }
        if (currentJob.status !== status) {
          throw new Error(
            `Cannot replay ${actionType} for job ${jobId}: durable status is ${currentJob.status}, expected ${status}`,
          );
        }
        if (
          !currentJob.checkpoint ||
          getCheckpointActionRequestId(currentJob.checkpoint) !== existing.id
        ) {
          throw new Error(
            `Cannot replay ${actionType} for job ${jobId}: open action is not bound to the durable checkpoint`,
          );
        }

        // An open human action freezes the exact checkpoint/payload the human
        // is reviewing. Crash/retry reuses that durable pause instead of
        // silently moving the approval/login/clarification target underneath it.
        return { job: currentJob, action: existing };
      }

      const job = this.#jobs.commitCheckpoint(jobId, {
        status,
        checkpoint: this.#bindAction(checkpoint, actionInput.id),
        step,
      });

      const action = this.#actionRequests.open({
        id: actionInput.id,
        jobId,
        type: actionType,
        payload: actionInput.payload ?? null,
      });

      return { job, action };
    });
  }

  #bindAction(checkpoint: CheckpointData, actionRequestId: string): CheckpointData {
    return {
      ...checkpoint,
      [humanActionCheckpointKey]: actionRequestId,
    };
  }
}
