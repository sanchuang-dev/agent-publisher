import type {
  ActionRequest,
  ActionRequestRepository,
  CheckpointData,
  Job,
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
  readonly status: Exclude<JobStatus, "waiting_for_login" | "waiting_for_approval" | "succeeded" | "failed">;
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
    return this.#commitHumanPause(
      input.jobId,
      input.status,
      input.checkpoint,
      input.step,
      input.action,
      "clarification_required",
    );
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
