import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";

import {
  fixtureTaskRepository,
  getWorkSurfaceKind,
  isFixtureState,
  type FixtureState,
  type PublishMode,
  type TaskFixture,
  type TimelineStep,
  type Worker,
} from "./model";
import { shouldAutoContinueTask, taskRepository } from "./task-api";

type Route =
  | { page: "home" }
  | { page: "task"; jobId: string }
  | { page: "fixture"; state: FixtureState };

function readRoute(): Route {
  const fixtureState = window.location.hash.match(/^#\/fixture\/([^/?#]+)/)?.[1];
  if (fixtureState && isFixtureState(fixtureState)) {
    return { page: "fixture", state: fixtureState };
  }

  const jobId = window.location.hash.match(/^#\/task\/([^/?#]+)/)?.[1];
  if (jobId) {
    return { page: "task", jobId: decodeURIComponent(jobId) };
  }

  return { page: "home" };
}

export function App() {
  const [route, setRoute] = useState(readRoute);

  useEffect(() => {
    const onHashChange = () => setRoute(readRoute());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  return (
    <div className="app-shell">
      <header className="app-header">
        <div className="header-inner">
          <a className="brand" href="#/">
            <span className="brand-mark">AP</span>
            <span className="brand-text">
              <strong className="brand-name">Agent Publisher</strong>
              <small className="brand-sub">AI publishing employees</small>
            </span>
          </a>
          <span className="header-spacer" />
          <div className="header-user" aria-label="当前操作员">
            <span>工作台</span>
            <span className="user-av">你</span>
          </div>
        </div>
      </header>
      {route.page === "home" ? (
        <TaskHome />
      ) : route.page === "fixture" ? (
        <TaskDetail taskId={route.state} fixtureState={route.state} />
      ) : (
        <TaskDetail taskId={route.jobId} />
      )}
    </div>
  );
}

function TaskHome() {
  const [tasks, setTasks] = useState<TaskFixture[]>([]);
  const [publishMode, setPublishMode] = useState<PublishMode>("image_text");
  const [brief, setBrief] = useState(
    "给公司 Agent Publisher 做一篇小红书介绍",
  );
  const [assigning, setAssigning] = useState(false);
  const [assignError, setAssignError] = useState<string | null>(null);

  useEffect(() => {
    void taskRepository
      .list()
      .then(setTasks)
      .catch(() => setTasks([]));
  }, []);

  const groups = [
    ["等我处理", ["waiting_for_login", "waiting_for_approval", "failed"]],
    ["正在执行", ["preparing_materials", "preparing_publish"]],
    ["已完成", ["succeeded"]],
  ] as const;

  return (
    <main className="home-shell">
      <section className="home-intro">
        <h1 className="page-title">任务</h1>
        <p className="page-sub">
          把发布工作交给两位秘书。你只需要在身份验证或最终发布前介入。
        </p>
      </section>

      <section className="assign-panel surface-card">
        <label className="composer-label" htmlFor="brief">
          交代一个任务
        </label>
        <textarea
          id="brief"
          value={brief}
          onChange={(event) => setBrief(event.target.value)}
          rows={2}
          placeholder="例如：给公司这个产品做一篇小红书介绍"
        />
        <div className="assign-row">
          <div className="field-group">
            <span className="group-label">目标平台</span>
            <span className="platform-choice">小红书</span>
          </div>
          <span className="bar-divider" aria-hidden="true" />
          <div className="field-group">
            <span className="group-label">发布形式</span>
            <div className="segmented" aria-label="内容形式">
              <button
                className={publishMode === "image_text" ? "selected" : ""}
                onClick={() => setPublishMode("image_text")}
              >
                图文
              </button>
              <button
                className={publishMode === "video" ? "selected" : ""}
                disabled
                title="当前 MVP 真实链路仅支持小红书图文"
              >
                视频
              </button>
            </div>
          </div>
          <span className="assign-spacer" />
          <button
            className="primary-button"
            disabled={!brief.trim() || assigning || publishMode !== "image_text"}
            onClick={() => {
              setAssigning(true);
              setAssignError(null);
              void taskRepository
                .assign({
                  brief: brief.trim(),
                  publishMode,
                })
                .then((task) => {
                  window.location.hash = "#/task/" + encodeURIComponent(task.id);
                })
                .catch((error: unknown) => {
                  setAssignError(
                    error instanceof Error
                      ? error.message
                      : "创建真实发布任务失败，请检查 APP-02 API runtime。",
                  );
                })
                .finally(() => setAssigning(false));
            }}
          >
            {assigning ? "正在创建任务…" : "交给内容秘书"}
          </button>
        </div>
        {assignError && (
          <p className="assignment-error" role="alert">
            {assignError}
          </p>
        )}
      </section>

      <section className="task-groups" aria-label="任务列表">
        {groups.map(([title, states]) => {
          const items = tasks.filter((task) =>
            (states as readonly string[]).includes(task.state),
          );

          return (
            <div className="task-group" key={title}>
              <div className="section-heading">
                <h2>{title}</h2>
                <span>{items.length}</span>
              </div>
              <div className="task-grid">
                {items.map((task) => (
                  <a
                    className="task-card surface-card"
                    href={`#/task/${encodeURIComponent(task.id)}`}
                    key={task.id}
                  >
                    <div className="task-card-topline">
                      <span
                        className={`status-dot status-${task.state}`}
                        aria-hidden="true"
                      />
                      <span>{task.statusLabel}</span>
                      {task.needsHuman && <strong>需要你</strong>}
                    </div>
                    <h3>{task.brief}</h3>
                    <div className="task-meta">
                      <span>{task.platformLabel}</span>
                      <span>
                        {task.publishMode === "image_text" ? "图文" : "视频"}
                      </span>
                    </div>
                    <p>{task.currentStep}</p>
                  </a>
                ))}
              </div>
            </div>
          );
        })}
      </section>
    </main>
  );
}

function TaskDetail({
  taskId,
  fixtureState,
}: {
  taskId: string;
  fixtureState?: FixtureState;
}) {
  const [task, setTask] = useState<TaskFixture | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let unsubscribe: () => void = () => undefined;
    const repository = fixtureState ? fixtureTaskRepository : taskRepository;
    const key = fixtureState ?? taskId;

    const scheduleContinue = (current: TaskFixture) => {
      if (fixtureState || cancelled) return;

      if (!shouldAutoContinueTask(current)) {
        return;
      }

      const status = current.backendStatus;
      const delay =
        status === "waiting_for_login" ||
        status === "waiting_for_approval" ||
        status === "publishing"
          ? 2500
          : 120;
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void taskRepository
          .continue(taskId)
          .then((next) => {
            if (cancelled) return;
            setTask(next);
            setLoadError(null);
            scheduleContinue(next);
          })
          .catch((error: unknown) => {
            if (cancelled) return;
            setLoadError(
              error instanceof Error
                ? error.message
                : "继续任务失败，请检查 APP-02 runtime。",
            );
          });
      }, delay);
    };

    void repository
      .get(key)
      .then((loaded) => {
        if (cancelled) return;
        setTask(loaded);
        setLoadError(null);

        if (!fixtureState) {
          unsubscribe = taskRepository.subscribe(taskId, (next) => {
            if (!cancelled) {
              setTask(next);
              setLoadError(null);
              scheduleContinue(next);
            }
          });
          scheduleContinue(loaded);
        }
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setLoadError(
            error instanceof Error
              ? error.message
              : "加载真实发布任务失败。",
          );
        }
      });

    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
      unsubscribe();
    };
  }, [fixtureState, taskId]);

  if (!task) {
    return (
      <main className="loading-shell">
        {loadError ?? "正在加载任务…"}
      </main>
    );
  }

  return (
    <main className="detail-page">
      <a className="back-link" href="#/">
        ← 返回任务
      </a>
      <h1 className="detail-title">{task.brief}</h1>
      <div className="detail-meta">
        <span>{task.platformLabel}</span>
        <span className="detail-sep" />
        <span>{task.publishMode === "image_text" ? "图文" : "视频"}</span>
        <span className="detail-sep" />
        <span className={`status-pill ${task.needsHuman ? "status-warn" : "status-info"}`}>
          {task.statusLabel}
        </span>
      </div>

      {loadError && (
        <p className="runtime-notice" role="status">
          {loadError}
        </p>
      )}

      <div className="detail-shell">
        <aside className="context-panel surface-card">
          <Context label="你交代的任务">
            <blockquote className="context-quote">{task.brief}</blockquote>
            <span className="context-time">
              {task.runtimeSource === "api" ? "真实 Job · APP-02" : "组件 fixture"}
            </span>
          </Context>

          <Context label="目标平台">
            <div className="context-inline">
              <strong>{task.platformLabel}</strong>
              <span className="quiet-tag">
                {task.publishMode === "image_text" ? "图文" : "视频"}
              </span>
            </div>
          </Context>

          <Context label="原始素材">
            <p className="context-copy">
              {task.materialProvenance?.source === "controlled_smoke"
                ? "当前使用受控测试物料。界面会展示实际将被 prepare 的内容，不会把它说成根据本次 brief 自动生成。"
                : task.materialProvenance?.generatedFromBrief
                  ? "当前物料来自真实 Provider pipeline。"
                  : "物料尚未准备完成。"}
            </p>
          </Context>

          <Context label="发布要求">
            <ul>
              <li>保持产品表达专业、克制</li>
              <li>准备封面与平台标签</li>
              <li>最终发布必须人工批准</li>
            </ul>
          </Context>

          <Context label="当前账号">
            <div className="account-row">
              <span className="account-avatar">小</span>
              <span>
                <strong>当前小红书会话</strong>
                <small>受控浏览器 · 不在 Web 暴露凭据</small>
              </span>
              <span className="account-ok">
                {task.state === "waiting_for_login" ? "待验证" : "运行中"}
              </span>
            </div>
          </Context>

          <Context label="补充说明">
            <textarea
              className="note-input"
              placeholder="补充任务要求将在后续迭代开放"
              rows={3}
              disabled
            />
            <div className="note-actions">
              <button className="secondary-button" type="button" disabled>
                补充给秘书
              </button>
            </div>
          </Context>

          <div className={`human-state ${task.needsHuman ? "needs-human" : ""}`}>
            <span>{task.needsHuman ? "需要你的处理" : "无需人工介入"}</span>
            <strong>{task.statusLabel}</strong>
          </div>
        </aside>

        <Timeline task={task} />
        <WorkSurface
          task={task}
          onTaskUpdate={(next) => {
            setTask(next);
            setLoadError(null);
          }}
        />
      </div>
    </main>
  );
}

