import type {
  ActionRequest,
  ActionRequestRepository,
  CheckpointData,
  Job,
  JobRepository,
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
    return this.#runInTransaction(() => {
      const job = this.#jobs.commitCheckpoint(input.jobId, {
        status: input.status,
        checkpoint: input.checkpoint,
        step: input.step,
      });

      const action = this.#actionRequests.open({
        id: input.action.id,
        jobId: input.jobId,
        type: actionTypeByWaitingStatus[input.status],
        payload: input.action.payload ?? null,
      });

      return { job, action };
    });
  }
}
