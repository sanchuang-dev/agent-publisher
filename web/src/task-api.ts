import {
  getLiveViewDescriptor,
  readLiveViewRuntimeConfig,
} from "./live-view-adapter.js";
import type {
  PublishMode,
  TaskAssignmentInput,
  TaskFixture,
  TaskRepository,
  TimelineStatus,
  Worker,
} from "./model.js";

export type ApiJobStatus =
  | "created"
  | "preparing_materials"
  | "preparing_publish"
  | "waiting_for_login"
  | "waiting_for_approval"
  | "publishing"
  | "succeeded"
  | "failed";

export interface ApiJobProjection {
  readonly id: string;
  readonly platform: "xiaohongshu";
  readonly publishMode: "image_text";
  readonly status: ApiJobStatus;
  readonly currentStep: string | null;
  readonly currentWorker: Worker;
  readonly phase: string;
  readonly needsHuman: boolean;
  readonly updatedAt: string;
  readonly material: {
    readonly source: "controlled_smoke" | "provider_pipeline";
    readonly generatedFromBrief: boolean;
    readonly title: string;
    readonly body: string;
    readonly tags: readonly string[];
    readonly imageCount: number;
  } | null;
  readonly timeline: readonly {
    readonly stepKey: string;
    readonly status: "pending" | "running" | "succeeded" | "failed" | "skipped";
    readonly attempt: number;
    readonly errorCode: string | null;
    readonly errorMessage: string | null;
  }[];
  readonly humanAction: {
    readonly id: string;
    readonly type: "login_required" | "approval_required" | "clarification_required";
    readonly reason: string | null;
    readonly instruction: string | null;
  } | null;
  readonly liveView: {
    readonly mode: "runtime" | "unavailable";
    readonly url: string | null;
    readonly controlOwner: "human";
  } | null;
  readonly approval: {
    readonly title: string;
    readonly bodyLength: number;
    readonly tags: readonly string[];
    readonly imageCount: number;
    readonly warningCodes: readonly string[];
  } | null;
  readonly evidence?: readonly {
    readonly kind:
      | "result_url"
      | "content_id"
      | "confirmation_ref"
      | "artifact_uri";
    readonly uri: string | null;
    readonly value: string | null;
    readonly createdAt: string;
  }[];
  readonly failure: {
    readonly step: string;
    readonly code: string | null;
    readonly message: string;
  } | null;
}

interface EventSourceLike {
  addEventListener(
    type: string,
    listener: (event: MessageEvent<string>) => void,
  ): void;
  close(): void;
}

export interface ApiTaskRepositoryOptions {
  readonly fetchImpl?: typeof fetch;
  readonly eventSourceFactory?: (url: string) => EventSourceLike;
  readonly storage?: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly apiBaseUrl?: string;
}

const RECENT_JOB_IDS_KEY = "agent-publisher:recent-job-ids";
const BRIEF_PREFIX = "agent-publisher:job-brief:";

const stepMeta: Readonly<
  Record<string, { readonly worker: Worker; readonly label: string; readonly detail: string }>
> = {
  material_pack: {
    worker: "content_secretary",
    label: "准备素材包",
    detail: "读取并验证可发布的图文 Material Pack",
  },
  material_handoff: {
    worker: "content_secretary",
    label: "交接发布",
    detail: "把已确认物料交给执行秘书",
  },
  acquire_browser: {
    worker: "publishing_secretary",
    label: "打开发布环境",
    detail: "连接受控浏览器会话",
  },
  ensure_login: {
    worker: "publishing_secretary",
    label: "检查登录状态",
    detail: "确认小红书账号会话可用",
  },
  verify_prepared: {
    worker: "publishing_secretary",
    label: "准备并校验表单",
    detail: "上传物料、填写表单并回读校验",
  },
};

function safeStorage(): Storage | null {
  try {
    return typeof window === "undefined" ? null : window.localStorage;
  } catch {
    return null;
  }
}

