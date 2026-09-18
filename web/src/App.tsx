import { useEffect, useState, type ReactNode } from "react";

import {
  getWorkSurfaceKind,
  isFixtureState,
  taskRepository,
  type FixtureState,
  type PublishMode,
  type TaskFixture,
  type TimelineStep,
  type Worker,
} from "./model";

function readRoute(): { page: "home" } | { page: "task"; state: FixtureState } {
  const state = window.location.hash.match(/^#\/task\/([^/?#]+)/)?.[1];
  return state && isFixtureState(state)
    ? { page: "task", state }
    : { page: "home" };
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
      ) : (
        <TaskDetail state={route.state} />
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

  useEffect(() => {
    void taskRepository.list().then(setTasks);
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
                onClick={() => setPublishMode("video")}
              >
                视频
              </button>
            </div>
          </div>
          <span className="assign-spacer" />
          <button
            className="primary-button"
            disabled={!brief.trim()}
            onClick={() => {
              taskRepository.assign({
                brief: brief.trim(),
                publishMode,
              });
              window.location.hash = "#/task/preparing_materials";
            }}
          >
            交给内容秘书
          </button>
        </div>
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
                    href={`#/task/${task.state}`}
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

function TaskDetail({ state }: { state: FixtureState }) {
  const [task, setTask] = useState<TaskFixture | null>(null);

  useEffect(() => {
    void taskRepository.get(state).then(setTask);
  }, [state]);

  if (!task) {
    return <main className="loading-shell">正在加载任务…</main>;
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

      <div className="detail-shell">
        <aside className="context-panel surface-card">
          <Context label="你交代的任务">
            <blockquote className="context-quote">{task.brief}</blockquote>
            <span className="context-time">刚刚 · 来自工作台</span>
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
            <p className="context-copy">还没有原始素材，内容秘书会按你的描述先做一版。</p>
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
              <span className="account-avatar">沐</span>
              <span>
                <strong>沐野洗护 官方号</strong>
                <small>小红书 · 企业号</small>
              </span>
              <span className="account-ok">已登录</span>
            </div>
          </Context>

          <Context label="补充说明">
            <textarea
              className="note-input"
              placeholder="有新的要求？写在这里，秘书会据此调整"
              rows={3}
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
        <WorkSurface task={task} />
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
        <span className="updated-at">今天 18:17</span>
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

function WorkSurface({ task }: { task: TaskFixture }) {
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

  if (kind === "approval") return <Approval task={task} />;
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
  return (
    <aside className="work-surface">
      <Card
        eyebrow="Browser Live View"
        title={takeover ? "请接管登录" : "执行秘书正在操作"}
        description={
          takeover
            ? "执行秘书已停止页面变更。请在浏览器区域完成扫码、2FA 或设备验证。"
            : "Browser Live View 通过 adapter URL 接入；本轮先使用受控占位页。"
        }
      >
        {takeover && (
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
            title="Browser Live View placeholder"
            src={task.browserLiveViewUrl}
          />
        </div>
        <div className="browser-footer">
          <span className="live-indicator" />
          <span>{takeover ? "人工控制" : "执行秘书控制"}</span>
          <code>adapter://browser-live-view</code>
        </div>
      </Card>
    </aside>
  );
}

function Approval({ task }: { task: TaskFixture }) {
  const approval = task.approval!;

  return (
    <aside className="work-surface">
      <Card
        eyebrow="发布审批"
        title="执行秘书已准备好发布"
        description="不可逆操作前的最终签署面。当前 fixture 不会触发真实发布。"
      >
        <div className="approval-summary">
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
          <div className="approval-actions">
            <button className="secondary-button">返回修改</button>
            <button className="primary-button" disabled>
              批准发布
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
        <button className="secondary-button" disabled>
          从该步骤重试
        </button>
      </Card>
    </aside>
  );
}
