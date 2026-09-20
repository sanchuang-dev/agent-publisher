import { createHash, randomUUID } from "node:crypto";

import type { BrowserSession } from "../../browser/provider.js";
import {
  getCheckpointActionRequestId,
  type ActionRequest,
  type ActionRequestRepository,
  type Job,
  type JobRepository,
  type JsonValue,
} from "../../contracts/job.js";
import { JobControlService } from "../../jobs/job-control-service.js";
import type {
  ImageTextMaterialPack,
  MaterialPack,
} from "../../materials/contracts.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
  prepareXiaohongshuPublication,
  verifyXiaohongshuPreparedPage,
  XiaohongshuComposerNotFreshError,
  XiaohongshuPageStateError,
  XiaohongshuPreparedValidationError,
  XiaohongshuUnsupportedPublishModeError,
  type AssetPathResolver,
  type PreparedImageTextPublication,
  type PrepareXiaohongshuPublicationInput,
  type VerifiedPreparedForm,
  type VerifyXiaohongshuPreparedPageInput,
} from "./image-text-prepare.js";

type PreparePage = (
  input: PrepareXiaohongshuPublicationInput,
) => Promise<PreparedImageTextPublication>;

type VerifyPreparedPage = (
  input: VerifyXiaohongshuPreparedPageInput,
) => Promise<VerifiedPreparedForm>;

const activePrepareJobs = new Set<string>();
const activePrepareSessions = new Set<string>();

export class XiaohongshuPrepareStateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "XiaohongshuPrepareStateError";
  }
}

export class XiaohongshuPrepareRecoveryRequiredError extends Error {
  readonly code = "PREPARE_RECOVERY_REQUIRED" as const;

  constructor(
    readonly actionRequestId: string,
    readonly failureCode: string,
    options?: ErrorOptions,
  ) {
    super(
      "Xiaohongshu prepare requires human recovery before it can continue.",
      options,
    );
    this.name = "XiaohongshuPrepareRecoveryRequiredError";
  }
}

export interface XiaohongshuPrepareForApprovalInput {
  readonly jobId: string;
  readonly session: BrowserSession;
  readonly materialPack: MaterialPack;
}

export interface XiaohongshuPrepareForApprovalResult {
  readonly prepared: PreparedImageTextPublication;
  readonly job: Job;
  readonly approval: ActionRequest;
  readonly reused: boolean;
}

export interface XiaohongshuPrepareServiceDependencies {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly jobControl: JobControlService;
  readonly resolveAssetPath: AssetPathResolver;
  readonly preparePage?: PreparePage;
  readonly verifyPreparedPage?: VerifyPreparedPage;
  readonly createId?: (kind: "step" | "action") => string;
  readonly now?: () => Date;
}

function jsonObject(
  value: JsonValue | undefined,
): Readonly<Record<string, JsonValue>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, JsonValue>>;
}

function stringArray(value: JsonValue | undefined): readonly string[] | null {
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    return null;
  }
  return value;
}

function preparedFromCheckpoint(
  checkpoint: Job["checkpoint"],
): PreparedImageTextPublication | null {
  if (!checkpoint) return null;

  const value = jsonObject(checkpoint.preparedPublication);
  if (!value) return null;

  const tags = stringArray(value.tags);
  const imageAssetIds = stringArray(value.imageAssetIds);

  if (
    value.platform !== "xiaohongshu" ||
    value.mode !== "image_text" ||
    typeof value.planId !== "string" ||
    typeof value.title !== "string" ||
    typeof value.bodyLength !== "number" ||
    !tags ||
    !imageAssetIds ||
    typeof value.imageCount !== "number" ||
    typeof value.contentFingerprint !== "string" ||
    typeof value.verifiedAt !== "string"
  ) {
    return null;
  }

  return {
    platform: "xiaohongshu",
    mode: "image_text",
    planId: value.planId,
    title: value.title,
    bodyLength: value.bodyLength,
    tags,
    imageAssetIds,
    imageCount: value.imageCount,
    contentFingerprint: value.contentFingerprint,
    verifiedAt: value.verifiedAt,
  };
}

function browserProfileFingerprint(session: BrowserSession): string {
  return createHash("sha256").update(session.profileRef).digest("hex");
}

