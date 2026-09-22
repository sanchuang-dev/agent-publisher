# Agent Publisher Technical Design

Status: accepted MVP engineering baseline  
Phase: POC / MVP  
Product contract: [../product/PRD.md](../product/PRD.md)  
Frontend contract: [../product/FRONTEND.md](../product/FRONTEND.md)

This document translates the product contract into an implementation-ready technical baseline.

It describes the intended engineering shape. Code, configuration, migrations, and runtime remain the source of truth for what is actually implemented.

## 1. Goals

The MVP must prove one stable Xiaohongshu publishing loop:

```text
task
  → material preparation
  → visible browser
  → login / QR takeover when required
  → Publishing Secretary browser preparation
  → explicit approval
  → publish once
  → verification / evidence
```

Engineering priorities, in order:

1. stable end-to-end behavior;
2. recoverability after interruption;
3. visible human takeover;
4. no duplicate irreversible side effects;
5. portability between local macOS and Docker;
6. replaceable providers without speculative infrastructure;
7. reuse mature application/agent infrastructure before creating Publisher-specific harness machinery.

## 2. Non-goals

Do not build these into the MVP:

- Kubernetes;
- Redis or a distributed queue;
- microservices for product-domain modules;
- a general browser-agent platform;
- multi-account scheduling infrastructure;
- a workflow editor;
- CAPTCHA/MFA/risk-control bypass;
- model/provider configuration UI;
- self-hosted image/video models;
- high-concurrency browser execution;
- a Publisher-specific general agent framework, Skill registry, Tool registry, or MCP protocol runtime when mature Pi/MCP ecosystem components satisfy the boundary.

The demo baseline is one operator and one active browser session.

## 3. Runtime modes

The same application core must support two runtime modes.

### 3.1 Local development mode

Target: developer Mac.

```text
Node app
├─ Fastify API / SSE + Web UI
├─ Orchestrator
├─ PiAgentHost
├─ SQLite
├─ LocalAssetStore
└─ LocalDevToolsBrowserProvider
        ↓
  host Chrome / Chromium / Edge
        ↓
      CDP
```

The local browser is started with remote debugging enabled. The provider attaches with Playwright `connectOverCDP()`.

Use this mode for fast development and browser capability/tool debugging.

### 3.2 Full Docker demo mode

Primary demo target: Intel MacBook Pro, 32 GB RAM.

```text
Docker Compose
├─ app
│  ├─ Fastify API / SSE
│  ├─ Web UI
│  ├─ Orchestrator
│  ├─ PiAgentHost / Pi AgentSessions
│  └─ SQLite
│
└─ browser-runtime
   ├─ Chromium (headful)
   ├─ Xvfb
   ├─ x11vnc
   ├─ noVNC / websockify
   └─ persistent browser profile
```

The product UI embeds the live browser view. The user can scan a QR code or operate the browser when control is handed over.

The browser debugging endpoint is reachable only on the internal Docker network. It must not be published directly to a public interface.

### 3.3 Docker portability target

The Compose definition should avoid host-specific assumptions so it can later run on:

- Intel macOS / Docker Desktop;
- Apple Silicon macOS / Docker Desktop with supported multi-arch images;
- Windows / WSL2 / Docker Desktop;
- a normal Linux VM.

The MVP acceptance environment is the Intel 32 GB MacBook Pro. Other platforms are portability targets, not blockers for the first demo.

## 4. Top-level architecture

```text
┌──────────────────────────────────────────────────────────────────┐
│ Web UI                                                           │
│ task / timeline / material / browser live view / approval        │
└──────────────────────────────┬───────────────────────────────────┘
                               │ HTTP + SSE
┌──────────────────────────────▼───────────────────────────────────┐
│ Fastify Application                                              │
│                                                                  │
│  API → Job/Application Services → Publisher Orchestrator         │
│                    │                       │                     │
│                    │ delegated Agent work  │ business control    │
│                    ▼                       ▼                     │
│               PiAgentHost          Job / checkpoint / actions    │
│                    │                approval / external_actions   │
│             AgentDefinition         validation / evidence         │
│                    │                                             │
│             create / resume                                      │
│                    ▼                                             │
│               Pi AgentSession                                    │
│             /       |        \                                   │
│          Skills    Tools      MCP                                │
│                    │                                             │
│       Publishing Secretary browser tools                         │
│                    ▼                                             │
│          BrowserProvider → Playwright → current page             │
│                    │                                             │
│             observed result                                      │
│                    └──────────→ Publisher Orchestrator            │
└──────────────────────────────────────────────────────────────────┘
```

The application remains one Node.js deployable for the MVP. Module boundaries are code boundaries, not service boundaries.

