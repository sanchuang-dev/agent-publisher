import {
  JobNotFoundError,
  type ActionRequest,
  type ActionRequestRepository,
  type Job,
  type JobRepository,
  type JobStatus,
  type JobStep,
  type JsonValue,
} from "../contracts/job.js";
import {
  findPersistedPrepublishMaterial,
  type PrepublishMaterialSourceKind,
} from "./prepublish-material-source.js";

export type ProductWorker = "content_secretary" | "publishing_secretary";

export interface JobTimelineProjection {
  readonly stepKey: string;
  readonly status: JobStep["status"];
  readonly attempt: number;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface JobHumanActionProjection {
  readonly id: string;
  readonly type: ActionRequest["type"];
  readonly reason: string | null;
  readonly instruction: string | null;
}

export interface JobApprovalProjection {
  readonly title: string;
  readonly bodyLength: number;
  readonly tags: readonly string[];
  readonly imageCount: number;
  readonly warningCodes: readonly string[];
}

export interface JobMaterialProjection {
  readonly source: PrepublishMaterialSourceKind;
  readonly generatedFromBrief: boolean;
  readonly title: string;
  readonly body: string;
  readonly tags: readonly string[];
  readonly imageCount: number;
}

export interface JobProjection {
  readonly id: string;
  readonly platform: "xiaohongshu";
  readonly publishMode: "image_text";
  readonly status: JobStatus;
  readonly currentStep: string | null;
  readonly currentWorker: ProductWorker;
  readonly phase: string;
  readonly needsHuman: boolean;
  readonly updatedAt: string;
  readonly material: JobMaterialProjection | null;
  readonly timeline: readonly JobTimelineProjection[];
  readonly humanAction: JobHumanActionProjection | null;
  readonly liveView: {
    readonly mode: "runtime" | "unavailable";
    readonly url: string | null;
    readonly controlOwner: "agent" | "human";
  } | null;
  readonly approval: JobApprovalProjection | null;
  readonly failure: {
    readonly step: string;
    readonly code: string | null;
    readonly message: string;
  } | null;
}

export interface JobProjectionServiceOptions {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly browserLiveViewUrl?: string;
}

const SENSITIVE_LIVE_VIEW_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "password",
  "passwd",
  "secret",
  "auth",
  "authorization",
  "api_key",
  "apikey",
]);

function safeLiveViewUrl(rawUrl: string | undefined): string | undefined {
  const candidate = rawUrl?.trim();
  if (!candidate || /[\\\u0000-\u001f\u007f]/.test(candidate)) {
    return undefined;
  }

  try {
    const isRelative = candidate.startsWith("/") && !candidate.startsWith("//");
    const url = isRelative
      ? new URL(candidate, "http://live-view.invalid")
      : new URL(candidate);

    const hashParams = new URLSearchParams(
      url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
    );
    if (
      [...url.searchParams.keys(), ...hashParams.keys()].some((key) =>
        SENSITIVE_LIVE_VIEW_QUERY_KEYS.has(key.toLowerCase()),
      )
    ) {
      return undefined;
    }

    if (/^\/(?:json|devtools)(?:\/|$)/i.test(url.pathname)) {
      return undefined;
    }

    if (isRelative) {
      return candidate;
    }

    if (
      url.username ||
      url.password ||
      url.protocol !== "http:" ||
      url.port !== "6080" ||
      !["localhost", "127.0.0.1", "[::1]", "::1"].includes(url.hostname)
    ) {
      return undefined;
    }

    return candidate;
  } catch {
    return undefined;
  }
}

function asObject(
  value: JsonValue | null,
): Readonly<Record<string, JsonValue>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }

  return value as Readonly<Record<string, JsonValue>>;
}

function stringValue(
  object: Readonly<Record<string, JsonValue>> | null,
  key: string,
): string | null {
  const value = object?.[key];
  return typeof value === "string" ? value : null;
}

function numberValue(
  object: Readonly<Record<string, JsonValue>> | null,
  key: string,
): number | null {
  const value = object?.[key];
  return typeof value === "number" ? value : null;
}

function stringArrayValue(
  object: Readonly<Record<string, JsonValue>> | null,
  key: string,
): readonly string[] {
  const value = object?.[key];
  return Array.isArray(value) && value.every((item) => typeof item === "string")
    ? value
    : [];
}

function workerForStatus(status: JobStatus): ProductWorker {
  return status === "created" || status === "preparing_materials"
    ? "content_secretary"
    : "publishing_secretary";
}

