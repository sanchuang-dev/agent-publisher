import { randomUUID } from "node:crypto";

import type {
  BrowserAutomationAttachmentProvider,
  BrowserProvider,
  BrowserSession,
} from "../browser/provider.js";
import type {
  PublishingSecretaryExecutionResult,
  PublishingSecretaryPort,
} from "../agent/publishing-secretary-contract.js";
import {
  JobNotFoundError,
  type ActionRequestRepository,
  type Job,
  type JobRepository,
} from "../contracts/job.js";
import type {
  XiaohongshuEnsureLoginResult,
  XiaohongshuLoginService,
} from "../platforms/xiaohongshu/login-service.js";
import { XiaohongshuPrepareInteractionError } from "../platforms/xiaohongshu/image-text-prepare.js";
import type {
  XiaohongshuPrepareForApprovalResult,
  XiaohongshuPrepareService,
} from "../platforms/xiaohongshu/prepare-service.js";
import { JobProjectionEventBus } from "./job-events.js";
import {
  JobProjectionService,
  type JobProjection,
} from "./job-projection.js";
import {
  PREPUBLISH_MATERIAL_STEP_KEY,
  PrepublishMaterialResolutionError,
  findPersistedPrepublishMaterial,
  parsePrepublishMaterial,
  serializePrepublishMaterial,
  type PersistedPrepublishMaterial,
  type PrepublishMaterialSource,
} from "./prepublish-material-source.js";

type LoginServicePort = Pick<
  XiaohongshuLoginService,
  "ensureLogin" | "enterPreparedHumanTakeover"
>;
type PrepareServicePort = Pick<XiaohongshuPrepareService, "prepareForApproval">;

const BROWSER_ACQUIRE_STEP_KEY = "acquire_browser";

const boundedMaterialFailureStages = [
  "material_plan",
  "material_preparation",
  "material_source",
] as const;

type BoundedMaterialFailureStage =
  (typeof boundedMaterialFailureStages)[number];

interface BoundedMaterialFailureDiagnostic {
  readonly stage: BoundedMaterialFailureStage;
  readonly code: string;
}

function boundedMaterialFailureDiagnostic(
  error: unknown,
): BoundedMaterialFailureDiagnostic {
  if (error instanceof PrepublishMaterialResolutionError) {
    const candidateStage = (error as { readonly stage?: unknown }).stage;
    const stage: BoundedMaterialFailureStage =
      candidateStage === "material_plan" ||
      candidateStage === "material_preparation"
        ? candidateStage
        : "material_source";
    const code = /^[A-Z0-9_]{1,64}$/.test(error.code)
      ? error.code
      : "MATERIAL_SOURCE_UNAVAILABLE";

    return { stage, code };
  }

  return {
    stage: "material_source",
    code: "MATERIAL_SOURCE_UNAVAILABLE",
  };
}

export interface CreatePrepublishJobInput {
  readonly brief: string;
}

export interface ContinuePrepublishResult {
  readonly projection: JobProjection;
  readonly blocked: boolean;
  readonly error:
    | {
        readonly code: string;
        readonly message: string;
      }
    | null;
}

export interface XiaohongshuPrepublishOrchestratorDependencies {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly browserProvider: BrowserProvider;
  readonly publishingSecretary?: PublishingSecretaryPort;
  readonly login: LoginServicePort;
  readonly prepare: PrepareServicePort;
  readonly materialSource: PrepublishMaterialSource;
  readonly projections: JobProjectionService;
  readonly events: JobProjectionEventBus;
  readonly createId?: () => string;
  readonly now?: () => Date;
}

export class PrepublishMaterialSourceError extends Error {
  readonly code = "MATERIAL_SOURCE_UNAVAILABLE" as const;

  constructor(options?: ErrorOptions) {
    super(
      "The configured pre-publish material source could not prepare valid material.",
      options,
    );
    this.name = "PrepublishMaterialSourceError";
  }
}