### 4.1 Node application framework

Use **Fastify 5** as the Node HTTP/SSE application framework.

Fastify owns:

- HTTP routing;
- request/response schema validation;
- SSE endpoint lifecycle;
- application startup/shutdown hooks;
- the outer server error boundary.

Do not add NestJS or a general DI container. Application dependencies are composed explicitly in the bootstrap/composition root.

Fastify is not an agent framework. Pi sessions run behind application/orchestration boundaries.

### 4.2 Pi harness baseline

The MVP agent harness baseline is the embeddable **`@earendil-works/pi-coding-agent` SDK**, subject to the in-project foundation work described in [PI-ECOSYSTEM-EVALUATION.md](./PI-ECOSYSTEM-EVALUATION.md).

The package name does not make coding-agent CLI behavior part of the product. Publisher uses the SDK programmatically with explicit resources and tools.

Prefer the SDK harness before rebuilding around `@earendil-works/pi-agent-core` alone because the SDK already composes:

- AgentSession lifecycle;
- model/runtime services;
- ResourceLoader;
- Skills;
- extensions/custom tools;
- tool selection/interception;
- event streaming;
- session/history management;
- context compaction and settings.

DeepSeek Harness remains an experimental/future migration candidate, not a parallel MVP implementation.

## 5. Module layout

Target layout as implementation reaches it:

```text
src/
├─ app/
│  ├─ config.ts
│  ├─ bootstrap.ts
│  └─ composition.ts
├─ api/
│  ├─ server.ts
│  ├─ jobs.ts
│  ├─ actions.ts
│  ├─ profiles.ts
│  └─ events.ts
├─ orchestrator/
│  ├─ orchestrator.ts
│  ├─ state-machine.ts
│  ├─ checkpoints.ts
│  └─ recovery.ts
├─ agent/
│  ├─ definition.ts
│  ├─ host.ts
│  ├─ session-ref.ts
│  ├─ context.ts
│  ├─ resources.ts
│  ├─ extensions/
│  │  └─ tool-guard.ts
│  └─ roles/
│     ├─ content-secretary.ts
│     └─ publishing-secretary.ts
├─ jobs/
│  ├─ contracts.ts
│  ├─ service.ts
│  └─ repository.ts
├─ materials/
│  ├─ contracts.ts
│  ├─ pipeline.ts
│  ├─ platform-adapter.ts
│  └─ providers/
│     ├─ text.ts
│     ├─ image.ts
│     ├─ design.ts
│     └─ video.ts
├─ browser/
│  ├─ provider.ts
│  ├─ session.ts
│  └─ providers/
│     ├─ local-devtools.ts
│     └─ docker-cdp.ts
├─ platforms/
│  ├─ contract.ts
│  └─ xiaohongshu/
│     ├─ publisher.ts
│     ├─ locators.ts
│     ├─ state.ts
│     └─ recovery.ts
├─ approval/
│  ├─ contract.ts
│  └─ service.ts
├─ assets/
│  ├─ store.ts
│  └─ local-store.ts
├─ evidence/
│  ├─ contract.ts
│  └─ service.ts
├─ storage/
│  ├─ db.ts
│  ├─ migrations/
│  └─ repositories/
└─ shared/
   ├─ errors.ts
   ├─ ids.ts
   └─ time.ts

skills/
├─ content-planning/
├─ xiaohongshu-copy/
└─ browser-recovery/

web/
docker/
└─ browser-runtime/
```

Do not create all files merely to match the diagram. Add modules only when an accepted implementation slice reaches them.

In particular, do **not** pre-create generic `SkillRegistry`, `ToolRegistry`, `McpManager`, or `ContextManager` modules. Pi/MCP ecosystem facilities own those concerns unless project evidence proves a missing boundary.

## 6. Core contracts

### 6.1 AgentDefinition and AgentHost

The previous three-method `AgentRuntime.start/resume/cancel` abstraction is superseded by a definition/session model.

A reusable agent definition describes a class of work:

```ts
interface AgentDefinition {
  id: string;
  model: ModelPolicy;
  systemPrompt: SystemPromptProvider;
  skills: SkillSource[];
  tools: ToolProfile;
  mcp?: McpProfile[];
  context?: ContextProvider[];
  settings?: AgentSettings;
  session?: SessionPolicy;
}
```

This is Publisher configuration, not a reimplementation of Pi internals.

A process-level host owns the Pi integration boundary:

```ts
interface AgentHost {
  createSession(input: CreatePublisherAgentSessionInput): Promise<PublisherAgentSession>;
  resumeSession(input: ResumePublisherAgentSessionInput): Promise<PublisherAgentSession>;
}
```