function sessionGuardKey(session: BrowserSession): string {
  return session.id + ":" + browserProfileFingerprint(session);
}

function preparedCheckpointValue(
  prepared: PreparedImageTextPublication,
): JsonValue {
  return {
    platform: prepared.platform,
    mode: prepared.mode,
    planId: prepared.planId,
    title: prepared.title,
    bodyLength: prepared.bodyLength,
    tags: [...prepared.tags],
    imageAssetIds: [...prepared.imageAssetIds],
    imageCount: prepared.imageCount,
    contentFingerprint: prepared.contentFingerprint,
    verifiedAt: prepared.verifiedAt,
  };
}

function uniqueImageAssetIds(pack: ImageTextMaterialPack): readonly string[] {
  return [...new Set([pack.cover, ...pack.images].map((asset) => asset.assetId))];
}

function buildPreparedFromVerified(
  pack: ImageTextMaterialPack,
  verified: VerifiedPreparedForm,
  verifiedAt: string,
): PreparedImageTextPublication {
  return {
    platform: "xiaohongshu",
    mode: "image_text",
    planId: pack.planId,
    title: verified.title,
    bodyLength: verified.bodyLength,
    tags: verified.tags,
    imageAssetIds: uniqueImageAssetIds(pack),
    imageCount: verified.imageCount,
    contentFingerprint: fingerprintXiaohongshuImageTextMaterialPack(pack),
    verifiedAt,
  };
}

function failureCode(error: unknown): string {
  if (
    error instanceof XiaohongshuPreparedValidationError ||
    error instanceof XiaohongshuComposerNotFreshError ||
    error instanceof XiaohongshuPageStateError
  ) {
    return error.code;
  }

  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { readonly code?: unknown }).code === "string"
  ) {
    return (error as { readonly code: string }).code;
  }

  return "PREPARE_FAILED";
}

function safeFailureMessage(error: unknown): string {
  if (error instanceof XiaohongshuPreparedValidationError) {
    return "Prepared form did not match the intended material.";
  }
  if (error instanceof XiaohongshuComposerNotFreshError) {
    return "The Xiaohongshu composer contains content that cannot be overwritten safely.";
  }
  if (error instanceof XiaohongshuPageStateError) {
    const safeMessages: Readonly<
      Record<XiaohongshuPageStateError["code"], string>
    > = {
      PLATFORM_UI_CHANGED:
        "The Xiaohongshu composer UI no longer matched the supported shape.",
      PLATFORM_EDITOR_STATE_CHANGED:
        "The Xiaohongshu editor state was ambiguous or changed unexpectedly.",
      PLATFORM_UPLOAD_FAILED:
        "Xiaohongshu reported an image upload or processing failure.",
      PLATFORM_UPLOAD_TIMEOUT:
        "The Xiaohongshu image upload did not reach the expected ready state.",
      ASSET_RESOLUTION_FAILED:
        "One or more controlled image assets could not be resolved.",
      BROWSER_INTERACTION_FAILED:
        "The browser interaction failed after the prepare mutation boundary.",
    };
    return safeMessages[error.code];
  }
  return "Xiaohongshu prepare failed after the browser mutation boundary.";
}

function recoveryCheckpointMatches(
  job: Job,
  contentFingerprint: string,
  profileFingerprint: string,
): boolean {
  if (!job.checkpoint) return false;

  if (
    job.checkpoint.phase !== "xhs_prepare_attempt" &&
    job.checkpoint.phase !== "xhs_prepare_recovery_required"
  ) {
    return false;
  }

  return (
    job.checkpoint.contentFingerprint === contentFingerprint &&
    job.checkpoint.browserProfileFingerprint === profileFingerprint
  );
}

function hasRecoveryPhase(job: Job): boolean {
  return (
    job.checkpoint?.phase === "xhs_prepare_attempt" ||
    job.checkpoint?.phase === "xhs_prepare_recovery_required"
  );
}

function isAuthenticatedLoginCheckpoint(
  job: Job,
  profileFingerprint: string,
): boolean {
  return (
    job.checkpoint?.platform === "xiaohongshu" &&
    job.checkpoint.phase === "ensure_login" &&
    job.checkpoint.entryState === "authenticated" &&
    job.checkpoint.browserProfileFingerprint === profileFingerprint
  );
}

