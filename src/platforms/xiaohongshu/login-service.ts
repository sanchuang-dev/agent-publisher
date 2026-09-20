import { createHash, randomUUID } from "node:crypto";

import type { BrowserSession } from "../../browser/provider.js";
import {
  JobNotFoundError,
  type ActionRequest,
  type ActionRequestRepository,
  type Job,
  type JobRepository,
} from "../../contracts/job.js";
import { JobControlService } from "../../jobs/job-control-service.js";
import { ResumeService } from "../../jobs/resume-service.js";
import {
  inspectXiaohongshuPublishEntry,
  openXiaohongshuPublishEntry,
  type XiaohongshuEntryState,
} from "./login-entry.js";

type HumanTakeoverState = Extract<
  XiaohongshuEntryState,
  { readonly kind: "login_required" | "challenge" }
>;

function browserProfileFingerprint(session: BrowserSession): string {
  return createHash("sha256").update(session.profileRef).digest("hex");
}

export type XiaohongshuEnsureLoginResult =
  | {
      readonly kind: "ready";
      readonly job: Job;
      readonly state: Extract<XiaohongshuEntryState, { readonly kind: "authenticated" }>;
    }
  | {
      readonly kind: "human_takeover";
      readonly job: Job;
      readonly state: HumanTakeoverState;
      readonly action: ActionRequest;
    };

export class XiaohongshuLoginFlowInvariantError extends Error {
  readonly code = "LOGIN_REQUIRED" as const;

  constructor(readonly jobId: string, message: string) {
    super(`Cannot continue Xiaohongshu login flow for job ${jobId}: ${message}`);
    this.name = "XiaohongshuLoginFlowInvariantError";
  }
}

export class XiaohongshuUnexpectedEntryStateError extends Error {
  readonly code = "PLATFORM_UI_CHANGED" as const;

  constructor() {
    super("Xiaohongshu publish entry is in an unsupported or unexpected state.");
    this.name = "XiaohongshuUnexpectedEntryStateError";
  }
}

export class XiaohongshuEntryInteractionError extends Error {
  readonly code = "BROWSER_INTERACTION_FAILED" as const;

  constructor(options?: ErrorOptions) {
    super("Could not open or inspect the Xiaohongshu publish entry.", options);
    this.name = "XiaohongshuEntryInteractionError";
  }
}

export class XiaohongshuHumanTakeoverCancelledError extends Error {
  readonly code = "LOGIN_REQUIRED" as const;

  constructor(readonly actionRequestId: string) {
    super("The Xiaohongshu login takeover was cancelled.");
    this.name = "XiaohongshuHumanTakeoverCancelledError";
  }
}

type EntryReader = (
  page: BrowserSession["page"],
) => Promise<XiaohongshuEntryState>;

export interface XiaohongshuLoginServiceDependencies {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly control: JobControlService;
  readonly resume: ResumeService;
  readonly openEntry?: EntryReader;
  readonly inspectEntry?: EntryReader;
  readonly createId?: () => string;
  readonly now?: () => Date;
}

export interface EnsureXiaohongshuLoginInput {
  readonly jobId: string;
  readonly session: BrowserSession;
}