A created session is job/role/helper scoped and exposes only the narrow operations the Orchestrator needs:

```ts
interface PublisherAgentSession {
  ref: AgentSessionRef;
  run(input: AgentTaskInput): Promise<AgentTaskResult>;
  dispose(): Promise<void>;
}
```

The first implementation is `PiAgentHost`.

Pi-specific session/tool/resource types remain inside the agent integration module. Domain services consume `AgentDefinition`, `AgentSessionRef`, and structured task results.

#### Reuse and isolation

Reuse:

- AgentDefinition;
- safe process-level Pi runtime/model services;
- controlled resource definitions;
- tool factories;
- skill resources;
- MCP profiles.

Isolate by job/role or narrower helper task:

- transcript;
- dynamic Job context;
- browser observations;
- temporary tool grants;
- task-specific external capability state.

Do not keep one role conversation alive across unrelated Publish Jobs.

#### Controlled ResourceLoader

Publisher must not rely on ambient Pi discovery from the service account's home directory or arbitrary project directories.

Use an explicit/controlled ResourceLoader configuration. The application chooses:

- system prompt;
- context resources;
- Skills;
- extensions;
- settings;
- allowed workspace paths.

No developer-local `~/.pi`, `.pi`, `.agents`, model config, extension, or MCP configuration is part of the production runtime unless Publisher explicitly provisions it.

#### Skills

Use Pi / Agent Skills rather than a Publisher-specific Skill registry or schema.

Mandatory safety/workflow instructions may be host-loaded rather than relying entirely on optional progressive discovery.

If Skill loading requires file reads, provide a restricted read capability limited to approved Skill and Job workspace roots. Do not enable arbitrary filesystem or shell access merely to support Skills.

#### Tools

Use Pi's custom-tool registration, tool selection, and tool-call interception.

Each AgentDefinition/session has an explicit allowed tool profile. Prefer not exposing a dangerous tool at all; use an execution guard as a second boundary.

The irreversible final publish action is **not** an Agent tool.

#### MCP

MCP is an optional external capability source.

First evaluate a mature Pi-compatible MCP adapter/extension (currently `pi-mcp-adapter`) before implementing custom transport, discovery, OAuth, lifecycle, or catalog management.

Publisher owns MCP server/profile configuration and tool allowlists. Do not inherit arbitrary machine-local MCP configuration.

Treat the adapter as a third-party dependency whose behavior must be proven by repository tests before it becomes a locked baseline.

### 6.2 BrowserProvider

```ts
interface BrowserProvider {
  acquire(input: BrowserAcquireInput): Promise<BrowserSession>;
  release(sessionId: string): Promise<void>;
  health(): Promise<BrowserProviderHealth>;
}
```

```ts
interface BrowserSession {
  id: string;
  page: Page;
  profileRef: string;
  liveView?: {
    url: string;
  };
}
```

MVP implementations:

- `LocalDevToolsBrowserProvider` — host browser through CDP.
- `DockerCdpBrowserProvider` — headful Chromium inside `browser-runtime`.

Restricted browser tools and platform validation/publish-control services receive a Playwright `Page`-level abstraction and do not issue raw CDP commands for normal work. `BrowserProvider` and Playwright supply browser capability; neither decides which publishing route to take.

### 6.3 Platform execution and publication control

Normal pre-publish path selection belongs to the job-scoped Publishing Secretary AgentSession, guided by the platform Skill and current page observations.

Deterministic platform code owns validation and the irreversible publication boundary. Conceptually:

```ts
interface PlatformPublicationControl {
  verifyPrepared(
    job: PublishJob,
    session: BrowserSession,
  ): Promise<PreparedVerification>;
  publishApproved(input: ApprovedPublication): Promise<PublishAttempt>;
  verifyResult(input: PublishAttempt): Promise<PublicationEvidence>;
}
```

The Xiaohongshu implementation may keep stable locators and readback helpers internally, but a `prepare()` selector workflow is not the target ownership model for the normal route.

### 6.4 Material providers

The material domain keeps stable provider slots while allowing deterministic Builtin implementations and later external enhancements.

Conceptually:

```ts
interface TextProvider {
  generate(plan: MaterialPlan): Promise<ProviderResult<TextMaterial>>;
}

interface ImageProvider {
  generate(
    plan: MaterialPlan,
  ): Promise<ProviderResult<readonly ImageAssetReference[]>>;
}

interface DesignRenderInput {
  plan: ImageTextMaterialPlan;
  copy: TextMaterial;
  sourceImages: readonly ImageAssetReference[];
}

interface DesignRenderResult {
  source: DesignAssetReference | null;
  cover: ImageAssetReference;
  images: readonly ImageAssetReference[];
}

interface DesignProvider {
  render(
    input: DesignRenderInput,
  ): Promise<ProviderResult<DesignRenderResult>>;
}
```

