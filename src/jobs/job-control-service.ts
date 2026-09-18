import type {
  ActionRequest,
  ActionRequestRepository,
  CheckpointData,
  Job,
  JobNotFoundError,
  JobRepository,
  JobStatus,
  JsonValue,
  StepStatus,
} from "../contracts/job.js";

export type WaitingJobStatus = "waiting_for_login" | "waiting_for_approval";

export type RunInTransaction = <T>(work: () => T) => T;

export interface EnterWaitingInput {
  readonly jobId: string;
  readonly status: WaitingJobStatus;
  readonly checkpoint: CheckpointData;
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
  readonly step: EnterWaitingInput["step"];
  readonly action: {
    readonly id: string;
    readonly payload?: JsonValue | null;
  };
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

      const job = this.#jobs.commitCheckpoint(input.jobId, {
        status: currentJob.status,
        checkpoint: input.checkpoint,
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

  #commitHumanPause(
    jobId: string,
    status: JobStatus,
    checkpoint: CheckpointData,
    step: EnterWaitingInput["step"],
    actionInput: EnterWaitingInput["action"],
    actionType: "login_required" | "approval_required" | "clarification_required",
  ): EnterWaitingResult {
    return this.#runInTransaction(() => {
      const job = this.#jobs.commitCheckpoint(jobId, {
        status,
        checkpoint,
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
}