function Context({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="context-section">
      <span className="field-label">{label}</span>
      {children}
    </div>
  );
}

const workers: Record<
  Worker,
  { name: string; subtitle: string; avatar: string }
> = {
  content_secretary: {
    name: "内容秘书",
    subtitle: "理解需求 · 准备内容 · 交付物料",
    avatar: "文",
  },
  publishing_secretary: {
    name: "执行秘书",
    subtitle: "浏览器执行 · 人工接管 · 发布取证",
    avatar: "执",
  },
};

function Timeline({ task }: { task: TaskFixture }) {
  return (
    <section className="timeline-panel surface-card">
      <div className="panel-heading">
        <div>
          <span className="eyebrow">执行过程</span>
          <h2>{task.currentStep}</h2>
        </div>
        <span className="updated-at">
          {task.updatedAt
            ? new Date(task.updatedAt).toLocaleTimeString("zh-CN", {
                hour: "2-digit",
                minute: "2-digit",
              })
            : "刚刚"}
        </span>
      </div>

      <div className="worker-stack">
        {(["content_secretary", "publishing_secretary"] as const).map(
          (worker) => (
            <WorkerTimeline
              key={worker}
              worker={worker}
              steps={task.timeline.filter((step) => step.worker === worker)}
              active={task.currentWorker === worker}
            />
          ),
        )}
      </div>
    </section>
  );
}

