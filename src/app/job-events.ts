import type { JobProjection } from "./job-projection.js";

export type JobProjectionListener = (projection: JobProjection) => void;

export class JobProjectionEventBus {
  readonly #listeners = new Map<string, Set<JobProjectionListener>>();

  subscribe(jobId: string, listener: JobProjectionListener): () => void {
    let listeners = this.#listeners.get(jobId);
    if (!listeners) {
      listeners = new Set();
      this.#listeners.set(jobId, listeners);
    }

    listeners.add(listener);

    return () => {
      const current = this.#listeners.get(jobId);
      if (!current) return;

      current.delete(listener);
      if (current.size === 0) {
        this.#listeners.delete(jobId);
      }
    };
  }

  publish(projection: JobProjection): void {
    const listeners = this.#listeners.get(projection.id);
    if (!listeners) return;

    for (const listener of [...listeners]) {
      try {
        listener(projection);
      } catch {
        // Projection delivery is observational. A broken/disconnected observer
        // must never roll back or misreport already-committed Publisher truth.
        process.emitWarning(
          "Job projection observer failed after durable state was committed.",
          { code: "APP_JOB_EVENT_DELIVERY_FAILED" },
        );
      }
    }
  }
}