function fixtureState(status: ApiJobStatus): TaskFixture["state"] {
  switch (status) {
    case "created":
    case "preparing_materials":
      return "preparing_materials";
    case "preparing_publish":
      return "preparing_publish";
    case "waiting_for_login":
      return "waiting_for_login";
    case "waiting_for_approval":
      return "waiting_for_approval";
    case "succeeded":
      return "succeeded";
    case "publishing":
      return "preparing_publish";
    case "failed":
      return "failed";
  }
}

function statusLabel(status: ApiJobStatus): string {
  switch (status) {
    case "created":
      return "已创建";
    case "preparing_materials":
      return "内容制作中";
    case "preparing_publish":
      return "正在准备发布";
    case "waiting_for_login":
      return "等待登录";
    case "waiting_for_approval":
      return "等待批准";
    case "publishing":
      return "正在发布";
    case "succeeded":
      return "已完成";
    case "failed":
      return "失败";
  }
}

function currentStepLabel(job: ApiJobProjection): string {
  const meta = job.currentStep ? stepMeta[job.currentStep] : undefined;
  if (meta) return meta.label;

  if (job.status === "created") return "任务已创建，等待开始";
  if (job.status === "waiting_for_login") return "等待你完成扫码 / 2FA / 设备验证";
  if (job.status === "waiting_for_approval") return "发布表单已准备完成，等待最终签署";
  if (job.status === "publishing") return "正在执行批准后的单次发布 / 结果验证";
  if (job.status === "failed") return "任务在安全边界内停止";
  if (job.status === "succeeded") return "任务已完成";
  return job.phase || "正在处理";
}

function timelineStatus(
  status: ApiJobProjection["timeline"][number]["status"],
): TimelineStatus {
  switch (status) {
    case "succeeded":
    case "skipped":
      return "done";
    case "running":
      return "active";
    case "failed":
      return "error";
    case "pending":
      return "pending";
  }
}

function timelineWorker(stepKey: string, fallback: Worker): Worker {
  return (
    stepMeta[stepKey]?.worker ??
    (/material|plan|copy|image|design/i.test(stepKey)
      ? "content_secretary"
      : fallback)
  );
}

function warningLabel(code: string): string {
  const labels: Readonly<Record<string, string>> = {
    VIDEO_PROVIDER_UNAVAILABLE: "视频能力当前不可用",
    DESIGN_PROVIDER_UNAVAILABLE: "设计能力已按降级规则处理",
  };
  return labels[code] ?? code;
}

function boundedFailureMessage(code: string | null): string {
  const messages: Readonly<Record<string, string>> = {
    MATERIAL_SOURCE_UNAVAILABLE: "预发布物料当前不可用。",
    BROWSER_UNAVAILABLE: "受控浏览器当前不可用。",
    LOGIN_REQUIRED: "小红书登录或验证仍需要人工处理。",
    PLATFORM_UI_CHANGED: "平台页面与当前支持的确定性流程不一致。",
    BROWSER_INTERACTION_FAILED: "浏览器操作已安全停止。",
    PREPARE_RECOVERY_REQUIRED: "当前编辑器状态需要人工确认后才能继续。",
    PREPARED_VALIDATION_FAILED: "表单回读结果与准备内容不一致。",
    COMPOSER_NOT_FRESH: "当前编辑器已有内容，系统未自动覆盖。",
    PLATFORM_UPLOAD_FAILED: "平台报告素材上传失败。",
    PLATFORM_UPLOAD_TIMEOUT: "素材上传未在安全等待时间内完成。",
    ASSET_RESOLUTION_FAILED: "一个或多个受控素材当前无法读取。",
    PUBLISH_APPROVAL_REQUIRED: "尚未写入有效的最终发布批准。",
    PUBLISH_STATE_INVALID: "发布状态与持久化副作用记录不一致，需要检查。",
    PUBLISH_UI_CHANGED: "小红书最终发布控件与当前确定性流程不一致。",
    PUBLISH_FAILED: "小红书发布未被确认。",
    PUBLISH_RESULT_UNKNOWN: "发布结果不确定；必须先核验，系统不会自动再次发布。",
  };

  return code
    ? messages[code] ?? "任务已在安全边界内停止。"
    : "任务已在安全边界内停止。";
}