function WorkerTimeline({
  worker,
  steps,
  active,
}: {
  worker: Worker;
  steps: TimelineStep[];
  active: boolean;
}) {
  const meta = workers[worker];

  return (
    <section className={`worker-card ${active ? "active-worker" : ""}`}>
      <header className="worker-header">
        <div className={`worker-avatar worker-${worker}`}>{meta.avatar}</div>
        <div>
          <div className="worker-name-row">
            <h3>{meta.name}</h3>
            {active && <span className="active-badge">当前负责</span>}
          </div>
          <p>{meta.subtitle}</p>
        </div>
      </header>

      <ol className="timeline-list">
        {steps.map((step) => (
          <li
            key={step.id}
            className={`timeline-step step-${step.status}`}
          >
            <span className="timeline-marker" aria-hidden="true">
              {step.status === "done"
                ? "✓"
                : step.status === "error"
                  ? "!"
                  : ""}
            </span>
            <div>
              <div className="timeline-label-row">
                <strong>{step.label}</strong>
                {step.time && <time>{step.time}</time>}
              </div>
              <p>{step.detail}</p>
            </div>
          </li>
        ))}
      </ol>
    </section>
  );
}

function WorkSurface({
  task,
  onTaskUpdate,
}: {
  task: TaskFixture;
  onTaskUpdate: (task: TaskFixture) => void;
}) {
  const kind = getWorkSurfaceKind(task.state);

  if (kind === "material") {
    return (
      <aside className="work-surface">
        <Card
          eyebrow="当前物料"
          title="Material Pack"
          description="内容秘书正在把任务整理成可发布的素材包。"
        >
          <div className="material-preview">
            {task.materialProvenance?.source === "controlled_smoke" && (
              <div className="material-provenance">
                受控测试物料 · generatedFromBrief=false
              </div>
            )}
            <div className="material-cover">
              {task.material.mode === "video" ? "视频封面预览" : "封面预览"}
            </div>
            <h3>{task.material.title}</h3>
            <p>{task.material.body}</p>
            <Tags values={task.material.tags} />
            <div className="media-strip">
              {task.material.media.map((item) => (
                <div key={item}>
                  <span>{task.material.mode === "video" ? "VIDEO" : "IMG"}</span>
                  {item}
                </div>
              ))}
            </div>
          </div>
        </Card>
      </aside>
    );
  }

  if (kind === "browser" || kind === "takeover") {
    return <Browser task={task} takeover={kind === "takeover"} />;
  }

  if (kind === "approval") {
    return <Approval task={task} onTaskUpdate={onTaskUpdate} />;
  }
  if (kind === "evidence") return <Evidence task={task} />;
  return <Failure task={task} />;
}

