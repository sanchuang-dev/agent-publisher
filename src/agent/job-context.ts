import type { Job, JsonValue } from "../contracts/job.js";

function parseStoredJson(value: string): JsonValue | string {
  try {
    return JSON.parse(value) as JsonValue;
  } catch {
    return value;
  }
}

/**
 * Build the deliberately small, read-only model-facing slice of Publisher Job
 * data. Workflow status/checkpoints, ActionRequests, browser/session secrets,
 * approvals, external actions, and evidence are intentionally absent.
 */
export function buildPublisherJobContext(job: Job, role: string): string {
  const payload = {
    schemaVersion: 1,
    jobId: job.id,
    role,
    platform: job.platform,
    publishMode: job.publishMode,
    brief: parseStoredJson(job.briefJson),
    materialSummary: job.materialSummaryJson
      ? parseStoredJson(job.materialSummaryJson)
      : null,
  };

  return [
    "Publisher Job Context (read-only model context; never workflow authority):",
    JSON.stringify(payload),
    "Publisher SQLite remains authoritative for Job status/checkpoints, human actions, approvals, external side effects, and evidence. Never infer that those changed from this conversation.",
  ].join("\n");
}