function stepLabel(stepKey: string): string {
  return stepMeta[stepKey]?.label ?? "执行步骤";
}

function fallbackBrief(job: ApiJobProjection): string {
  if (job.material?.title) return job.material.title;
  return "小红书图文任务 · " + job.id.slice(0, 8);
}

function mapJobProjection(
  job: ApiJobProjection,
  briefHint?: string,
): TaskFixture {
  const clarificationRequired =
    job.humanAction?.type === "clarification_required";
  const state =
    clarificationRequired || job.failure
      ? "failed"
      : job.status === "waiting_for_approval" && !job.needsHuman
        ? "preparing_publish"
        : fixtureState(job.status);
  const agentRuntime =
    state === "preparing_publish"
      ? getLiveViewDescriptor(
          "preparing_publish",
          readLiveViewRuntimeConfig(import.meta.env).liveViewUrl,
        )
      : undefined;
  const takeoverRuntime =
    state === "waiting_for_login"
      ? getLiveViewDescriptor(
          "waiting_for_login",
          job.liveView?.mode === "runtime" ? job.liveView.url ?? undefined : undefined,
        )
      : undefined;
  const liveView = takeoverRuntime ?? agentRuntime;

  const material = job.material
    ? {
        mode: "image_text" as const,
        title: job.material.title,
        body: job.material.body,
        tags: [...job.material.tags],
        media: Array.from({ length: job.material.imageCount }, (_, index) =>
          index === 0 ? "封面" : "图片 " + (index + 1),
        ),
      }
    : {
        mode: "image_text" as const,
        title: "物料尚未就绪",
        body: "真实任务已创建；物料准备完成后会在这里展示实际将用于预发布的内容。",
        tags: [],
        media: [],
      };

  const syntheticFailure =
    clarificationRequired
      ? {
          step: job.currentStep ? stepLabel(job.currentStep) : "人工确认",
          reason:
            job.humanAction?.reason === "prepare_recovery_required"
              ? "当前编辑器状态需要人工确认后才能继续。"
              : "任务需要你确认当前状态后才能继续。",
          recovery:
            job.humanAction?.instruction ??
            "请检查当前页面状态，并按提示确认后再继续。",
        }
      : job.status === "failed"
        ? {
            step: job.currentStep ? stepLabel(job.currentStep) : "当前步骤",
            reason: boundedFailureMessage(null),
            recovery: "请检查当前任务状态后再决定是否安全重试。",
          }
        : undefined;

  return {
    id: job.id,
    state,
    backendStatus: job.status,
    runtimeSource: "api",
    updatedAt: job.updatedAt,
    statusLabel: clarificationRequired ? "需要处理" : statusLabel(job.status),
    brief: briefHint?.trim() || fallbackBrief(job),
    platformLabel: "小红书",
    publishMode: "image_text",
    currentWorker: job.currentWorker,
    currentStep: clarificationRequired
      ? "等待你确认当前状态"
      : currentStepLabel(job),
    needsHuman: job.needsHuman,
    timeline: job.timeline.map((step, index) => {
      const meta = stepMeta[step.stepKey];
      return {
        id: step.stepKey + "-" + step.attempt + "-" + index,
        worker: timelineWorker(step.stepKey, job.currentWorker),
        label: meta?.label ?? "执行步骤",
        detail:
          step.status === "failed"
            ? boundedFailureMessage(step.errorCode)
            : meta?.detail ?? "Publisher 已提交该步骤状态。",
        status: timelineStatus(step.status),
      };
    }),
    material,
    ...(job.material
      ? {
          materialProvenance: {
            source: job.material.source,
            generatedFromBrief: job.material.generatedFromBrief,
          },
        }
      : {}),
    ...(liveView
      ? {
          browserLiveViewUrl: liveView.url,
          browserLiveViewMode: liveView.mode,
          controlOwner: liveView.controlOwner,
        }
      : {}),
    ...(job.approval
      ? {
          approval: {
            actionId: job.humanAction?.id ?? "",
            accountName: "当前登录会话",
            copySummary:
              "正文 " + job.approval.bodyLength + " 字 · 已由执行秘书回读校验",
            mediaSummary: job.approval.imageCount + " 张图片 · 已就绪",
            warnings: [
              ...job.approval.warningCodes.map(warningLabel),
              "批准后将执行一次不可逆发布；结果不确定时只核验，不会自动再次发布。",
            ],
          },
        }
      : {}),
    ...((job.evidence ?? []).length > 0
      ? {
          evidence: (job.evidence ?? []).map((item) => ({
            label:
              item.kind === "result_url"
                ? "结果地址"
                : item.kind === "content_id"
                  ? "内容 ID"
                  : item.kind === "artifact_uri"
                    ? "页面证据"
                    : "平台确认",
            value: item.uri ?? item.value ?? item.createdAt,
          })),
        }
      : {}),
    ...(job.failure
      ? {
          failure: {
            step: stepLabel(job.failure.step),
            reason: boundedFailureMessage(job.failure.code),
            recovery:
              job.humanAction?.instruction ??
              job.humanAction?.reason ??
              "保留已提交状态，可检查当前任务后安全重试。",
          },
        }
      : syntheticFailure
        ? { failure: syntheticFailure }
        : {}),
  };
}