function persistedRunningAttempt(job: Job): number | null {
  if (job.checkpoint?.phase !== "xhs_prepare_attempt") return null;
  const value = job.checkpoint.attempt;
  return typeof value === "number" && Number.isInteger(value) && value > 0
    ? value
    : null;
}

function recoveryResetConfirmed(
  job: Job,
  actionRequests: ActionRequestRepository,
): boolean {
  if (!job.checkpoint) return false;
  const actionId = getCheckpointActionRequestId(job.checkpoint);
  if (!actionId) return false;

  const action = actionRequests.getById(actionId);
  if (
    !action ||
    action.type !== "clarification_required" ||
    action.status !== "resolved" ||
    typeof action.resolution !== "object" ||
    action.resolution === null ||
    Array.isArray(action.resolution)
  ) {
    return false;
  }

  return (
    (action.resolution as Readonly<Record<string, JsonValue>>).composerReset ===
    true
  );
}

export class XiaohongshuPrepareService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #jobControl: JobControlService;
  readonly #resolveAssetPath: AssetPathResolver;
  readonly #preparePage: PreparePage;
  readonly #verifyPreparedPage: VerifyPreparedPage;
  readonly #createId: (kind: "step" | "action") => string;
  readonly #now: () => Date;

  constructor(dependencies: XiaohongshuPrepareServiceDependencies) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
    this.#jobControl = dependencies.jobControl;
    this.#resolveAssetPath = dependencies.resolveAssetPath;
    this.#preparePage = dependencies.preparePage ?? prepareXiaohongshuPublication;
    this.#verifyPreparedPage =
      dependencies.verifyPreparedPage ?? verifyXiaohongshuPreparedPage;
    this.#createId =
      dependencies.createId ??
      ((kind) => "xhs-" + kind + "-" + randomUUID());
    this.#now = dependencies.now ?? (() => new Date());
  }

  async prepareForApproval(
    input: XiaohongshuPrepareForApprovalInput,
  ): Promise<XiaohongshuPrepareForApprovalResult> {
    const job = this.#jobs.getById(input.jobId);
    if (!job) {
      throw new XiaohongshuPrepareStateError(
        "Cannot prepare missing job " + input.jobId + ".",
      );
    }

    if (job.platform !== "xiaohongshu") {
      throw new XiaohongshuPrepareStateError(
        "Job " + input.jobId + " is not a Xiaohongshu publication.",
      );
    }

    if (input.materialPack.mode !== "image_text") {
      throw new XiaohongshuUnsupportedPublishModeError(input.materialPack.mode);
    }

    if (job.publishMode !== input.materialPack.mode) {
      throw new XiaohongshuPrepareStateError(
        "Job publish mode does not match the supplied MaterialPack.",
      );
    }

    const sessionKey = sessionGuardKey(input.session);
    if (
      activePrepareJobs.has(input.jobId) ||
      activePrepareSessions.has(sessionKey)
    ) {
      throw new XiaohongshuPrepareStateError(
        "A Xiaohongshu prepare is already active for this job or browser session.",
      );
    }

    activePrepareJobs.add(input.jobId);
    activePrepareSessions.add(sessionKey);

    try {
      const guardedJob = this.#jobs.getById(input.jobId);
      if (!guardedJob) {
        throw new XiaohongshuPrepareStateError(
          "Job disappeared before prepare could start.",
        );
      }

      if (guardedJob.status === "waiting_for_approval") {
        return await this.#reuseApprovalPause(
          guardedJob,
          input.materialPack,
          input.session,
        );
      }

      if (guardedJob.status !== "preparing_publish") {
        throw new XiaohongshuPrepareStateError(
          "Xiaohongshu prepare requires preparing_publish; job is " +
            guardedJob.status +
            ".",
        );
      }

      const openAction = this.#actionRequests.getCurrentOpenForJob(input.jobId);
      if (openAction) {
        throw new XiaohongshuPrepareStateError(
          "Browser mutation is blocked while human action " +
            openAction.type +
            " is open.",
        );
      }

      const contentFingerprint =
        fingerprintXiaohongshuImageTextMaterialPack(input.materialPack);
      const profileFingerprint = browserProfileFingerprint(input.session);

      if (
        !hasRecoveryPhase(guardedJob) &&
        !isAuthenticatedLoginCheckpoint(guardedJob, profileFingerprint)
      ) {
        throw new XiaohongshuPrepareStateError(
          "Xiaohongshu prepare requires the authenticated XHS-01 checkpoint on the same browser profile.",
        );
      }

      if (
        hasRecoveryPhase(guardedJob) &&
        !recoveryCheckpointMatches(
          guardedJob,
          contentFingerprint,
          profileFingerprint,
        )
      ) {
        throw new XiaohongshuPrepareStateError(
          "Persisted Xiaohongshu recovery state belongs to different content or browser profile.",
        );
      }

      const recoveryMode = recoveryCheckpointMatches(
        guardedJob,
        contentFingerprint,
        profileFingerprint,
      );
      const attempt =
        persistedRunningAttempt(guardedJob) ?? this.#nextAttempt(input.jobId);
      const stepId = this.#createId("step");

      if (recoveryMode) {
        try {
          const live = await this.#verifyPreparedPage({
            page: input.session.page,
            materialPack: input.materialPack,
            timeoutMs: 2_000,
          });
          const prepared = buildPreparedFromVerified(
            input.materialPack,
            live,
            this.#now().toISOString(),
          );
          return this.#enterApprovalPause(
            input.jobId,
            input.materialPack,
            input.session,
            prepared,
            stepId,
            attempt,
            true,
          );
        } catch (error) {
          // A durable attempt means the previous process may have crossed the
          // upload mutation boundary even when previews are not visible yet.
          // Never upload again unless the human explicitly confirms that the
          // composer has been reset.
          if (!recoveryResetConfirmed(guardedJob, this.#actionRequests)) {
            this.#raiseRecoveryPause(
              { jobId: input.jobId, materialPack: input.materialPack },
              contentFingerprint,
              profileFingerprint,
              stepId,
              attempt,
              error,
            );
          }
        }
      }

      let mutationStarted = false;

      try {
        const prepared = await this.#preparePage({
          page: input.session.page,
          materialPack: input.materialPack,
          resolveAssetPath: this.#resolveAssetPath,
          onMutationStarted: () => {
            this.#jobs.commitCheckpoint(input.jobId, {
              status: "preparing_publish",
              checkpoint: {
                phase: "xhs_prepare_attempt",
                contentFingerprint,
                browserProfileFingerprint: profileFingerprint,
                attempt,
              },
              step: {
                id: stepId,
                stepKey: "verify_prepared",
                status: "running",
                attempt,
                inputJson: JSON.stringify({
                  platform: "xiaohongshu",
                  mode: "image_text",
                  planId: input.materialPack.planId,
                  contentFingerprint,
                }),
              },
            });
            mutationStarted = true;
          },
        });

        return this.#enterApprovalPause(
          input.jobId,
          input.materialPack,
          input.session,
          prepared,
          stepId,
          attempt,
          false,
        );
      } catch (error) {
        if (
          mutationStarted ||
          (recoveryMode && error instanceof XiaohongshuComposerNotFreshError)
        ) {
          this.#raiseRecoveryPause(
            { jobId: input.jobId, materialPack: input.materialPack },
            contentFingerprint,
            profileFingerprint,
            stepId,
            attempt,
            error,
          );
        }
        throw error;
      }
    } finally {
      activePrepareJobs.delete(input.jobId);
      activePrepareSessions.delete(sessionKey);
    }
  }

  #nextAttempt(jobId: string): number {
    const attempts = this.#jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === "verify_prepared")
      .map((step) => step.attempt);
    return attempts.length === 0 ? 1 : Math.max(...attempts) + 1;
  }

  #enterApprovalPause(
    jobId: string,
    materialPack: ImageTextMaterialPack,
    session: BrowserSession,
    prepared: PreparedImageTextPublication,
    stepId: string,
    attempt: number,
    reused: boolean,
  ): XiaohongshuPrepareForApprovalResult {
    const result = this.#jobControl.enterWaiting({
      jobId,
      status: "waiting_for_approval",
      checkpoint: {
        phase: "prepared_for_approval",
        browserProfileFingerprint: browserProfileFingerprint(session),
        preparedPublication: preparedCheckpointValue(prepared),
      },
      step: {
        id: stepId,
        stepKey: "verify_prepared",
        status: "succeeded",
        attempt,
        outputJson: JSON.stringify(prepared),
      },
      action: {
        id: this.#createId("action"),
        payload: {
          platform: prepared.platform,
          mode: prepared.mode,
          planId: prepared.planId,
          title: prepared.title,
          bodyLength: prepared.bodyLength,
          tags: [...prepared.tags],
          imageCount: prepared.imageCount,
          warningCodes: materialPack.warnings.map(
            (warning) => warning.code,
          ),
          contentFingerprint: prepared.contentFingerprint,
        },
      },
    });

    return {
      prepared,
      job: result.job,
      approval: result.action,
      reused,
    };
  }

  #raiseRecoveryPause(
    input: {
      readonly jobId: string;
      readonly materialPack: ImageTextMaterialPack;
    },
    contentFingerprint: string,
    profileFingerprint: string,
    stepId: string,
    attempt: number,
    error: unknown,
  ): never {
    const code = failureCode(error);
    const result = this.#jobControl.requestClarification({
      jobId: input.jobId,
      checkpoint: {
        phase: "xhs_prepare_recovery_required",
        contentFingerprint,
        browserProfileFingerprint: profileFingerprint,
        failureCode: code,
        attempt,
      },
      step: {
        id: stepId,
        stepKey: "verify_prepared",
        status: "failed",
        attempt,
        errorCode: code,
        errorMessage: safeFailureMessage(error),
      },
      action: {
        id: this.#createId("action"),
        payload: {
          platform: "xiaohongshu",
          mode: "image_text",
          planId: input.materialPack.planId,
          reason: "prepare_recovery_required",
          failureCode: code,
          contentFingerprint,
          guidance:
            "Inspect the current Xiaohongshu composer. Keep it unchanged to resume if it already matches this job, or clear/reset it before retrying.",
        },
      },
    });

    throw new XiaohongshuPrepareRecoveryRequiredError(
      result.action.id,
      code,
      { cause: error },
    );
  }

  async #reuseApprovalPause(
    job: Job,
    materialPack: ImageTextMaterialPack,
    session: BrowserSession,
  ): Promise<XiaohongshuPrepareForApprovalResult> {
    const prepared = preparedFromCheckpoint(job.checkpoint);
    if (!prepared) {
      throw new XiaohongshuPrepareStateError(
        "waiting_for_approval is missing a valid prepared-publication checkpoint.",
      );
    }

    const expectedFingerprint =
      fingerprintXiaohongshuImageTextMaterialPack(materialPack);
    if (prepared.contentFingerprint !== expectedFingerprint) {
      throw new XiaohongshuPrepareStateError(
        "Cannot replace the content under an existing approval pause.",
      );
    }

    const persistedProfileFingerprint =
      job.checkpoint?.browserProfileFingerprint;
    if (
      typeof persistedProfileFingerprint !== "string" ||
      persistedProfileFingerprint !== browserProfileFingerprint(session)
    ) {
      throw new XiaohongshuPrepareStateError(
        "Current browser profile does not match the prepared approval pause.",
      );
    }

    const actionId = job.checkpoint
      ? getCheckpointActionRequestId(job.checkpoint)
      : null;
    if (!actionId) {
      throw new XiaohongshuPrepareStateError(
        "waiting_for_approval is not bound to an ActionRequest.",
      );
    }

    const approval = this.#actionRequests.getById(actionId);
    if (
      !approval ||
      approval.jobId !== job.id ||
      approval.type !== "approval_required" ||
      approval.status !== "open"
    ) {
      throw new XiaohongshuPrepareStateError(
        "waiting_for_approval is not bound to a reusable approval request.",
      );
    }

    await this.#verifyPreparedPage({
      page: session.page,
      materialPack,
    });

    return {
      prepared,
      job,
      approval,
      reused: true,
    };
  }
}