The invariant matters more than the exact TypeScript spelling: a design provider receives resolved content and returns **publishable image assets**. An editable/source design reference remains optional provenance and never replaces the publishable cover/images.

The image-text MVP includes a Publisher-owned Builtin path:

```text
MaterialPlan + resolved copy + controlled source images
  ↓
SafeRichLayout
  ↓
schema / policy validation
  ↓
BuiltinLayoutRenderer (Takumi baseline)
  ↓
deterministic PNG bytes
  ↓
AssetStore
```

SafeRichLayout is the Publisher-owned domain/security boundary. It does not expose arbitrary renderer JSX/HTML/CSS, executable browser APIs, or renderer-controlled network fetches. The current renderer baseline uses controlled local font/image resources and does not use the authenticated publishing browser.

External design providers such as Canva implement the same material outcome and remain optional enhancements.

A provider implementation must not create its own long-lived model/session harness when the same work belongs in an AgentDefinition / Pi AgentSession. Plain deterministic provider APIs may still call external media services directly when no agent reasoning is required.

### 6.5 AssetStore

```ts
interface AssetStore {
  put(input: AssetWriteInput): Promise<AssetRecord>;
  read(assetId: string): Promise<Buffer>;
  resolveLocalPath(asset: AssetReferencePointer): Promise<string>;
}
```

MVP implementation: `LocalAssetStore`, backed by Publisher-controlled local bytes plus SQLite metadata/checksum state.

Durable material references use canonical `asset://{assetId}` identity. Platform adapters resolve those references at the upload boundary rather than depending on expiring provider URLs or machine-specific absolute paths.

Future implementations may use OSS or R2 without changing the material pipeline.

## 7. Orchestration model

There is one Publisher Orchestrator and zero or more Orchestrator-owned AgentSessions active as the task requires.

```text
Publisher Orchestrator
├─ deterministic Job / governance / validation
├─ deterministic material/provider services where appropriate
├─ Content Secretary AgentSession
└─ Publishing Secretary AgentSession     (task-local browser execution owner)
```

Content Secretary and Publishing Secretary remain the two user-visible product roles. Additional bounded helper sessions may exist, but they do not become independently visible employees unless a later product decision says so.

This is **multiple agent instances under one business orchestrator**, not an autonomous multi-agent organization.

The Orchestrator owns:

- phase transitions;
- checkpoints;
- ActionRequests;
- approval gates;
- workflow retry policy;
- tool/control grants and transfer between human and automation;
- prepared-state validation;
- irreversible-side-effect authority;
- Job completion.

Pi AgentSessions own model-facing execution context and the bounded task execution delegated to them; they do not become the source of truth for Publisher business state.

### 7.1 Agent responsibilities

Agent/model execution is used for:

- brief interpretation;
- MaterialPlan creation;
- copy generation/adaptation;
- bounded external research through approved Tools/MCP;
- Publishing Secretary browser execution for the current Job;
- interpreting the current browser state;
- planning and taking the next bounded browser action;
- observing the resulting state and re-planning/recovering;
- deciding that clarification or human takeover is safer.

### 7.2 Publishing browser execution

Normal pre-publish browser work is owned by the Publishing Secretary AgentSession:

```text
observe
  ↓
plan
  ↓
act through restricted browser tools
  ↓
observe / validate local post-condition
  ↓
continue | recover/re-plan | hand off | fail visibly
```

Platform Skills provide knowledge: semantic cues, known entry points, successful patterns, locator hints, required post-conditions, identity handoff conditions, and prohibited actions. They are not fixed selector workflows.

`BrowserProvider` provides the session/page and Playwright implements browser mechanics. Neither component decides the task route.

Stable locators and deterministic helpers remain useful implementation details when they match the observed page. They do not turn the normal path into an Orchestrator-owned sequence.

### 7.3 Publisher-owned deterministic responsibilities

Deterministic Publisher code owns:

- Job status/phase transitions and checkpoint persistence;
- browser-control lease and allowed tool surface;
- login/MFA/device-verification handoff and safe resume;
- prepared-form readback and validation against accepted material;
- the explicit approval gate;
- `external_actions` idempotency and publish-once authority;
- result verification and verify-first recovery for an uncertain publish;
- final Job completion.

The irreversible Publish action is not exposed as a normal Agent browser tool. After approval, it executes through a Publisher-owned guarded operation. A lost/uncertain result is verified before any retry.

### 7.4 Pi session state vs Publisher business state

Keep two persistence domains:

