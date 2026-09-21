import { randomUUID } from "node:crypto";

import type { BrowserSession } from "../../browser/provider.js";
import type {
  AppendPublicationEvidenceInput,
  EvidenceRepository,
  PublicationEvidence,
} from "../../contracts/evidence.js";
import {
  getCheckpointActionRequestId,
  isApprovalResolution,
  JobNotFoundError,
  type ActionRequestRepository,
  type Job,
  type JobRepository,
} from "../../contracts/job.js";
import {
  requiresVerifyFirst,
  type ExternalAction,
  type ExternalActionRepository,
} from "../../contracts/external-action.js";
import { JobControlService } from "../../jobs/job-control-service.js";
import {
  executeXiaohongshuPublish,
  verifyXiaohongshuPublishResult,
  type ExecuteXiaohongshuPublishInput,
  type VerifyXiaohongshuPublishResultInput,
  type XiaohongshuPublishVerificationResult,
  XiaohongshuPublishVerificationUncertainError,
} from "./publish.js";

const PUBLISH_ACTION_TYPE = "publish";
export const XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY =
  "publish:xiaohongshu:final" as const;
export const XIAOHONGSHU_PUBLISH_STEP_KEY = "publish_once" as const;

type PublishPage = (input: ExecuteXiaohongshuPublishInput) => Promise<void>;
type VerifyResult = (
  input: VerifyXiaohongshuPublishResultInput,
) => Promise<XiaohongshuPublishVerificationResult>;

export interface XiaohongshuPublishServiceDependencies {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly jobControl: JobControlService;
  readonly externalActions: ExternalActionRepository;
  readonly evidence: EvidenceRepository;
  readonly publishPage?: PublishPage;
  readonly verifyResult?: VerifyResult;
  readonly createId?: (
    kind: "external_action" | "step" | "evidence",
  ) => string;
  readonly now?: () => Date;
}

export interface XiaohongshuPublishInput {
  readonly jobId: string;
  readonly session: BrowserSession;
}

export interface XiaohongshuPublishResult {
  readonly job: Job;
  readonly action: ExternalAction;
  readonly evidence: readonly PublicationEvidence[];
  readonly reused: boolean;
  readonly verifyFirst: boolean;
}

export class XiaohongshuPublishStateError extends Error {
  readonly code = "PUBLISH_STATE_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "XiaohongshuPublishStateError";
  }
}

export class XiaohongshuPublishApprovalError extends Error {
  readonly code = "PUBLISH_APPROVAL_REQUIRED" as const;

  constructor(message: string) {
    super(message);
    this.name = "XiaohongshuPublishApprovalError";
  }
}

export class XiaohongshuPublishUnknownError extends Error {
  readonly code = "PUBLISH_RESULT_UNKNOWN" as const;

  constructor(options?: ErrorOptions) {
    super(
      "The Xiaohongshu publish result is uncertain. Verification is required before any further mutation.",
      options,
    );
    this.name = "XiaohongshuPublishUnknownError";
  }
}

export class XiaohongshuPublishFailedError extends Error {
  readonly code = "PUBLISH_FAILED" as const;

  constructor(message = "Xiaohongshu publication was not confirmed.") {
    super(message);
    this.name = "XiaohongshuPublishFailedError";
  }
}

function nextAttempt(
  jobs: JobRepository,
  jobId: string,
  stepKey: string,
): number {
  return (
    jobs
      .getStepsForJob(jobId)
      .filter((step) => step.stepKey === stepKey)
      .reduce((highest, step) => Math.max(highest, step.attempt), 0) + 1
  );
}

function preparedFingerprint(job: Job): string {
  const prepared = job.checkpoint?.preparedPublication;
  if (
    typeof prepared !== "object" ||
    prepared === null ||
    Array.isArray(prepared)
  ) {
    throw new XiaohongshuPublishStateError(
      "The durable prepared-for-approval checkpoint is missing its content fingerprint.",
    );
  }

  const value = (prepared as Readonly<Record<string, unknown>>)[
    "contentFingerprint"
  ];
  if (typeof value !== "string" || value.length === 0) {
    throw new XiaohongshuPublishStateError(
      "The durable prepared-for-approval checkpoint is missing its content fingerprint.",
    );
  }
  return value;
}

