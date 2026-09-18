import { describe, expect, test } from "vitest";

import { jobStatuses, type JobStatus } from "../src/contracts/job.js";
import {
  IllegalJobStatusTransitionError,
  allowedJobStatusTransitions,
  assertJobStatusTransitionAllowed,
  canTransitionJobStatus,
} from "../src/jobs/state-machine.js";

describe("job state machine", () => {
  const expected: Readonly<Record<JobStatus, readonly JobStatus[]>> = {
    created: ["created", "preparing_materials", "failed"],
    preparing_materials: ["preparing_materials", "preparing_publish", "failed"],
    preparing_publish: [
      "preparing_publish",
      "waiting_for_login",
      "waiting_for_approval",
      "failed",
    ],
    waiting_for_login: ["waiting_for_login", "preparing_publish", "failed"],
    waiting_for_approval: ["waiting_for_approval", "publishing", "failed"],
    publishing: ["publishing", "succeeded", "failed"],
    succeeded: ["succeeded"],
    failed: ["failed"],
  };

  test("the exported matrix matches the Phase 2 lifecycle contract", () => {
    expect(allowedJobStatusTransitions).toEqual(expected);
  });

  for (const fromStatus of jobStatuses) {
    for (const toStatus of jobStatuses) {
      const isAllowed = expected[fromStatus].includes(toStatus);

      test(`${fromStatus} -> ${toStatus} is ${isAllowed ? "allowed" : "rejected"}`, () => {
        expect(canTransitionJobStatus(fromStatus, toStatus)).toBe(isAllowed);

        if (isAllowed) {
          expect(() => assertJobStatusTransitionAllowed(fromStatus, toStatus)).not.toThrow();
        } else {
          expect(() => assertJobStatusTransitionAllowed(fromStatus, toStatus)).toThrow(
            IllegalJobStatusTransitionError,
          );
        }
      });
    }
  }

  test("explicit safety boundaries reject cross-level and terminal reactivation", () => {
    expect(canTransitionJobStatus("created", "publishing")).toBe(false);
    expect(canTransitionJobStatus("waiting_for_approval", "succeeded")).toBe(false);
    expect(canTransitionJobStatus("succeeded", "publishing")).toBe(false);
    expect(canTransitionJobStatus("failed", "preparing_materials")).toBe(false);
  });
});