```text
Pi AgentSession
= transcript / context continuity / model-facing history

Publisher SQLite
= Job / checkpoint / ActionRequest / approval /
  external_actions / evidence
```

Restoring a Pi session never proves that a business side effect happened. Business transitions advance only from Publisher-owned evidence and state-machine rules.

## 8. Job state machine

User-visible states remain the product vocabulary. Internally the state machine may use finer checkpoints.

```text
created
  ↓
preparing_materials
  ├─ generate_plan
  ├─ generate_copy
  ├─ generate_images
  └─ generate_video?          optional / degradable
  ↓
preparing_publish
  ├─ acquire_browser
  ├─ open_platform
  ├─ ensure_login
  │      └─ waiting_for_login
  ├─ upload_assets
  ├─ fill_form
  └─ verify_prepared
  ↓
waiting_for_approval
  ↓
publishing
  ├─ publish_once
  └─ verify_result
  ↓
succeeded | failed
```

A video task may enter a degraded material state only when product rules permit fallback. The fallback must be visible; it is not silent substitution.

## 9. Human action protocol

All pauses requiring a human use `ActionRequest`.

Types:

```text
login_required
approval_required
clarification_required
```

Shape:

```ts
interface ActionRequest {
  id: string;
  jobId: string;
  type: "login_required" | "approval_required" | "clarification_required";
  status: "open" | "resolved" | "cancelled";
  payload: unknown;
  createdAt: string;
  resolvedAt?: string;
}
```

When an action is open:

- the current browser-mutating execution stops;
- the checkpoint is committed;
- browser automation must not continue mutating the page;
- the UI shows the required intervention.

For login takeover, the live browser remains visible and interactive.

After login success is reliably detected, the system may resolve `login_required` automatically. A manual "continue" control is a fallback, not the preferred flow.

## 10. Browser control and live view

### 10.1 Docker browser runtime

The `browser-runtime` container runs one headful Chromium instance for the MVP.

Conceptual startup:

```text
Xvfb :99
  ↓
Chromium
  --remote-debugging-address=0.0.0.0
  --remote-debugging-port=9222
  --user-data-dir=/data/profile
  ↓
x11vnc
  ↓
websockify / noVNC
```

The app connects to port 9222 only over the Compose internal network.

The live-view transport is exposed to the application UI through the app/reverse-proxy boundary rather than exposing the debug endpoint publicly.

### 10.2 Human vs agent control

There must never be simultaneous automated mutation and human takeover.

MVP rule:

```text
agent_control
  ↓ login_required
human_control
  ↓ login detected / user continues
agent_control
```

The Orchestrator is the control owner. Entering a human action state suspends browser-mutating automation.

### 10.3 Browser profile persistence

Docker mode mounts a persistent profile volume.

Example:

```text
/data/browser-profile
```

A container restart should not intentionally erase the authenticated browser profile.

The database stores only a profile reference and health metadata, not raw cookies/passwords/tokens.

## 11. Docker Compose baseline

Logical Compose shape:

```yaml
services:
  app:
    # Node API + web UI
    volumes:
      - app-data:/data
    depends_on:
      browser-runtime:
        condition: service_healthy

  browser-runtime:
    # Chromium + Xvfb + noVNC
    shm_size: "1gb"
    volumes:
      - browser-profile:/data/profile
    # CDP stays on the internal compose network.
```

Persistent data:

```text
app-data
├─ app.db
├─ assets/
└─ evidence/

browser-profile
└─ Chromium profile
```

For the demo, one browser session is enough. Do not add a browser pool.

## 12. SQLite persistence

SQLite is the transactional source of truth for task/checkpoint state.

Preferred implementation is a synchronous SQLite driver behind repository interfaces. The schema, not the driver API, is the durable contract.

Startup pragmas:

```sql
PRAGMA foreign_keys = ON;
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
```

### 12.1 jobs

```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  publish_mode TEXT NOT NULL CHECK (publish_mode IN ('image_text', 'video')),
  status TEXT NOT NULL,
  current_step TEXT,
  browser_profile_id TEXT,
  brief_json TEXT NOT NULL,
  material_summary_json TEXT,
  error_code TEXT,
  error_message TEXT,
  version INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT
);

CREATE INDEX idx_jobs_status_updated
  ON jobs(status, updated_at);
```

### 12.2 job_steps

```sql
CREATE TABLE job_steps (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  step_key TEXT NOT NULL,
  status TEXT NOT NULL,
  attempt INTEGER NOT NULL DEFAULT 1,
  idempotency_key TEXT,
  input_json TEXT,
  output_json TEXT,
  error_code TEXT,
  error_message TEXT,
  started_at TEXT,
  finished_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, step_key, attempt)
);

CREATE INDEX idx_job_steps_job
  ON job_steps(job_id, created_at);
```