function requireAffirmativeApproval(
  job: Job,
  actionRequests: ActionRequestRepository,
): { readonly approvalId: string; readonly contentFingerprint: string } {
  if (job.status !== "waiting_for_approval") {
    throw new XiaohongshuPublishApprovalError(
      "The Job is not waiting for publish approval.",
    );
  }

  const approvalId = job.checkpoint
    ? getCheckpointActionRequestId(job.checkpoint)
    : null;
  if (!approvalId) {
    throw new XiaohongshuPublishApprovalError(
      "The durable approval checkpoint is not bound to an ActionRequest.",
    );
  }

  const approval = actionRequests.getById(approvalId);
  if (
    !approval ||
    approval.jobId !== job.id ||
    approval.type !== "approval_required" ||
    approval.status !== "resolved" ||
    !isApprovalResolution(approval.resolution) ||
    approval.resolution.approved !== true
  ) {
    throw new XiaohongshuPublishApprovalError(
      "A durable affirmative approval for this Job is required.",
    );
  }

  return {
    approvalId,
    contentFingerprint: preparedFingerprint(job),
  };
}

function publishingCheckpoint(job: Job): {
  readonly approvalId: string;
  readonly contentFingerprint: string;
} {
  if (job.status !== "publishing") {
    throw new XiaohongshuPublishStateError(
      "The Job is not in the publishing state.",
    );
  }

  const approvalId = job.checkpoint?.approvalRequestId;
  const contentFingerprint = job.checkpoint?.contentFingerprint;
  if (
    job.checkpoint?.actionKey !== XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY ||
    typeof approvalId !== "string" ||
    approvalId.length === 0 ||
    typeof contentFingerprint !== "string" ||
    contentFingerprint.length === 0
  ) {
    throw new XiaohongshuPublishStateError(
      "The publishing checkpoint is not bound to the approved prepared state.",
    );
  }

  return { approvalId, contentFingerprint };
}

function evidenceId(actionId: string, suffix: string): string {
  return "pub-" + actionId + "-" + suffix;
}

function evidenceInputForPublishedResult(
  jobId: string,
  actionId: string,
  result: Extract<XiaohongshuPublishVerificationResult, { kind: "published" }>,
  capturedAt: string,
): readonly AppendPublicationEvidenceInput[] {
  const inputs: AppendPublicationEvidenceInput[] = [];

  if (result.resultUrl) {
    inputs.push({
      id: evidenceId(actionId, "url"),
      jobId,
      kind: "result_url",
      uri: result.resultUrl,
      metadata: {
        platform: "xiaohongshu",
        verifiedBy: "deterministic_result_page",
        capturedAt,
      },
    });
  }

  if (result.contentId) {
    inputs.push({
      id: evidenceId(actionId, "content"),
      jobId,
      kind: "content_id",
      value: result.contentId,
      metadata: {
        platform: "xiaohongshu",
        verifiedBy: "deterministic_result_page",
        capturedAt,
      },
    });
  }

  inputs.push({
    id: evidenceId(actionId, "confirmation"),
    jobId,
    kind: "confirmation_ref",
    value: result.confirmationRef,
    metadata: {
      platform: "xiaohongshu",
      verifiedBy: "deterministic_result_page",
      capturedAt,
    },
  });

  return inputs;
}

function sameEvidence(
  existing: PublicationEvidence,
  input: AppendPublicationEvidenceInput,
): boolean {
  return (
    existing.id === input.id &&
    existing.jobId === input.jobId &&
    existing.kind === input.kind &&
    existing.uri === (input.uri ?? null) &&
    existing.value === (input.value ?? null)
  );
}