export class PrepublishBrowserUnavailableError extends Error {
  readonly code = "BROWSER_UNAVAILABLE" as const;

  constructor(options?: ErrorOptions) {
    super("The controlled browser runtime is currently unavailable.", options);
    this.name = "PrepublishBrowserUnavailableError";
  }
}

export class PrepublishJobBusyError extends Error {
  readonly code = "JOB_ALREADY_RUNNING" as const;

  constructor(readonly jobId: string) {
    super(`A pre-publish run is already active for job ${jobId}.`);
    this.name = "PrepublishJobBusyError";
  }
}

export class UnsupportedPrepublishStateError extends Error {
  readonly code = "PREPUBLISH_STATE_UNSUPPORTED" as const;

  constructor(readonly jobId: string, readonly status: Job["status"]) {
    super(
      `APP-02 cannot continue job ${jobId} from status ${status}; final publication is outside this slice.`,
    );
    this.name = "UnsupportedPrepublishStateError";
  }
}

function errorCode(error: unknown): string {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }

  return "PREPUBLISH_BLOCKED";
}

function safeErrorMessage(error: unknown): string {
  if (error instanceof XiaohongshuPrepareInteractionError) {
    return "The Xiaohongshu prepare interaction stopped safely at " + error.stage + ".";
  }

  const code = errorCode(error);

  const messages: Readonly<Record<string, string>> = {
    MATERIAL_SOURCE_UNAVAILABLE:
      "The configured pre-publish material source could not prepare valid material.",
    BROWSER_UNAVAILABLE:
      "The controlled browser runtime is currently unavailable.",
    LOGIN_REQUIRED:
      "The Xiaohongshu login or verification boundary still requires human attention.",
    PLATFORM_UI_CHANGED:
      "The Xiaohongshu page no longer matches the supported deterministic flow.",
    BROWSER_INTERACTION_FAILED:
      "The Xiaohongshu browser interaction stopped safely.",
    PREPARE_RECOVERY_REQUIRED:
      "The prepared Xiaohongshu composer requires human inspection before continuing.",
    PREPARED_VALIDATION_FAILED:
      "The prepared Xiaohongshu form did not match the intended material.",
    COMPOSER_NOT_FRESH:
      "The Xiaohongshu composer already contains content and was not overwritten.",
    PLATFORM_UPLOAD_FAILED:
      "Xiaohongshu reported an upload or processing failure.",
    PLATFORM_UPLOAD_TIMEOUT:
      "The Xiaohongshu upload did not reach a verified ready state in time.",
    ASSET_RESOLUTION_FAILED:
      "One or more controlled material assets could not be resolved.",
    JOB_ALREADY_RUNNING:
      "This job is already being continued by another request.",
  };

  return (
    messages[code] ??
    "The pre-publish flow stopped safely. Inspect the current task state before retrying."
  );
}

function hasAuthenticatedOrPrepareCheckpoint(job: Job): boolean {
  const phase = job.checkpoint?.phase;

  if (
    phase === "ensure_login" &&
    job.checkpoint?.entryState === "authenticated"
  ) {
    return true;
  }

  return (
    typeof phase === "string" &&
    (phase.startsWith("xhs_prepare_") || phase === "prepared_for_approval")
  );
}

function briefFromJob(job: Job): string {
  try {
    const parsed = JSON.parse(job.briefJson) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      !Array.isArray(parsed) &&
      "brief" in parsed &&
      typeof (parsed as { readonly brief?: unknown }).brief === "string"
    ) {
      const brief = (parsed as { readonly brief: string }).brief.trim();
      if (brief) {
        return brief;
      }
    }
  } catch {
    // Fall through to the invariant error below.
  }

  throw new Error(`Job ${job.id} has an invalid APP-02 brief payload.`);
}

