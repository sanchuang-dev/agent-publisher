import type { JobStatus } from "../contracts/job.js";

export const allowedJobStatusTransitions = {
  created: ["created", "preparing_materials", "failed"],
  preparing_materials: ["preparing_materials", "preparing_publish", "failed"],
  preparing_publish: [
    "preparing_publish",
    "waiting_for_login",
    "waiting_for_approval",
    "failed",
  ],
  waiting_for_login: ["waiting_for_login", "preparing_publish", "failed"],
  waiting_for_approval: ["waiting_for_approval", "preparing_publish", "publishing", "failed"],
  publishing: ["publishing", "succeeded", "failed"],
  succeeded: ["succeeded"],
  failed: ["failed"],
} as const satisfies Readonly<Record<JobStatus, readonly JobStatus[]>>;

export class IllegalJobStatusTransitionError extends Error {
  constructor(
    readonly fromStatus: JobStatus,
    readonly toStatus: JobStatus,
  ) {
    super(`Illegal job status transition: ${fromStatus} -> ${toStatus}`);
    this.name = "IllegalJobStatusTransitionError";
  }
}

export function canTransitionJobStatus(fromStatus: JobStatus, toStatus: JobStatus): boolean {
  return (allowedJobStatusTransitions[fromStatus] as readonly JobStatus[]).includes(toStatus);
}

export function assertJobStatusTransitionAllowed(
  fromStatus: JobStatus,
  toStatus: JobStatus,
): void {
  if (!canTransitionJobStatus(fromStatus, toStatus)) {
    throw new IllegalJobStatusTransitionError(fromStatus, toStatus);
  }
}
