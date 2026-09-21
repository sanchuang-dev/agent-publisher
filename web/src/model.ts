import {
  getLiveViewDescriptor,
  readLiveViewRuntimeConfig,
  type ControlOwner,
  type LiveViewMode,
  type LiveViewRuntimeConfig,
} from "./live-view-adapter.js";

export const fixtureStates = [
  "preparing_materials",
  "preparing_publish",
  "waiting_for_login",
  "waiting_for_approval",
  "succeeded",
  "failed",
] as const;

export type FixtureState = (typeof fixtureStates)[number];
export type PublishMode = "image_text" | "video";

export interface TaskAssignmentInput {
  brief: string;
  publishMode: PublishMode;
}

export type Worker = "content_secretary" | "publishing_secretary";
export type TimelineStatus = "done" | "active" | "pending" | "error";

export interface TimelineStep {
  id: string;
  worker: Worker;
  label: string;
  detail: string;
  status: TimelineStatus;
  time?: string;
}

export interface TaskFixture {
  id: string;
  state: FixtureState;
  backendStatus?: string;
  runtimeSource?: "fixture" | "api";
  updatedAt?: string;
  statusLabel: string;
  brief: string;
  platformLabel: "小红书";
  publishMode: PublishMode;
  currentWorker: Worker;
  currentStep: string;
  needsHuman: boolean;
  timeline: TimelineStep[];
  material: {
    mode: PublishMode;
    title: string;
    body: string;
    tags: string[];
    media: string[];
  };
  materialProvenance?: {
    source: "controlled_smoke" | "provider_pipeline";
    generatedFromBrief: boolean;
  };
  browserLiveViewUrl?: string;
  browserLiveViewMode?: LiveViewMode;
  controlOwner?: ControlOwner;
  approval?: {
    actionId: string;
    accountName: string;
    copySummary: string;
    mediaSummary: string;
    warnings: string[];
  };
  evidence?: Array<{ label: string; value: string }>;
  failure?: { code?: string; step: string; reason: string; recovery: string };
}

export type WorkSurfaceKind =
  | "material"
  | "browser"
  | "takeover"
  | "approval"
  | "evidence"
  | "failure";

export function getWorkSurfaceKind(state: FixtureState): WorkSurfaceKind {
  switch (state) {
    case "preparing_materials":
      return "material";
    case "preparing_publish":
      return "browser";
    case "waiting_for_login":
      return "takeover";
    case "waiting_for_approval":
      return "approval";
    case "succeeded":
      return "evidence";
    case "failed":
      return "failure";
  }
}

const stepDefs = [
  ["brief", "content_secretary", "理解任务", "读取 brief、目标平台与内容形式"],
  ["copy", "content_secretary", "准备文案", "生成标题、正文与标签"],
  ["media", "content_secretary", "准备物料", "整理封面与媒体序列"],
  ["handoff", "content_secretary", "交接发布", "将 Material Pack 交给执行秘书"],
  ["browser", "publishing_secretary", "打开发布环境", "准备受控浏览器会话"],
  ["login", "publishing_secretary", "检查登录状态", "确认账号会话可用"],
  ["form", "publishing_secretary", "填写发布表单", "上传物料并回读表单内容"],
  ["approval", "publishing_secretary", "等待发布批准", "提交最终摘要供人工签署"],
  ["publish", "publishing_secretary", "发布并取证", "执行批准后的发布并收集证据"],
] as const;

type StepKey = (typeof stepDefs)[number][0];

const progress: Record<
  FixtureState,
  { done: StepKey; active: StepKey; error?: StepKey }
> = {
  preparing_materials: { done: "copy", active: "media" },
  preparing_publish: { done: "handoff", active: "browser" },
  waiting_for_login: { done: "browser", active: "login" },
  waiting_for_approval: { done: "form", active: "approval" },
  succeeded: { done: "publish", active: "publish" },
  failed: { done: "login", active: "form", error: "form" },
};

const meta: Record<
  FixtureState,
  Pick<
    TaskFixture,
    "statusLabel" | "currentWorker" | "currentStep" | "needsHuman"
  >
> = {
  preparing_materials: {
    statusLabel: "内容制作中",
    currentWorker: "content_secretary",
    currentStep: "正在整理封面与媒体序列",
    needsHuman: false,
  },
  preparing_publish: {
    statusLabel: "正在准备发布",
    currentWorker: "publishing_secretary",
    currentStep: "正在打开受控浏览器",
    needsHuman: false,
  },
  waiting_for_login: {
    statusLabel: "等待登录",
    currentWorker: "publishing_secretary",
    currentStep: "等待你完成扫码 / 2FA / 设备验证",
    needsHuman: true,
  },
  waiting_for_approval: {
    statusLabel: "等待批准",
    currentWorker: "publishing_secretary",
    currentStep: "发布表单已准备完成，等待最终签署",
    needsHuman: true,
  },
  succeeded: {
    statusLabel: "已完成",
    currentWorker: "publishing_secretary",
    currentStep: "发布成功，证据已收集",
    needsHuman: false,
  },
  failed: {
    statusLabel: "失败",
    currentWorker: "publishing_secretary",
    currentStep: "上传媒体时停止",
    needsHuman: true,
  },
};