### 12.3 action_requests

```sql
CREATE TABLE action_requests (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  status TEXT NOT NULL,
  payload_json TEXT,
  resolution_json TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);

CREATE INDEX idx_action_requests_open
  ON action_requests(job_id, status);
```

### 12.4 browser_profiles

```sql
CREATE TABLE browser_profiles (
  id TEXT PRIMARY KEY,
  provider TEXT NOT NULL,
  platform TEXT NOT NULL,
  display_name TEXT NOT NULL,
  profile_ref TEXT NOT NULL,
  health_status TEXT,
  last_verified_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
```

Do not put raw cookies, passwords, access tokens, QR artifacts, or storage-state payloads in this table.

### 12.5 assets

```sql
CREATE TABLE assets (
  id TEXT PRIMARY KEY,
  job_id TEXT REFERENCES jobs(id) ON DELETE SET NULL,
  kind TEXT NOT NULL,
  uri TEXT NOT NULL,
  mime_type TEXT,
  checksum TEXT,
  metadata_json TEXT,
  status TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX idx_assets_job
  ON assets(job_id, created_at);
```

### 12.6 evidence

```sql
CREATE TABLE evidence (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  uri TEXT,
  value TEXT,
  metadata_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX idx_evidence_job
  ON evidence(job_id, created_at);
```

### 12.7 external_actions

```sql
CREATE TABLE external_actions (
  id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  action_type TEXT NOT NULL,
  action_key TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('prepared', 'started', 'succeeded', 'unknown', 'failed')
  ),
  external_ref TEXT,
  started_at TEXT,
  finished_at TEXT,
  error_code TEXT,
  error_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE(job_id, action_key)
);
```

This table protects irreversible side effects.

## 13. Checkpoint and idempotency rules

Every meaningful step follows:

```text
load durable state
  ↓
check whether post-condition already holds
  ↓
if yes: record/reuse result and advance
  ↓
if no: execute
  ↓
persist result transactionally
  ↓
advance
```

Examples:

- accepted copy is not regenerated because video failed;
- an already uploaded asset is not uploaded again after resume when its successful state can be established;
- an already open login action is reused rather than duplicated.

### 13.1 Publish side effect

Publication is special.

Before clicking Publish:

1. a resolved approval request must exist;
2. create/confirm one unique `external_actions` record;
3. set it to `started`;
4. execute the publish action once;
5. verify platform result;
6. set `succeeded` only after evidence supports success.

If the process/browser connection is lost after step 3:

```text
external_actions.status = unknown
```

On resume:

> verify first; never immediately click Publish again.

Only after verification establishes that the previous publish did not occur may a new attempt be authorized.

## 14. Xiaohongshu publisher

The Xiaohongshu Skill owns platform knowledge for browser preparation; the Publishing Secretary owns the task-local route through the current real page.

The Skill may provide:

- supported publishing intent and entry-point knowledge;
- semantic cues for login state, 图文/视频 mode, editors, upload readiness, and dialogs;
- locator hints or successful interaction patterns learned from verified runs;
- required material/prepared-state post-conditions;
- identity/risk-control handoff conditions;
- prohibited actions and known unsafe states.

The Skill does not prescribe a single selector sequence that must be replayed.

### 14.1 Publishing Secretary execution loop

For normal pre-publish work the Publishing Secretary:

1. observes the real page state;
2. plans the next bounded action from Job intent + Skill guidance;
3. acts through restricted browser tools;
4. observes the post-condition;
5. continues, re-plans/recovers, requests human takeover, or fails visibly;
6. stops when the prepared-state condition is reached.

Recovery is part of this normal loop rather than a separate Agent-only escape hatch after a deterministic workflow fails.

Stable selectors/helpers remain under the Xiaohongshu module and may be used as hints or safe primitives. They must not leak into the Orchestrator as the definition of the publishing path.

### 14.2 Deterministic safety boundary

Publisher-owned code must:

- stop browser mutation while human identity control is active;
- read back and validate prepared title/body/tags/assets against the accepted material before approval;
- require a resolved approval before irreversible publication;
- create/confirm the unique `external_actions` record and allow one guarded publish attempt;
- verify platform result before marking success;
- verify first rather than retry when a publish result is uncertain.

The Publishing Secretary must not publish through an ordinary browser tool, repeatedly click possible publish controls, alter accepted content merely to get through the flow, bypass identity/risk controls, or retry an uncertain publish side effect.

## 15. Material pipeline

The configured product runtime now owns a real image-text vertical slice:

