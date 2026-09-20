export const externalActionStatuses = [
  "prepared",
  "started",
  "succeeded",
  "unknown",
  "failed",
] as const;

export type ExternalActionStatus = (typeof externalActionStatuses)[number];

export interface ExternalAction {
  readonly id: string;
  readonly jobId: string;
  readonly actionType: string;
  readonly actionKey: string;
  readonly status: ExternalActionStatus;
  readonly externalRef: string | null;
  readonly startedAt: string | null;
  readonly finishedAt: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface PrepareExternalActionInput {
  readonly id: string;
  readonly jobId: string;
  readonly actionType: string;
  readonly actionKey: string;
}

export interface CompleteExternalActionInput {
  readonly externalRef?: string | null;
  readonly errorCode?: string | null;
  readonly errorMessage?: string | null;
}

export type ExternalActionTerminalStatus = "succeeded" | "unknown" | "failed";
export type VerifiedExternalActionStatus = "succeeded" | "failed";

export interface ResolveExternalActionAfterVerificationInput
  extends CompleteExternalActionInput {
  readonly status: VerifiedExternalActionStatus;
}

export function requiresVerifyFirst(
  action: Pick<ExternalAction, "status">,
): boolean {
  return action.status === "started" || action.status === "unknown";
}

export class ExternalActionNotFoundError extends Error {
  constructor(readonly externalActionId: string) {
    super(`ExternalAction not found: ${externalActionId}`);
    this.name = "ExternalActionNotFoundError";
  }
}

export class ExternalActionIdentityConflictError extends Error {
  constructor(
    readonly jobId: string,
    readonly actionKey: string,
    readonly existingActionType: string,
    readonly requestedActionType: string,
  ) {
    super(
      `ExternalAction ${jobId}/${actionKey} already exists as ${existingActionType}; cannot prepare it as ${requestedActionType}`,
    );
    this.name = "ExternalActionIdentityConflictError";
  }
}

export class ExternalActionStateError extends Error {
  constructor(
    readonly externalActionId: string,
    readonly currentStatus: ExternalActionStatus,
    readonly requestedStatus: Exclude<ExternalActionStatus, "prepared">,
  ) {
    super(
      `Cannot mark ExternalAction ${externalActionId} as ${requestedStatus} from ${currentStatus}`,
    );
    this.name = "ExternalActionStateError";
  }
}

/**
 * Driver-agnostic persistence boundary for irreversible external side effects.
 *
 * prepare() is idempotent by jobId + actionKey and never resets a durable
 * action that has already advanced. Execution may start only from prepared.
 * Recovery from started/unknown must verify the external post-condition first,
 * then settle the existing durable identity through resolveAfterVerification.
 * That recovery API never re-enters execution and does not authorize retries.
 */
export interface ExternalActionRepository {
  prepare(input: PrepareExternalActionInput): ExternalAction;
  getById(id: string): ExternalAction | null;
  getByKey(jobId: string, actionKey: string): ExternalAction | null;
  start(id: string): ExternalAction;
  markSucceeded(id: string, input?: CompleteExternalActionInput): ExternalAction;
  markUnknown(id: string, input?: CompleteExternalActionInput): ExternalAction;
  markFailed(id: string, input?: CompleteExternalActionInput): ExternalAction;
  resolveAfterVerification(
    id: string,
    input: ResolveExternalActionAfterVerificationInput,
  ): ExternalAction;
}