export class XiaohongshuLoginService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #control: JobControlService;
  readonly #resume: ResumeService;
  readonly #openEntry: EntryReader;
  readonly #inspectEntry: EntryReader;
  readonly #createId: () => string;
  readonly #now: () => Date;

  constructor(dependencies: XiaohongshuLoginServiceDependencies) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
    this.#control = dependencies.control;
    this.#resume = dependencies.resume;
    this.#openEntry =
      dependencies.openEntry ??
      ((page) => openXiaohongshuPublishEntry(page));
    this.#inspectEntry =
      dependencies.inspectEntry ??
      ((page) => inspectXiaohongshuPublishEntry(page));
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async ensureLogin(
    input: EnsureXiaohongshuLoginInput,
  ): Promise<XiaohongshuEnsureLoginResult> {
    const job = this.#jobs.getById(input.jobId);
    if (!job) {
      throw new JobNotFoundError(input.jobId);
    }
    if (job.platform !== "xiaohongshu") {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        `platform is ${job.platform}, not xiaohongshu`,
      );
    }

    if (job.status === "waiting_for_login") {
      return await this.#resumeHumanTakeover(input);
    }

    if (job.status !== "preparing_publish") {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        `job is ${job.status}, expected preparing_publish or waiting_for_login`,
      );
    }

    const openAction = this.#actionRequests.getCurrentOpenForJob(input.jobId);
    if (openAction) {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        `browser mutation is blocked while human action ${openAction.type} is open`,
      );
    }

    let state: XiaohongshuEntryState;
    try {
      state = await this.#openEntry(input.session.page);
    } catch (error) {
      this.#recordFailedInspection(input.jobId, "BROWSER_INTERACTION_FAILED");
      throw new XiaohongshuEntryInteractionError({ cause: error });
    }

    if (state.kind === "authenticated") {
      return {
        kind: "ready",
        job: this.#recordAuthenticated(
          input.jobId,
          input.session,
          this.#nextEnsureLoginAttempt(input.jobId),
        ),
        state,
      };
    }

    if (state.kind === "login_required" || state.kind === "challenge") {
      return this.#enterHumanTakeover(input.jobId, input.session, state);
    }

    this.#recordFailedInspection(input.jobId, "PLATFORM_UI_CHANGED");
    throw new XiaohongshuUnexpectedEntryStateError();
  }

  async #resumeHumanTakeover(
    input: EnsureXiaohongshuLoginInput,
  ): Promise<XiaohongshuEnsureLoginResult> {
    const decision = this.#resume.resume(input.jobId);

    if (decision.kind === "action_cancelled") {
      throw new XiaohongshuHumanTakeoverCancelledError(decision.action.id);
    }

    if (
      decision.kind !== "waiting_for_action" &&
      decision.kind !== "ready_to_continue"
    ) {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        `resume decision is ${decision.kind}, not a login continuation`,
      );
    }

    const action =
      decision.kind === "waiting_for_action"
        ? decision.action
        : decision.resolvedAction;

    if (!action || action.type !== "login_required") {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        "durable checkpoint is not bound to login_required",
      );
    }

    const boundProfileFingerprint =
      typeof decision.checkpoint?.checkpoint.browserProfileFingerprint === "string"
        ? decision.checkpoint.checkpoint.browserProfileFingerprint
        : null;
    const currentProfileFingerprint = browserProfileFingerprint(input.session);
    if (
      !boundProfileFingerprint ||
      boundProfileFingerprint !== currentProfileFingerprint
    ) {
      throw new XiaohongshuLoginFlowInvariantError(
        input.jobId,
        "login takeover must resume on the same persistent browser profile",
      );
    }

    let state: XiaohongshuEntryState;
    try {
      // Important: while human control is active this is inspection only.
      // We intentionally do not call goto/click/fill or otherwise mutate the page.
      state = await this.#inspectEntry(input.session.page);
    } catch (error) {
      throw new XiaohongshuEntryInteractionError({ cause: error });
    }

    if (state.kind === "authenticated") {
      return {
        kind: "ready",
        job: this.#completeHumanLogin(
          input.jobId,
          input.session,
          action,
          this.#currentEnsureLoginAttempt(input.jobId),
        ),
        state,
      };
    }

    if (state.kind === "login_required" || state.kind === "challenge") {
      if (action.status !== "open") {
        throw new XiaohongshuLoginFlowInvariantError(
          input.jobId,
          "login action is already resolved but the browser is not authenticated",
        );
      }

      return {
        kind: "human_takeover",
        job: decision.job,
        state,
        action,
      };
    }

    throw new XiaohongshuUnexpectedEntryStateError();
  }

  #enterHumanTakeover(
    jobId: string,
    session: BrowserSession,
    state: HumanTakeoverState,
  ): XiaohongshuEnsureLoginResult {
    const attempt = this.#nextEnsureLoginAttempt(jobId);
    const now = this.#now().toISOString();
    const result = this.#control.enterWaiting({
      jobId,
      status: "waiting_for_login",
      checkpoint: {
        platform: "xiaohongshu",
        phase: "ensure_login",
        entryState: state.kind,
        browserProfileFingerprint: browserProfileFingerprint(session),
      },
      step: {
        id: this.#createId(),
        stepKey: "ensure_login",
        status: "running",
        attempt,
        startedAt: now,
      },
      action: {
        id: this.#createId(),
        payload: {
          platform: "xiaohongshu",
          reason: state.kind,
          humanControl: "live_browser",
          instruction: "Complete login or verification in the live browser.",
        },
      },
    });

    return {
      kind: "human_takeover",
      job: result.job,
      state,
      action: result.action,
    };
  }

  #recordAuthenticated(
    jobId: string,
    session: BrowserSession,
    attempt: number,
  ): Job {
    const now = this.#now().toISOString();
    return this.#jobs.commitCheckpoint(jobId, {
      status: "preparing_publish",
      checkpoint: {
        platform: "xiaohongshu",
        phase: "ensure_login",
        entryState: "authenticated",
        browserProfileFingerprint: browserProfileFingerprint(session),
      },
      step: {
        id: this.#createId(),
        stepKey: "ensure_login",
        status: "succeeded",
        attempt,
        outputJson: JSON.stringify({ entryState: "authenticated" }),
        finishedAt: now,
      },
    });
  }

  #completeHumanLogin(
    jobId: string,
    session: BrowserSession,
    action: ActionRequest,
    attempt: number,
  ): Job {
    const now = this.#now().toISOString();
    return this.#control.completeLogin({
      jobId,
      actionRequestId: action.id,
      resolution: {
        loginDetected: true,
        platform: "xiaohongshu",
      },
      checkpoint: {
        platform: "xiaohongshu",
        phase: "ensure_login",
        entryState: "authenticated",
        browserProfileFingerprint: browserProfileFingerprint(session),
      },
      step: {
        id: this.#createId(),
        stepKey: "ensure_login",
        status: "succeeded",
        attempt,
        outputJson: JSON.stringify({ entryState: "authenticated" }),
        finishedAt: now,
      },
    });
  }

  #recordFailedInspection(
    jobId: string,
    errorCode: "BROWSER_INTERACTION_FAILED" | "PLATFORM_UI_CHANGED",
  ): void {
    const attempt = this.#nextEnsureLoginAttempt(jobId);
    const now = this.#now().toISOString();
    this.#jobs.commitCheckpoint(jobId, {
      status: "preparing_publish",
      checkpoint: {
        platform: "xiaohongshu",
        phase: "ensure_login",
        entryState: "unexpected",
      },
      step: {
        id: this.#createId(),
        stepKey: "ensure_login",
        status: "failed",
        attempt,
        errorCode,
        errorMessage:
          errorCode === "PLATFORM_UI_CHANGED"
            ? "Xiaohongshu publish entry is in an unsupported state."
            : "Xiaohongshu publish entry could not be inspected.",
        finishedAt: now,
      },
    });
  }

  #nextEnsureLoginAttempt(jobId: string): number {
    return this.#latestEnsureLoginAttempt(jobId) + 1;
  }

  #currentEnsureLoginAttempt(jobId: string): number {
    const latest = this.#latestEnsureLoginAttempt(jobId);
    return latest > 0 ? latest : 1;
  }

  #latestEnsureLoginAttempt(jobId: string): number {
    return this.#jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "ensure_login")
      .reduce((maximum, step) => Math.max(maximum, step.attempt), 0);
  }
}