```text
CreativeBrief
  ↓
Content Secretary
  ↓
MaterialPlan
  ↓
MaterialPreparationService
  ├─ material_copy
  ├─ material_images
  ├─ material_cover
  └─ material_design
  ↓
LocalAssetStore
  ↓
MaterialPack
  ↓
Xiaohongshu prepare
```

Each accepted material step is persisted independently and may be reused after retry/restart. A downstream failure must not unconditionally regenerate already accepted copy or assets.

The Builtin baseline produces a cover as a distinct durable Publisher asset from `images[]`; the assembly layer rejects aliased cover/image identities.

The configured application defaults to the real provider pipeline. `controlled_smoke` remains an explicit deterministic test/runtime mode rather than the normal product path.

### 15.1 Reliability rule

For MVP:

> Builtin image-text is the dependable baseline; video and external design services are additive.

Provider failure remains local to the current material step whenever possible.

Material pack status:

```text
ready
ready_with_degradation
```

Retryable provider failures keep the Job resumable. Optional design degradation remains visible and contract-valid. The user-selected publish mode still governs whether a degraded pack is publishable; do not silently convert a requested video publication into an image/text publication.

## 16. API surface

Keep the API small.

Representative endpoints:

```text
POST   /api/jobs
GET    /api/jobs
GET    /api/jobs/:id
POST   /api/jobs/:id/cancel

GET    /api/jobs/:id/actions
POST   /api/actions/:id/resolve

GET    /api/profiles
POST   /api/profiles/:id/reconnect

GET    /api/jobs/:id/events        # SSE
GET    /api/jobs/:id/evidence
```

Publish approval is represented as resolution of an `approval_required` action rather than a separate hidden side channel.

For MVP, SSE is sufficient for timeline/status updates. Do not add Redis-backed realtime infrastructure.

## 17. Frontend/runtime integration

The frontend consumes product-level state only.

It should not receive:

- raw agent chain-of-thought;
- CDP messages;
- Playwright selectors;
- internal token accounting;
- browser credentials.

The right-side work surface maps to state:

```text
preparing_materials     → material preview
preparing_publish       → browser live view
waiting_for_login       → interactive browser takeover
waiting_for_approval    → approval summary
publishing              → browser/status
succeeded               → evidence
failed                  → recovery/failure summary
```

## 18. Configuration

Configuration comes from environment variables and validated startup config.

Categories:

```text
APP
- host / port
- data directory
- runtime mode

DATABASE
- sqlite path

BROWSER
- provider: local-devtools | docker-cdp
- CDP endpoint
- live-view endpoint
- profile reference

AGENT
- Pi harness/runtime settings
- provider/model credentials by environment
- controlled Skill/resource roots
- AgentDefinition defaults
- session persistence policy

MCP
- Publisher-owned server profiles
- per-agent/server allowlists
- adapter settings
- secret references only; no plaintext credentials in repository config

MATERIAL
- text/image/design/video provider credentials

SECURITY
- local/demo access control when exposed beyond localhost
```

Secrets are never checked into the repository.

Local development uses a gitignored environment file if needed. CI uses secret storage.

## 19. Security boundary

### Local mode

Bind to localhost by default.

### Docker demo on one machine

Ports may be exposed to the host for demonstration, but CDP must remain internal to Compose.

### Remote deployment

Before exposing the demo remotely:

- put the app behind HTTPS;
- require at least single-operator authentication;
- proxy/protect the browser live view through the application/reverse proxy;
- do not expose raw CDP, VNC, or browser-profile storage publicly.

Browser screenshots/live view may reveal private account data and are treated as sensitive.

## 20. Error model

Use stable product error codes plus safe human-readable messages.

Categories:

```text
MATERIAL_PROVIDER_UNAVAILABLE
MATERIAL_GENERATION_FAILED
BROWSER_UNAVAILABLE
BROWSER_SESSION_LOST
LOGIN_REQUIRED
PLATFORM_UI_CHANGED
UPLOAD_FAILED
PREPARED_VALIDATION_FAILED
APPROVAL_REQUIRED
PUBLISH_RESULT_UNKNOWN
PUBLISH_FAILED
VERIFY_FAILED
```

Raw stack traces remain in developer logs, not normal product UI.

## 21. Observability

For each job record:

- job ID;
- current phase/step;
- step attempt count;
- provider/runtime used;
- durations;
- safe error codes;
- action-request transitions;
- external-action transitions;
- evidence references.

Never log:

- passwords;
- cookies;
- storage-state payloads;
- tokens;
- QR-login artifacts;
- sensitive browser-profile contents.

## 22. Testing strategy

### Unit

- state transitions;
- checkpoint behavior;
- idempotency rules;
- material degradation;
- approval rules;
- publish unknown-state recovery.

### Integration