function timeline(state: FixtureState): TimelineStep[] {
  const stateProgress = progress[state];
  const doneIndex = stepDefs.findIndex(([key]) => key === stateProgress.done);

  return stepDefs.map(([id, worker, label, detail], index) => {
    let status: TimelineStatus = index <= doneIndex ? "done" : "pending";
    if (id === stateProgress.active && state !== "succeeded") status = "active";
    if (id === stateProgress.error) status = "error";

    return {
      id,
      worker,
      label,
      detail,
      status,
      ...(status === "done"
        ? { time: `18:${String(3 + index * 2).padStart(2, "0")}` }
        : {}),
    };
  });
}

const materialBase = {
  title: "把发布工作交给 AI 员工，而不是再开一个聊天窗口",
  body: "Agent Publisher 将内容准备、浏览器执行、人工接管与发布审批串成一条可监督的工作流。你只需要交代任务，在身份验证或最终发布前介入。",
  tags: ["AI员工", "内容运营", "小红书", "Agent"],
};

function createMaterial(publishMode: PublishMode): TaskFixture["material"] {
  return {
    mode: publishMode,
    ...materialBase,
    media:
      publishMode === "video"
        ? ["视频成片", "视频封面"]
        : ["封面", "产品概览", "执行时间线", "人工审批"],
  };
}

export function getTaskFixture(
  state: FixtureState,
  assignment?: TaskAssignmentInput,
  runtimeConfig: LiveViewRuntimeConfig = {},
): TaskFixture {
  const stateMeta = meta[state];
  const publishMode = assignment?.publishMode ?? "image_text";
  const material = createMaterial(publishMode);
  const liveView =
    state === "preparing_publish" || state === "waiting_for_login"
      ? getLiveViewDescriptor(state, runtimeConfig.liveViewUrl)
      : undefined;

  return {
    id: `demo-${state}`,
    state,
    statusLabel: stateMeta.statusLabel,
    brief:
      assignment?.brief ??
      "给公司 Agent Publisher 做一篇小红书介绍。强调它像一名可监督的 AI 员工，图文简洁，最终发布前必须人工批准。",
    platformLabel: "小红书",
    publishMode,
    currentWorker: stateMeta.currentWorker,
    currentStep: stateMeta.currentStep,
    needsHuman: stateMeta.needsHuman,
    timeline: timeline(state),
    material,
    ...(liveView
      ? {
          browserLiveViewUrl: liveView.url,
          browserLiveViewMode: liveView.mode,
          controlOwner: liveView.controlOwner,
        }
      : {}),
    ...(state === "waiting_for_approval"
      ? {
          approval: {
            actionId: "fixture-approval",
            accountName: "公司小红书",
            copySummary: "介绍委派、监督、人工接管与发布审批体验。",
            mediaSummary:
              publishMode === "video"
                ? "1 条视频 · 视频封面已就绪"
                : "4 张图片 · 封面已就绪",
            warnings: [
              "发布后将产生外部不可逆副作用",
              "当前为 fixture，不会触发真实发布",
            ],
          },
        }
      : {}),
    ...(state === "succeeded"
      ? {
          evidence: [
            { label: "平台确认", value: "发布成功" },
            {
              label: "结果地址",
              value: "https://example.invalid/xhs/demo-post",
            },
            { label: "完成时间", value: "2026-09-18 18:15" },
            {
              label: "页面证据",
              value: "evidence/demo-publish-success.png",
            },
          ],
        }
      : {}),
    ...(state === "failed"
      ? {
          failure: {
            step: "上传媒体",
            reason: "平台上传控件未在安全等待窗口内完成处理。",
            recovery:
              "保留已完成文案与素材，可从上传步骤重试；不会自动重复发布。",
          },
        }
      : {}),
  };
}

export interface TaskRepository {
  list(): Promise<TaskFixture[]>;
  get(id: string): Promise<TaskFixture>;
  assign(input: TaskAssignmentInput): Promise<TaskFixture>;
  continue(id: string): Promise<TaskFixture>;
  approve(id: string, actionId: string): Promise<TaskFixture>;
  subscribe(id: string, listener: (task: TaskFixture) => void): () => void;
}

export class FixtureTaskRepository implements TaskRepository {
  private assignedTask: TaskFixture | undefined;

  private runtimeConfig(): LiveViewRuntimeConfig {
    return readLiveViewRuntimeConfig(import.meta.env);
  }

  async list(): Promise<TaskFixture[]> {
    return fixtureStates.map((state) =>
      state === "preparing_materials" && this.assignedTask
        ? this.assignedTask
        : getTaskFixture(state, undefined, this.runtimeConfig()),
    );
  }

  async get(id: string): Promise<TaskFixture> {
    if (!isFixtureState(id)) {
      throw new Error("Unknown fixture state: " + id);
    }

    if (id === "preparing_materials" && this.assignedTask) {
      return this.assignedTask;
    }

    return getTaskFixture(id, undefined, this.runtimeConfig());
  }

  async assign(input: TaskAssignmentInput): Promise<TaskFixture> {
    this.assignedTask = getTaskFixture(
      "preparing_materials",
      input,
      this.runtimeConfig(),
    );
    return this.assignedTask;
  }

  async continue(id: string): Promise<TaskFixture> {
    return this.get(id);
  }

  async approve(id: string): Promise<TaskFixture> {
    return this.get(id);
  }

  subscribe(): () => void {
    return () => undefined;
  }
}

export const fixtureTaskRepository: TaskRepository = new FixtureTaskRepository();

export function isFixtureState(value: string): value is FixtureState {
  return fixtureStates.includes(value as FixtureState);
}