function phaseForJob(job: Job): string {
  const phase = job.checkpoint?.phase;
  return typeof phase === "string" && phase.length > 0 ? phase : job.status;
}

function projectHumanAction(
  action: ActionRequest | null,
): JobHumanActionProjection | null {
  if (!action || action.status !== "open") {
    return null;
  }

  const payload = asObject(action.payload);

  return {
    id: action.id,
    type: action.type,
    reason: stringValue(payload, "reason"),
    instruction:
      stringValue(payload, "instruction") ?? stringValue(payload, "guidance"),
  };
}

function projectApproval(
  action: ActionRequest | null,
): JobApprovalProjection | null {
  if (
    !action ||
    action.type !== "approval_required" ||
    action.status !== "open"
  ) {
    return null;
  }

  const payload = asObject(action.payload);
  const title = stringValue(payload, "title");
  const bodyLength = numberValue(payload, "bodyLength");
  const imageCount = numberValue(payload, "imageCount");

  if (title === null || bodyLength === null || imageCount === null) {
    return null;
  }

  return {
    title,
    bodyLength,
    tags: stringArrayValue(payload, "tags"),
    imageCount,
    warningCodes: stringArrayValue(payload, "warningCodes"),
  };
}

function projectFailure(
  job: Job,
  steps: readonly JobStep[],
): JobProjection["failure"] {
  if (!job.currentStep) {
    return null;
  }

  const latestCurrentStep = [...steps]
    .reverse()
    .find((step) => step.stepKey === job.currentStep);

  if (!latestCurrentStep || latestCurrentStep.status !== "failed") {
    return null;
  }

  return {
    step: latestCurrentStep.stepKey,
    code: latestCurrentStep.errorCode,
    message:
      latestCurrentStep.errorMessage ??
      "The pre-publish flow stopped safely and can be inspected or retried.",
  };
}

function projectMaterial(steps: readonly JobStep[]): JobMaterialProjection | null {
  const persisted = findPersistedPrepublishMaterial(steps);
  if (!persisted) {
    return null;
  }

  const imageCount = new Set([
    persisted.pack.cover.assetId,
    ...persisted.pack.images.map((asset) => asset.assetId),
  ]).size;

  return {
    source: persisted.source,
    generatedFromBrief: persisted.generatedFromBrief,
    title: persisted.pack.copy.title,
    body: persisted.pack.copy.body,
    tags: persisted.pack.copy.tags,
    imageCount,
  };
}

export class JobProjectionService {
  readonly #jobs: JobRepository;
  readonly #actionRequests: ActionRequestRepository;
  readonly #browserLiveViewUrl: string | undefined;

  constructor(options: JobProjectionServiceOptions) {
    this.#jobs = options.jobs;
    this.#actionRequests = options.actionRequests;
    this.#browserLiveViewUrl = safeLiveViewUrl(options.browserLiveViewUrl);
  }

  get(jobId: string): JobProjection {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }

    if (job.platform !== "xiaohongshu" || job.publishMode !== "image_text") {
      throw new Error(
        `APP-02 projection only supports Xiaohongshu image_text jobs; found ${job.platform}/${job.publishMode}`,
      );
    }

    const steps = this.#jobs.getStepsForJob(job.id);
    const action = this.#actionRequests.getCurrentOpenForJob(job.id);
    const waitingForLogin =
      job.status === "waiting_for_login" &&
      action?.type === "login_required" &&
      action.status === "open";
    const agentPreparingPublish = job.status === "preparing_publish";
    const liveViewOwner = waitingForLogin ? "human" : "agent";

    return {
      id: job.id,
      platform: "xiaohongshu",
      publishMode: "image_text",
      status: job.status,
      currentStep: job.currentStep,
      currentWorker: workerForStatus(job.status),
      phase: phaseForJob(job),
      needsHuman: action !== null,
      updatedAt: job.updatedAt,
      material: projectMaterial(steps),
      timeline: steps.map((step) => ({
        stepKey: step.stepKey,
        status: step.status,
        attempt: step.attempt,
        errorCode: step.errorCode,
        errorMessage: step.errorMessage,
      })),
      humanAction: projectHumanAction(action),
      liveView: waitingForLogin || agentPreparingPublish
        ? {
            mode: this.#browserLiveViewUrl ? "runtime" : "unavailable",
            url: this.#browserLiveViewUrl ?? null,
            controlOwner: liveViewOwner,
          }
        : null,
      approval: projectApproval(action),
      failure: projectFailure(job, steps),
    };
  }
}