function Card({
  eyebrow,
  title,
  description,
  children,
  className = "",
}: {
  eyebrow: string;
  title: string;
  description: string;
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`surface-card work-card ${className}`}>
      <header className="surface-heading">
        <span className="eyebrow">{eyebrow}</span>
        <h2>{title}</h2>
        <p>{description}</p>
      </header>
      {children}
    </div>
  );
}

function Tags({ values }: { values: string[] }) {
  return (
    <div className="tag-row">
      {values.map((tag) => (
        <span key={tag}>#{tag}</span>
      ))}
    </div>
  );
}

function Browser({
  task,
  takeover,
}: {
  task: TaskFixture;
  takeover: boolean;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const liveViewMode = task.browserLiveViewMode ?? "blocked";
  const hasRuntime = liveViewMode === "runtime";
  const isInteractive =
    hasRuntime && takeover && task.controlOwner === "human";
  const controlLabel =
    !hasRuntime
      ? liveViewMode === "placeholder"
        ? "Live View 未连接"
        : "Live View 不可用"
      : task.controlOwner === "human"
        ? "人工控制"
        : task.controlOwner === "agent"
          ? "执行秘书控制"
          : "控制状态未知";
  const description =
    liveViewMode === "placeholder"
      ? "尚未连接 Browser runtime；当前显示受控占位内容。"
      : liveViewMode === "blocked"
        ? "Live View 配置不可用，已停止嵌入该地址。"
        : takeover
          ? "执行秘书已停止页面变更。请在浏览器区域完成扫码、2FA 或设备验证。"
          : "Browser Live View 通过 runtime adapter 接入受控浏览器画面。";

  useLayoutEffect(() => {
    if (!isInteractive) {
      frameRef.current?.blur();
    }
  }, [isInteractive]);

  return (
    <aside className="work-surface">
      <Card
        eyebrow="Browser Live View"
        title={
          takeover && hasRuntime
            ? "请接管登录"
            : takeover
              ? "等待 Browser Live View"
              : "执行秘书正在操作"
        }
        description={description}
      >
        {isInteractive && (
          <div className="takeover-banner">
            <strong>控制权已让给你</strong>
            <span>
              验证完成后，真实运行时应自动检测登录成功并交还控制。
            </span>
          </div>
        )}
        <div className="browser-frame">
          <div className="browser-toolbar">
            <span />
            <span />
            <span />
            <div>publisher.xiaohongshu.com</div>
          </div>
          <iframe
            ref={frameRef}
            className={
              isInteractive ? "live-view-interactive" : "live-view-view-only"
            }
            tabIndex={isInteractive ? 0 : -1}
            referrerPolicy="no-referrer"
            title="Browser Live View"
            src={task.browserLiveViewUrl}
          />
        </div>
        <div className="browser-footer">
          {hasRuntime && <span className="live-indicator" />}
          <span>{controlLabel}</span>
          <code>adapter://browser-live-view</code>
        </div>
      </Card>
    </aside>
  );
}

function Approval({
  task,
  onTaskUpdate,
}: {
  task: TaskFixture;
  onTaskUpdate: (task: TaskFixture) => void;
}) {
  const approval = task.approval!;
  const [submitting, setSubmitting] = useState(false);
  const [approvalError, setApprovalError] = useState<string | null>(null);
  const isRealRuntime = task.runtimeSource === "api";

  const approve = () => {
    if (!isRealRuntime || submitting) return;
    setSubmitting(true);
    setApprovalError(null);
    void taskRepository
      .approve(task.id, approval.actionId)
      .then((next) => {
        onTaskUpdate(next);
      })
      .catch((error: unknown) => {
        setApprovalError(
          error instanceof Error
            ? error.message
            : "批准发布失败，请检查当前任务状态。",
        );
      })
      .finally(() => setSubmitting(false));
  };

  return (
    <aside className="work-surface">
      <Card
        eyebrow="发布审批"
        title="执行秘书已准备好发布"
        description="批准后只允许执行一次最终发布；结果不确定时系统只核验，不会自动再次点击发布。"
      >
        <div className="approval-summary">
          {task.materialProvenance?.source === "controlled_smoke" && (
            <div className="material-provenance">
              受控测试物料 · generatedFromBrief=false
            </div>
          )}
          <dl>
            <div>
              <dt>平台 / 账号</dt>
              <dd>小红书 · {approval.accountName}</dd>
            </div>
            <div>
              <dt>标题</dt>
              <dd>{task.material.title}</dd>
            </div>
            <div>
              <dt>内容</dt>
              <dd>{approval.copySummary}</dd>
            </div>
            <div>
              <dt>媒体</dt>
              <dd>{approval.mediaSummary}</dd>
            </div>
          </dl>
          <Tags values={task.material.tags} />
          <div className="warning-box">
            {approval.warnings.map((warning) => (
              <p key={warning}>{warning}</p>
            ))}
          </div>
          {approvalError && <div className="warning-box"><p>{approvalError}</p></div>}
          <div className="approval-actions">
            <button className="secondary-button" disabled>返回修改</button>
            <button
              className="primary-button"
              type="button"
              disabled={!isRealRuntime || submitting}
              onClick={approve}
            >
              {!isRealRuntime
                ? "Fixture 不执行发布"
                : submitting
                  ? "正在写入批准…"
                  : "批准发布"}
            </button>
          </div>
        </div>
      </Card>
    </aside>
  );
}

function Evidence({ task }: { task: TaskFixture }) {
  return (
    <aside className="work-surface">
      <Card
        eyebrow="交付结果"
        title="发布已完成"
        description="结果以产品级证据展示，不用日志代替交付。"
        className="success-card"
      >
        <div className="success-seal">✓</div>
        <div className="evidence-list">
          {task.evidence?.map((item) => (
            <div key={item.label}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
        <div className="evidence-shot">发布页面证据预览</div>
      </Card>
    </aside>
  );
}

function Failure({ task }: { task: TaskFixture }) {
  const failure = task.failure!;
  const [retrying, setRetrying] = useState(false);
  const [retryError, setRetryError] = useState<string | null>(null);
  const canVerifyPublish =
    task.runtimeSource === "api" &&
    failure.code === "PUBLISH_RESULT_UNKNOWN";

  const verifyPublishResult = () => {
    if (!canVerifyPublish || retrying) return;
    setRetrying(true);
    setRetryError(null);
    void taskRepository
      .continue(task.id)
      .catch((error: unknown) => {
        setRetryError(
          error instanceof Error
            ? error.message
            : "重新核验发布结果失败，请稍后重试。",
        );
      })
      .finally(() => setRetrying(false));
  };

  return (
    <aside className="work-surface">
      <Card
        eyebrow="需要处理"
        title="任务在安全边界内停止"
        description="不展示 raw stack trace，只说明停止位置、原因和可恢复动作。"
        className="failure-card"
      >
        <div className="failure-mark">!</div>
        <dl className="failure-summary">
          <div>
            <dt>停止步骤</dt>
            <dd>{failure.step}</dd>
          </div>
          <div>
            <dt>原因</dt>
            <dd>{failure.reason}</dd>
          </div>
          <div>
            <dt>恢复策略</dt>
            <dd>{failure.recovery}</dd>
          </div>
        </dl>
        {retryError && <div className="warning-box"><p>{retryError}</p></div>}
        <button
          className="secondary-button"
          type="button"
          disabled={!canVerifyPublish || retrying}
          onClick={verifyPublishResult}
        >
          {canVerifyPublish
            ? retrying
              ? "正在核验…"
              : "重新核验结果"
            : "从该步骤重试"}
        </button>
      </Card>
    </aside>
  );
}