export class ApiTaskError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "ApiTaskError";
  }
}

export function shouldAutoContinueTask(task: TaskFixture): boolean {
  const status = task.backendStatus;

  if (task.failure) {
    return false;
  }

  if (status === "waiting_for_login") {
    return task.needsHuman;
  }

  if (task.needsHuman) {
    return false;
  }

  return (
    status === "created" ||
    status === "preparing_materials" ||
    status === "preparing_publish" ||
    status === "publishing"
  );
}

export class ApiTaskRepository implements TaskRepository {
  readonly #fetch: typeof fetch;
  readonly #eventSourceFactory: (url: string) => EventSourceLike;
  readonly #storage: Pick<Storage, "getItem" | "setItem" | "removeItem"> | null;
  readonly #apiBaseUrl: string;
  readonly #briefs = new Map<string, string>();

  constructor(options: ApiTaskRepositoryOptions = {}) {
    this.#fetch = options.fetchImpl ?? fetch.bind(globalThis);
    this.#eventSourceFactory =
      options.eventSourceFactory ??
      ((url) => new EventSource(url) as unknown as EventSourceLike);
    this.#storage = options.storage === undefined ? safeStorage() : options.storage;
    this.#apiBaseUrl = (options.apiBaseUrl ?? "/api").replace(/\/$/, "");
  }

  async list(): Promise<TaskFixture[]> {
    const ids = this.#recentJobIds();
    const tasks = await Promise.all(
      ids.map(async (id) => {
        try {
          return await this.get(id);
        } catch (error) {
          if (error instanceof ApiTaskError && error.status === 404) return null;
          throw error;
        }
      }),
    );
    return tasks.filter((task): task is TaskFixture => task !== null);
  }

  async get(jobId: string): Promise<TaskFixture> {
    const payload = await this.#request<{ job: ApiJobProjection }>(
      "/jobs/" + encodeURIComponent(jobId),
    );
    return mapJobProjection(payload.job, this.#brief(jobId));
  }