export class XiaohongshuPublishService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #jobControl: JobControlService;
  readonly #externalActions: ExternalActionRepository;
  readonly #evidence: EvidenceRepository;
  readonly #publishPage: PublishPage;
  readonly #verifyResult: VerifyResult;
  readonly #createId: XiaohongshuPublishServiceDependencies["createId"];
  readonly #now: () => Date;

  constructor(dependencies: XiaohongshuPublishServiceDependencies) {
    this.#jobs = dependencies.jobs;
    this.#actionRequests = dependencies.actionRequests;
    this.#jobControl = dependencies.jobControl;
    this.#externalActions = dependencies.externalActions;
    this.#evidence = dependencies.evidence;
    this.#publishPage =
      dependencies.publishPage ?? executeXiaohongshuPublish;
    this.#verifyResult =
      dependencies.verifyResult ?? verifyXiaohongshuPublishResult;
    this.#createId =
      dependencies.createId ??
      ((kind) => "xhs-" + kind + "-" + randomUUID());
    this.#now = dependencies.now ?? (() => new Date());
  }

  authorizeAfterApproval(jobId: string): {
    readonly job: Job;
    readonly action: ExternalAction;
    readonly approvalId: string;
    readonly contentFingerprint: string;
  } {
    const current = this.#requireSupportedJob(jobId);

    if (current.status === "publishing") {
      const authorization = publishingCheckpoint(current);
      const action = this.#externalActions.getByKey(
        jobId,
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      );
      if (!action) {
        throw new XiaohongshuPublishStateError(
          "Publishing Job has no durable final-publish ExternalAction.",
        );
      }
      return {
        job: current,
        action,
        ...authorization,
      };
    }

    if (current.status !== "waiting_for_approval") {
      throw new XiaohongshuPublishStateError(
        "Final publish authorization requires waiting_for_approval; found " +
          current.status +
          ".",
      );
    }

    const authorization = requireAffirmativeApproval(
      current,
      this.#actionRequests,
    );
    const action = this.#externalActions.prepare({
      id: this.#createId!("external_action"),
      jobId,
      actionType: PUBLISH_ACTION_TYPE,
      actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
    });

    const latest = this.#requireSupportedJob(jobId);
    if (latest.status === "publishing") {
      const durable = publishingCheckpoint(latest);
      return {
        job: latest,
        action,
        ...durable,
      };
    }

    const job = this.#jobControl.beginPublishingAfterApproval({
      jobId,
      checkpoint: {
        phase: "publish_authorized",
        platform: "xiaohongshu",
        actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        externalActionId: action.id,
        approvalRequestId: authorization.approvalId,
        contentFingerprint: authorization.contentFingerprint,
      },
      step: {
        id: this.#createId!("step"),
        stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
        status: "pending",
        attempt: nextAttempt(
          this.#jobs,
          jobId,
          XIAOHONGSHU_PUBLISH_STEP_KEY,
        ),
        inputJson: JSON.stringify({
          platform: "xiaohongshu",
          approvalRequestId: authorization.approvalId,
          contentFingerprint: authorization.contentFingerprint,
        }),
      },
    });

    return {
      job,
      action,
      ...authorization,
    };
  }

  async publishAfterApproval(
    input: XiaohongshuPublishInput,
  ): Promise<XiaohongshuPublishResult> {
    const job = this.#requireSupportedJob(input.jobId);

    if (job.status === "succeeded") {
      const settled = this.#externalActions.getByKey(
        job.id,
        XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
      );
      if (!settled || settled.status !== "succeeded") {
        throw new XiaohongshuPublishStateError(
          "Succeeded Job has no matching succeeded publish action.",
        );
      }
      return {
        job,
        action: settled,
        evidence: this.#evidence.getByJob(job.id),
        reused: true,
        verifyFirst: false,
      };
    }

    const authorization = this.authorizeAfterApproval(job.id);
    const action = authorization.action;

    if (action.status === "succeeded") {
      return this.#finalizeExistingSucceededAction(job.id, action);
    }

    if (action.status === "failed") {
      this.#failJobIfPublishing(
        job.id,
        action,
        action.errorCode ?? "PUBLISH_FAILED",
        "The durable publish action is already settled as failed.",
      );
      throw new XiaohongshuPublishFailedError();
    }

    if (requiresVerifyFirst(action)) {
      return this.#verifyFirst(job.id, input.session, action);
    }

    const started = this.#externalActions.start(action.id);
    const attempt = nextAttempt(
      this.#jobs,
      job.id,
      XIAOHONGSHU_PUBLISH_STEP_KEY,
    );
    const startedAt = this.#now().toISOString();
    this.#jobs.commitCheckpoint(job.id, {
      status: "publishing",
      checkpoint: {
        phase: "publish_action_started",
        platform: "xiaohongshu",
        actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        externalActionId: started.id,
        approvalRequestId: authorization.approvalId,
        contentFingerprint: authorization.contentFingerprint,
      },
      step: {
        id: this.#createId!("step"),
        stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
        status: "running",
        attempt,
        startedAt,
      },
    });

    let mutationStarted = false;

    try {
      await this.#publishPage({
        page: input.session.page,
        onMutationStarted: () => {
          mutationStarted = true;
        },
      });
    } catch (error) {
      if (!mutationStarted) {
        const failed = this.#externalActions.markFailed(started.id, {
          errorCode: "PUBLISH_PRECONDITION_FAILED",
          errorMessage:
            "The deterministic publish interaction could not start safely.",
        });
        this.#failJobIfPublishing(
          job.id,
          failed,
          "PUBLISH_PRECONDITION_FAILED",
          "The deterministic publish interaction could not start safely.",
        );
        throw new XiaohongshuPublishFailedError(
          "The deterministic Xiaohongshu publish interaction could not start safely.",
        );
      }

      this.#markUnknown(job.id, started, error);
      throw new XiaohongshuPublishUnknownError({ cause: error });
    }

    return this.#verifyAfterMutation(job.id, input.session, started);
  }

  async #verifyAfterMutation(
    jobId: string,
    session: BrowserSession,
    action: ExternalAction,
  ): Promise<XiaohongshuPublishResult> {
    try {
      const result = await this.#verifyResult({ page: session.page });
      if (result.kind === "published") {
        return this.#finalizePublished(jobId, action, result, false);
      }

      const failed = this.#externalActions.resolveAfterVerification(action.id, {
        status: "failed",
        errorCode: result.reasonCode,
        errorMessage:
          "Verification established that the publication did not occur.",
      });
      this.#failJobIfPublishing(
        jobId,
        failed,
        result.reasonCode,
        "Verification established that the publication did not occur.",
      );
      throw new XiaohongshuPublishFailedError();
    } catch (error) {
      if (error instanceof XiaohongshuPublishFailedError) {
        throw error;
      }

      const latest = this.#externalActions.getById(action.id);
      if (latest?.status === "succeeded") {
        throw new XiaohongshuPublishStateError(
          "Publication is verified as succeeded, but durable Job finalization did not complete. Resume will finalize without another publish interaction.",
        );
      }

      this.#markUnknown(jobId, latest ?? action, error);
      throw new XiaohongshuPublishUnknownError({ cause: error });
    }
  }

  async #verifyFirst(
    jobId: string,
    session: BrowserSession,
    action: ExternalAction,
  ): Promise<XiaohongshuPublishResult> {
    try {
      const result = await this.#verifyResult({ page: session.page });
      if (result.kind === "published") {
        return this.#finalizePublished(jobId, action, result, true);
      }

      const failed = this.#externalActions.resolveAfterVerification(action.id, {
        status: "failed",
        errorCode: result.reasonCode,
        errorMessage:
          "Verify-first recovery established that publication did not occur.",
      });
      this.#failJobIfPublishing(
        jobId,
        failed,
        result.reasonCode,
        "Verify-first recovery established that publication did not occur.",
      );
      throw new XiaohongshuPublishFailedError();
    } catch (error) {
      if (error instanceof XiaohongshuPublishFailedError) {
        throw error;
      }

      const latest = this.#externalActions.getById(action.id);
      if (latest?.status === "succeeded") {
        throw new XiaohongshuPublishStateError(
          "Publication is verified as succeeded, but durable Job finalization did not complete. Resume will finalize without another publish interaction.",
        );
      }

      const recoverable = latest ?? action;
      if (recoverable.status === "started") {
        this.#markUnknown(jobId, recoverable, error);
      } else {
        this.#recordUnknownCheckpoint(jobId, recoverable);
      }

      throw new XiaohongshuPublishUnknownError({ cause: error });
    }
  }

  #finalizePublished(
    jobId: string,
    action: ExternalAction,
    result: Extract<XiaohongshuPublishVerificationResult, { kind: "published" }>,
    verifyFirst: boolean,
  ): XiaohongshuPublishResult {
    const capturedAt = this.#now().toISOString();
    const inputs = evidenceInputForPublishedResult(
      jobId,
      action.id,
      result,
      capturedAt,
    );
    const existing = this.#evidence.getByJob(jobId);

    for (const input of inputs) {
      const found = existing.find((item) => item.id === input.id);
      if (found) {
        if (!sameEvidence(found, input)) {
          throw new XiaohongshuPublishStateError(
            "Persisted publication evidence does not match the verified result.",
          );
        }
        continue;
      }
      this.#evidence.append(input);
    }

    const settled =
      action.status === "started" || action.status === "unknown"
        ? this.#externalActions.resolveAfterVerification(action.id, {
            status: "succeeded",
            externalRef: result.contentId ?? result.confirmationRef,
          })
        : action;

    const job = this.#jobs.commitCheckpoint(jobId, {
      status: "succeeded",
      checkpoint: {
        phase: "publish_verified",
        platform: "xiaohongshu",
        actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        externalActionId: settled.id,
        resultReference: result.contentId ?? result.confirmationRef,
      },
      step: {
        id: this.#createId!("step"),
        stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
        status: "succeeded",
        attempt: nextAttempt(
          this.#jobs,
          jobId,
          XIAOHONGSHU_PUBLISH_STEP_KEY,
        ),
        outputJson: JSON.stringify({
          resultUrl: result.resultUrl,
          contentId: result.contentId,
          confirmationRef: result.confirmationRef,
          verifyFirst,
        }),
        finishedAt: capturedAt,
      },
    });

    return {
      job,
      action: settled,
      evidence: this.#evidence.getByJob(jobId),
      reused: false,
      verifyFirst,
    };
  }

  #finalizeExistingSucceededAction(
    jobId: string,
    action: ExternalAction,
  ): XiaohongshuPublishResult {
    const current = this.#jobs.getById(jobId);
    if (!current) throw new JobNotFoundError(jobId);

    if (current.status !== "succeeded") {
      const evidence = this.#evidence.getByJob(jobId);
      if (evidence.length === 0) {
        throw new XiaohongshuPublishStateError(
          "Succeeded publish action has no durable PublicationEvidence.",
        );
      }
      const job = this.#jobs.commitCheckpoint(jobId, {
        status: "succeeded",
        checkpoint: {
          phase: "publish_verified",
          platform: "xiaohongshu",
          actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
          externalActionId: action.id,
          resultReference: action.externalRef ?? "verified",
        },
        step: {
          id: this.#createId!("step"),
          stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
          status: "succeeded",
          attempt: nextAttempt(
            this.#jobs,
            jobId,
            XIAOHONGSHU_PUBLISH_STEP_KEY,
          ),
          outputJson: JSON.stringify({ reusedSucceededAction: true }),
          finishedAt: this.#now().toISOString(),
        },
      });
      return {
        job,
        action,
        evidence,
        reused: true,
        verifyFirst: true,
      };
    }

    return {
      job: current,
      action,
      evidence: this.#evidence.getByJob(jobId),
      reused: true,
      verifyFirst: false,
    };
  }

  #markUnknown(
    jobId: string,
    action: ExternalAction,
    error: unknown,
  ): void {
    if (action.status === "started") {
      this.#externalActions.markUnknown(action.id, {
        errorCode: "PUBLISH_RESULT_UNKNOWN",
        errorMessage:
          "The publish interaction may have occurred; deterministic verification is required.",
      });
    }
    this.#recordUnknownCheckpoint(jobId, action);
    void error;
  }

  #recordUnknownCheckpoint(jobId: string, action: ExternalAction): void {
    const job = this.#jobs.getById(jobId);
    if (!job || job.status !== "publishing") return;

    const approvalRequestId = job.checkpoint?.approvalRequestId;
    const contentFingerprint = job.checkpoint?.contentFingerprint;
    if (
      typeof approvalRequestId !== "string" ||
      approvalRequestId.length === 0 ||
      typeof contentFingerprint !== "string" ||
      contentFingerprint.length === 0
    ) {
      throw new XiaohongshuPublishStateError(
        "Cannot persist unknown publish state without its durable approval/content binding.",
      );
    }

    this.#jobs.commitCheckpoint(jobId, {
      status: "publishing",
      checkpoint: {
        phase: "publish_result_unknown",
        platform: "xiaohongshu",
        actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        externalActionId: action.id,
        approvalRequestId,
        contentFingerprint,
        verifyFirst: true,
      },
      step: {
        id: this.#createId!("step"),
        stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
        status: "failed",
        attempt: nextAttempt(
          this.#jobs,
          jobId,
          XIAOHONGSHU_PUBLISH_STEP_KEY,
        ),
        errorCode: "PUBLISH_RESULT_UNKNOWN",
        errorMessage:
          "Publication result is uncertain; resume must verify before any further mutation.",
        finishedAt: this.#now().toISOString(),
      },
    });
  }

  #failJobIfPublishing(
    jobId: string,
    action: ExternalAction,
    errorCode: string,
    errorMessage: string,
  ): void {
    const job = this.#jobs.getById(jobId);
    if (!job || job.status !== "publishing") return;

    this.#jobs.commitCheckpoint(jobId, {
      status: "failed",
      checkpoint: {
        phase: "publish_failed",
        platform: "xiaohongshu",
        actionKey: XIAOHONGSHU_FINAL_PUBLISH_ACTION_KEY,
        externalActionId: action.id,
      },
      step: {
        id: this.#createId!("step"),
        stepKey: XIAOHONGSHU_PUBLISH_STEP_KEY,
        status: "failed",
        attempt: nextAttempt(
          this.#jobs,
          jobId,
          XIAOHONGSHU_PUBLISH_STEP_KEY,
        ),
        errorCode,
        errorMessage,
        finishedAt: this.#now().toISOString(),
      },
    });
  }

  #requireSupportedJob(jobId: string): Job {
    const job = this.#jobs.getById(jobId);
    if (!job) throw new JobNotFoundError(jobId);

    if (job.platform !== "xiaohongshu" || job.publishMode !== "image_text") {
      throw new XiaohongshuPublishStateError(
        "PUB-02 supports Xiaohongshu image_text jobs only.",
      );
    }

    return job;
  }
}