function asAutomationProvider(
  provider: BrowserProvider,
): BrowserAutomationAttachmentProvider | null {
  const candidate = provider as Partial<BrowserAutomationAttachmentProvider>;
  return typeof candidate.resolveAutomationAttachment === "function"
    ? (provider as BrowserAutomationAttachmentProvider)
    : null;
}

function publishingSecretaryRunError(
  result: PublishingSecretaryExecutionResult,
): ContinuePrepublishResult["error"] {
  if (result.kind === "needs_identity") {
    return {
      code: "LOGIN_REQUIRED",
      message:
        "The Publishing Secretary reached an identity boundary that requires the dedicated human handoff flow.",
    };
  }
  if (result.kind === "needs_clarification") {
    return {
      code: "CLARIFICATION_REQUIRED",
      message:
        "The Publishing Secretary stopped because the current page needs human clarification.",
    };
  }
  if (result.kind === "failed") {
    return {
      code: "PUBLISHING_SECRETARY_FAILED",
      message:
        "The Publishing Secretary exhausted bounded safe browser exploration without reaching a prepared candidate.",
    };
  }
  return null;
}

export class XiaohongshuPrepublishOrchestrator {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #browserProvider: BrowserProvider;
  readonly #publishingSecretary: PublishingSecretaryPort | undefined;
  readonly #login: LoginServicePort;
  readonly #prepare: PrepareServicePort;
  readonly #materialSource: PrepublishMaterialSource;
  readonly #projections: JobProjectionService;
  readonly #events: JobProjectionEventBus;
  readonly #createId: () => string;
  readonly #now: () => Date;
  readonly #activeJobs = new Set<string>();