  async assign(input: TaskAssignmentInput): Promise<TaskFixture> {
    if (input.publishMode !== "image_text") {
      throw new ApiTaskError(400, "当前 MVP 只支持小红书图文任务。");
    }

    const payload = await this.#request<{ job: ApiJobProjection }>("/jobs", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        brief: input.brief,
        platform: "xiaohongshu",
        publishMode: "image_text",
      }),
    });

    this.#remember(payload.job.id, input.brief);
    return mapJobProjection(payload.job, input.brief);
  }

  async continue(jobId: string): Promise<TaskFixture> {
    const payload = await this.#request<{
      job: ApiJobProjection;
      run: { blocked: boolean; error: { code: string; message: string } | null };
    }>("/jobs/" + encodeURIComponent(jobId) + "/continue", {
      method: "POST",
    });
    return mapJobProjection(payload.job, this.#brief(jobId));
  }


  async approve(jobId: string, actionId: string): Promise<TaskFixture> {
    if (!actionId) {
      throw new ApiTaskError(409, "当前任务缺少可用的发布审批记录。");
    }

    const payload = await this.#request<{ job: ApiJobProjection }>(
      "/actions/" + encodeURIComponent(actionId) + "/resolve",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ approved: true }),
      },
    );

    return mapJobProjection(payload.job, this.#brief(jobId));
  }

  subscribe(jobId: string, listener: (task: TaskFixture) => void): () => void {
    const source = this.#eventSourceFactory(
      this.#apiBaseUrl + "/jobs/" + encodeURIComponent(jobId) + "/events",
    );
    source.addEventListener("job", (event) => {
      try {
        const payload = JSON.parse(event.data) as { job?: ApiJobProjection };
        if (payload.job?.id === jobId) {
          listener(mapJobProjection(payload.job, this.#brief(jobId)));
        }
      } catch {
        // Ignore malformed observational events; GET/continue remain authoritative.
      }
    });
    return () => source.close();
  }

  async #request<T>(path: string, init?: RequestInit): Promise<T> {
    const response = await this.#fetch(this.#apiBaseUrl + path, init);
    if (!response.ok) {
      let message = "Agent Publisher API 请求失败。";
      try {
        const body = (await response.json()) as { error?: { message?: unknown } };
        if (typeof body.error?.message === "string") message = body.error.message;
      } catch {
        // Keep the bounded product-level fallback.
      }
      throw new ApiTaskError(response.status, message);
    }
    return (await response.json()) as T;
  }

  #remember(jobId: string, brief: string): void {
    // The Job already exists durably when this runs. Browser storage is only a
    // navigation hint and must never turn a committed create into an apparent
    // failure that encourages the user to create a duplicate Job.
    this.#briefs.set(jobId, brief);

    try {
      this.#storage?.setItem(BRIEF_PREFIX + jobId, brief);
      const ids = [
        jobId,
        ...this.#recentJobIds().filter((id) => id !== jobId),
      ].slice(0, 12);
      this.#storage?.setItem(RECENT_JOB_IDS_KEY, JSON.stringify(ids));
    } catch {
      // Best-effort only. The in-memory brief still keeps this tab coherent,
      // while durable workflow truth remains in APP-02.
    }
  }

  #brief(jobId: string): string | undefined {
    const inMemory = this.#briefs.get(jobId);
    if (inMemory !== undefined) return inMemory;

    try {
      return this.#storage?.getItem(BRIEF_PREFIX + jobId) ?? undefined;
    } catch {
      return undefined;
    }
  }

  #recentJobIds(): string[] {
    let raw: string | null | undefined;
    try {
      raw = this.#storage?.getItem(RECENT_JOB_IDS_KEY);
    } catch {
      return [];
    }

    if (!raw) return [];
    try {
      const value = JSON.parse(raw) as unknown;
      return Array.isArray(value) && value.every((item) => typeof item === "string")
        ? value.slice(0, 12)
        : [];
    } catch {
      return [];
    }
  }
}

export const taskRepository = new ApiTaskRepository();