- SQLite migrations/repositories;
- provider adapters with fake providers;
- BrowserProvider contract;
- Docker browser runtime health;
- local asset storage;
- Pi SDK session creation/disposal;
- AgentDefinition session isolation;
- controlled ResourceLoader with no ambient discovery;
- Skill loading under restricted file access;
- tool allowlist + execution guard;
- MCP adapter lifecycle/configuration when MCP is enabled;
- Publisher Job resume together with an agent-session reference without treating the transcript as business truth.

### Browser smoke

Against controlled pages:

- connect to Chromium;
- visible live view;
- human/agent control transition;
- file upload;
- restart with profile persistence.

### Real-platform acceptance

Manual/controlled Xiaohongshu acceptance:

```text
create task
→ prepare material
→ open real publishing page
→ QR login if needed
→ automatic resume
→ fill real form
→ approval
→ publish once
→ verify real result
→ evidence
```

CI must not publish real content.

## 23. First implementation sequence

This is implementation order, not a set of GitHub work items.

1. **Persistence + state machine**
   - migrations;
   - job repository;
   - action requests;
   - external-action idempotency.

2. **Docker browser runtime**
   - Chromium + Xvfb + noVNC;
   - persistent profile;
   - internal CDP;
   - live view visible in UI.

2.5. **Pi harness foundation — start in parallel with browser/platform evidence work**
   - embed `pi-coding-agent` SDK without CLI assumptions;
   - establish AgentDefinition + PiAgentHost + isolated session lifecycle;
   - prove controlled ResourceLoader / Skills / tool boundaries;
   - prove Publisher-owned MCP configuration through a mature adapter before custom MCP infrastructure;
   - prove session/context isolation and restart/resume compatibility.

   This foundation must precede implementation of the obsolete thin `AgentRuntime.start/resume/cancel` shape, custom Skill/Tool/MCP registries, or model/session machinery embedded ad hoc in providers.

3. **Xiaohongshu Publishing Secretary pre-publish path**
   - restricted browser observe/action tools over BrowserProvider/Playwright;
   - Xiaohongshu Skill knowledge and success/forbidden-state guidance;
   - task-local `observe → plan → act → observe/recover` execution;
   - QR/human identity takeover;
   - upload/fill through the Agent-chosen current-page path;
   - deterministic prepared-form readback/verification;
   - stop before approval.

   The normal pre-publish route runs through the job-scoped Publishing Secretary session. BrowserProvider, Playwright, Skills, and stable locators supply capabilities/knowledge; they do not own the route.

4. **Application/API + approval + publish-once + evidence**
   - Fastify application/bootstrap;
   - Job/action HTTP API and SSE;
   - approval action;
   - external action record;
   - one publish action;
   - verification.

5. **Additional Agent-powered product features**
   - Content Secretary vertical slice through AgentDefinition / Pi AgentSession;
   - real TextProvider/ImageProvider integration where reasoning/provider boundaries require it;
   - optional video;
   - accumulated platform Skill experience from verified successful runs;
   - no transfer of Job, approval, or irreversible-side-effect authority into Pi.

The first demo should not wait for a sophisticated material-provider matrix. A controlled MaterialPack fixture is acceptable while proving the browser/publish risk.

Agent infrastructure is intentionally brought forward; agent autonomy is not.

## 24. MVP technical acceptance

The technical baseline is proven when, on the agreed Docker demo machine:

1. `docker compose up` starts the product and visible browser runtime;
2. the browser view is visible from the Agent Publisher UI;
3. browser profile survives a normal container restart;
4. a Xiaohongshu task can reach login;
5. the user can scan/login through the visible browser;
6. the system detects successful login and resumes;
7. assets and copy are filled into the real publish form;
8. the system stops for approval;
9. one approved publish action is performed;
10. the real platform result is verified and evidence is stored;
11. restarting the app during a resumable phase does not restart the job from zero;
12. an uncertain publish result is verified before any retry.

## 25. Design principles

- Stability before autonomy.
- Reuse mature application/agent infrastructure before rebuilding it.
- Reusable AgentDefinitions; job-scoped AgentSessions.
- Explicit resources over ambient developer-machine discovery.
- Deterministic business governance; Agent-chosen browser path inside bounded tools/Skills.
- Checkpoint every meaningful boundary.
- Human identity proof is part of the product.
- Publish is a side effect, not just another tool call.
- One browser session is enough for the MVP.
- Local and Docker modes share the same product core.
- Browser runtime is replaceable behind BrowserProvider.
- Provider implementations are replaceable behind capability contracts.
- Pi session history is context, never business truth.
- Irreversible publish authority stays outside the model tool surface.
- Do not generalize beyond evidence from the first working Xiaohongshu loop.