  constructor(dependencies: XiaohongshuPrepublishOrchestratorDependencies) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
    this.#browserProvider = dependencies.browserProvider;
    this.#publishingSecretary = dependencies.publishingSecretary;
    this.#login = dependencies.login;
    this.#prepare = dependencies.prepare;
    this.#materialSource = dependencies.materialSource;
    this.#projections = dependencies.projections;
    this.#events = dependencies.events;
    this.#createId = dependencies.createId ?? randomUUID;
    this.#now = dependencies.now ?? (() => new Date());
  }

  async createJob(input: CreatePrepublishJobInput): Promise<JobProjection> {
    const brief = input.brief.trim();
    if (!brief) {
      throw new Error("A non-empty publishing brief is required.");
    }

    const jobId = this.#createId();
    this.#jobs.create({
      id: jobId,
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief }),
      // Material execution data is persisted in JobStep.outputJson, not in the
      // model-facing material_summary_json field.
      materialSummaryJson: null,
    });

    return this.#publish(jobId);
  }

  getJob(jobId: string): JobProjection {
    return this.#projections.get(jobId);
  }

  async continueJob(jobId: string): Promise<ContinuePrepublishResult> {
    if (this.#activeJobs.has(jobId)) {
      throw new PrepublishJobBusyError(jobId);
    }

    const initial = this.#jobs.getById(jobId);
    if (!initial) {
      throw new JobNotFoundError(jobId);
    }

    this.#activeJobs.add(jobId);

    try {
      let job = initial;

      if (
        job.status === "waiting_for_approval" ||
        job.status === "failed" ||
        job.status === "succeeded"
      ) {
        return {
          projection: this.#publish(jobId),
          blocked: job.status !== "succeeded",
          error: null,
        };
      }

      if (job.status === "publishing") {
        throw new UnsupportedPrepublishStateError(jobId, job.status);
      }

      const currentAction = this.#actionRequests.getCurrentOpenForJob(jobId);
      if (
        currentAction &&
        !(
          job.status === "waiting_for_login" &&
          currentAction.type === "login_required"
        )
      ) {
        return {
          projection: this.#publish(jobId),
          blocked: true,
          error: null,
        };
      }

      if (
        (job.status === "created" || job.status === "preparing_materials") &&
        !this.#getMaterial(jobId)
      ) {
        try {
          job = await this.#materialize(job);
          this.#publish(jobId);
        } catch (error) {
          return {
            projection: this.#publish(jobId),
            blocked: true,
            error: {
              code: errorCode(error),
              message: safeErrorMessage(error),
            },
          };
        }
      }

      if (job.status === "preparing_materials") {
        const material = this.#requireMaterial(jobId);
        const now = this.#now().toISOString();

        job = this.#jobs.commitCheckpoint(jobId, {
          status: "preparing_publish",
          checkpoint: {
            phase: "material_handoff",
            materialSource: material.source,
            generatedFromBrief: material.generatedFromBrief,
            planId: material.pack.planId,
          },
          step: {
            id: this.#createId(),
            stepKey: "material_handoff",
            status: "succeeded",
            outputJson: JSON.stringify({
              source: material.source,
              generatedFromBrief: material.generatedFromBrief,
              planId: material.pack.planId,
            }),
            finishedAt: now,
          },
        });
        this.#publish(jobId);
      }

      job = this.#jobs.getById(jobId)!;

      if (
        this.#publishingSecretary &&
        job.status === "preparing_publish"
      ) {
        const phase = job.checkpoint?.phase;
        if (
          phase === "publishing_secretary_prepared_candidate" ||
          phase === "publishing_secretary_needs_clarification"
        ) {
          const kind =
            phase === "publishing_secretary_prepared_candidate"
              ? "prepared_candidate"
              : "needs_clarification";
          return {
            projection: this.#publish(jobId),
            blocked: true,
            error:
              kind === "prepared_candidate"
                ? null
                : publishingSecretaryRunError({
                    kind,
                    summary: "Durable Publishing Secretary stop point.",
                    semanticMilestone: null,
                    browserToolCalls: 0,
                  }),
          };
        }
      }

      if (
        job.status !== "preparing_publish" &&
        job.status !== "waiting_for_login"
      ) {
        throw new UnsupportedPrepublishStateError(jobId, job.status);
      }

      let session: BrowserSession | null = null;

      try {
        try {
          session = await this.#browserProvider.acquire({});
        } catch (error) {
          this.#recordBrowserAcquireFailure(jobId);
          throw new PrepublishBrowserUnavailableError({ cause: error });
        }

        if (this.#publishingSecretary && job.status === "preparing_publish") {
          const automationProvider = asAutomationProvider(
            this.#browserProvider,
          );
          if (!automationProvider) {
            this.#recordBrowserAcquireFailure(jobId);
            throw new PrepublishBrowserUnavailableError();
          }

          const material = this.#requireMaterial(jobId);
          const agentResult = await this.#publishingSecretary.execute({
            jobId,
            browserProvider: automationProvider,
            browserSession: session,
            materialPack: material.pack,
          });

          if (agentResult.kind === "needs_identity") {
            const identitySurface = agentResult.identitySurface;
            if (
              identitySurface !== "qr_ready" &&
              identitySurface !== "verification_required"
            ) {
              throw new Error(
                "Publishing Secretary reached needs_identity without a safe identity surface.",
              );
            }

            this.#login.enterPreparedHumanTakeover({
              jobId,
              session,
              identitySurface,
            });
            return {
              projection: this.#publish(jobId),
              blocked: true,
              error: null,
            };
          }

          this.#recordPublishingSecretaryResult(jobId, agentResult);

          return {
            projection: this.#publish(jobId),
            blocked: true,
            error: publishingSecretaryRunError(agentResult),
          };
        }

        if (
          job.status === "waiting_for_login" ||
          !hasAuthenticatedOrPrepareCheckpoint(job)
        ) {
          const loginResult: XiaohongshuEnsureLoginResult =
            await this.#login.ensureLogin({
              jobId,
              session,
            });

          this.#publish(jobId);

          if (loginResult.kind === "human_takeover") {
            return {
              projection: this.#projections.get(jobId),
              blocked: true,
              error: null,
            };
          }

          if (this.#publishingSecretary) {
            return {
              projection: this.#projections.get(jobId),
              blocked: false,
              error: null,
            };
          }
        }

        job = this.#jobs.getById(jobId)!;
        if (job.status !== "preparing_publish") {
          return {
            projection: this.#publish(jobId),
            blocked: true,
            error: null,
          };
        }

        const material = this.#requireMaterial(jobId);
        const prepared: XiaohongshuPrepareForApprovalResult =
          await this.#prepare.prepareForApproval({
            jobId,
            session,
            materialPack: material.pack,
          });

        if (prepared.job.status !== "waiting_for_approval") {
          throw new Error(
            "Xiaohongshu prepare returned without the durable approval pause.",
          );
        }

        return {
          projection: this.#publish(jobId),
          blocked: true,
          error: null,
        };
      } catch (error) {
        const projection = this.#publish(jobId);
        return {
          projection,
          blocked: true,
          error: {
            code: errorCode(error),
            message: safeErrorMessage(error),
          },
        };
      } finally {
        if (session) {
          try {
            await this.#browserProvider.release(session.id);
          } catch {
            // BrowserProvider release is resource cleanup after durable workflow
            // state has already been committed. Keep that business outcome
            // authoritative, but surface the cleanup defect operationally.
            process.emitWarning(
              "Browser session cleanup failed after durable APP-02 state was committed.",
              { code: "APP_BROWSER_RELEASE_FAILED" },
            );
          }
        }
      }
    } finally {
      this.#activeJobs.delete(jobId);
    }
  }

  async #materialize(job: Job): Promise<Job> {
    const brief = briefFromJob(job);

    try {
      const material = await this.#materialSource.resolve({
        jobId: job.id,
        brief,
      });
      const persistedMaterial = serializePrepublishMaterial(material);

      // Re-parse the exact bytes that will become durable Publisher execution
      // state before committing them.
      parsePrepublishMaterial(persistedMaterial);

      const latest = this.#requireJob(job.id);
      if (
        latest.status !== "created" &&
        latest.status !== "preparing_materials"
      ) {
        throw new Error(
          `Job ${job.id} advanced to ${latest.status} while material was being prepared.`,
        );
      }

      const now = this.#now().toISOString();
      return this.#jobs.commitCheckpoint(job.id, {
        status: "preparing_materials",
        checkpoint: {
          phase: "material_ready",
          materialSource: material.source,
          generatedFromBrief: material.generatedFromBrief,
          planId: material.pack.planId,
        },
        step: {
          id: this.#createId(),
          stepKey: PREPUBLISH_MATERIAL_STEP_KEY,
          status: "succeeded",
          attempt: this.#nextStepAttempt(job.id, PREPUBLISH_MATERIAL_STEP_KEY),
          outputJson: persistedMaterial,
          finishedAt: now,
        },
      });
    } catch (error) {
      const retryable =
        error instanceof PrepublishMaterialResolutionError &&
        error.retryable;
      const diagnostic = boundedMaterialFailureDiagnostic(error);

      if (!retryable) {
        this.#recordMaterialSourceFailure(job.id, diagnostic);
      }

      throw new PrepublishMaterialSourceError({ cause: error });
    }
  }

  #recordMaterialSourceFailure(
    jobId: string,
    diagnostic: BoundedMaterialFailureDiagnostic,
  ): void {
    const job = this.#requireJob(jobId);
    if (job.status !== "created" && job.status !== "preparing_materials") {
      return;
    }

    try {
      const now = this.#now().toISOString();
      this.#jobs.commitCheckpoint(jobId, {
        status: "failed",
        checkpoint: {
          phase: "material_source_failed",
          materialFailureStage: diagnostic.stage,
          materialFailureCode: diagnostic.code,
        },
        step: {
          id: this.#createId(),
          stepKey: PREPUBLISH_MATERIAL_STEP_KEY,
          status: "failed",
          attempt: this.#nextStepAttempt(jobId, PREPUBLISH_MATERIAL_STEP_KEY),
          errorCode: "MATERIAL_SOURCE_UNAVAILABLE",
          errorMessage: `Material source failed at ${diagnostic.stage} (${diagnostic.code}).`,
          finishedAt: now,
        },
      });
    } catch {
      process.emitWarning(
        "Material-source failure could not be persisted for APP-02.",
        { code: "APP_MATERIAL_FAILURE_PERSIST_FAILED" },
      );
    }
  }

  #recordBrowserAcquireFailure(jobId: string): void {
    const job = this.#requireJob(jobId);
    if (job.status !== "preparing_publish") {
      return;
    }

    const openAction = this.#actionRequests.getCurrentOpenForJob(jobId);
    if (openAction) {
      return;
    }

    try {
      const now = this.#now().toISOString();
      this.#jobs.commitCheckpoint(jobId, {
        status: "preparing_publish",
        checkpoint: {
          phase: "browser_session_unavailable",
        },
        step: {
          id: this.#createId(),
          stepKey: BROWSER_ACQUIRE_STEP_KEY,
          status: "failed",
          attempt: this.#nextStepAttempt(jobId, BROWSER_ACQUIRE_STEP_KEY),
          errorCode: "BROWSER_UNAVAILABLE",
          errorMessage: "The controlled browser runtime is currently unavailable.",
          finishedAt: now,
        },
      });
    } catch {
      process.emitWarning(
        "Browser acquisition failure could not be persisted for APP-02.",
        { code: "APP_BROWSER_FAILURE_PERSIST_FAILED" },
      );
    }
  }

  #recordPublishingSecretaryResult(
    jobId: string,
    result: PublishingSecretaryExecutionResult,
  ): void {
    const job = this.#requireJob(jobId);
    if (job.status !== "preparing_publish") {
      throw new UnsupportedPrepublishStateError(jobId, job.status);
    }

    const now = this.#now().toISOString();
    const failed = result.kind === "failed";
    this.#jobs.commitCheckpoint(jobId, {
      status: failed ? "failed" : "preparing_publish",
      checkpoint: {
        phase: "publishing_secretary_" + result.kind,
        publishingSecretaryKind: result.kind,
        publishingSecretaryMilestone:
          result.semanticMilestone ?? "none",
        publishingSecretaryBrowserToolCalls: result.browserToolCalls,
      },
      step: {
        id: this.#createId(),
        stepKey: "publishing_secretary_execution",
        status: failed ? "failed" : "succeeded",
        attempt: this.#nextStepAttempt(
          jobId,
          "publishing_secretary_execution",
        ),
        outputJson: JSON.stringify({
          kind: result.kind,
          summary: result.summary,
          semanticMilestone: result.semanticMilestone,
          identitySurface: result.identitySurface ?? null,
          browserToolCalls: result.browserToolCalls,
        }),
        ...(failed
          ? {
              errorCode: "PUBLISHING_SECRETARY_FAILED",
              errorMessage: result.summary,
            }
          : {}),
        finishedAt: now,
      },
    });
  }

  #getMaterial(jobId: string): PersistedPrepublishMaterial | null {
    return findPersistedPrepublishMaterial(
      this.#jobs.getStepsForJob(jobId),
    );
  }

  #requireMaterial(jobId: string): PersistedPrepublishMaterial {
    const material = this.#getMaterial(jobId);
    if (!material) {
      throw new Error(
        `Job ${jobId} has no durable material pack for pre-publish execution.`,
      );
    }
    return material;
  }

  #nextStepAttempt(jobId: string, stepKey: string): number {
    return (
      this.#jobs
        .getStepsForJob(jobId)
        .filter((step) => step.stepKey === stepKey)
        .reduce((highest, step) => Math.max(highest, step.attempt), 0) + 1
    );
  }

  #requireJob(jobId: string): Job {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  #publish(jobId: string): JobProjection {
    const projection = this.#projections.get(jobId);
    this.#events.publish(projection);
    return projection;
  }
}
