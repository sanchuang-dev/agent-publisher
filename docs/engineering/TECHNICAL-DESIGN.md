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
  → deterministic form preparation
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
6. replaceable providers without speculative infrastructure.

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
- high-concurrency browser execution.

The demo baseline is one operator and one active browser session.

## 3. Runtime modes

The same application core must support two runtime modes.

### 3.1 Local development mode

Target: developer Mac.

```text
Node app
├─ API / Web UI
├─ Orchestrator
├─ SQLite
├─ LocalAssetStore
└─ LocalDevToolsBrowserProvider
        ↓
  host Chrome / Chromium / Edge
        ↓
      CDP
```

The local browser is started with remote debugging enabled. The provider attaches with Playwright `connectOverCDP()`.

Use this mode for fast development and selector debugging.

### 3.2 Full Docker demo mode

Primary demo target: Intel MacBook Pro, 32 GB RAM.

```text
Docker Compose
├─ app
│  ├─ API
│  ├─ Web UI
│  ├─ Orchestrator
│  ├─ Agent runtime adapter
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
┌───────────────────────────────────────────────────────────────┐
│ Web UI                                                        │
│ task / timeline / material / browser live view / approval     │
└──────────────────────────────┬────────────────────────────────┘
                               │ HTTP + SSE
┌──────────────────────────────▼────────────────────────────────┐
│ Application                                                   │
│                                                               │
│  API                                                          │
│   ↓                                                           │
│  Job Service                                                  │
│   ↓                                                           │
│  Orchestrator                                                 │
│   ├─ Content Secretary session                                │
│   └─ Publishing Secretary session                             │
│                                                               │
│  Material Pipeline     Platform Publisher     Approval Gate    │
│       │                        │                   │            │
│       ▼                        ▼                   │            │
│  Providers              BrowserProvider ◄────────┘            │
│       │                        │                                │
│       ▼                        ▼                                │
│   AssetStore            Chromium / CDP                         │
│                                                               │
│  SQLite: jobs / checkpoints / actions / evidence              │
└───────────────────────────────────────────────────────────────┘
```

The application remains one Node.js deployable for the MVP. Module boundaries are code boundaries, not service boundaries.

## 5. Module layout

Target layout:

```text
src/
├─ app/
│  ├─ config.ts
│  └─ bootstrap.ts
├─ api/
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
│  ├─ runtime.ts
│  ├─ pi-agent-runtime.ts
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

web/
docker/
├─ browser-runtime/
│  ├─ Dockerfile
│  └─ entrypoint.sh
└─ compose/
   └─ docker-compose.yml
```

Do not create all files merely to match the diagram. Add modules as the implementation reaches them.

## 6. Core contracts

### 6.1 AgentRuntime

The product must not depend directly on one agent framework.

```ts
interface AgentRuntime {
  start(input: AgentRunInput): Promise<AgentRunResult>;
  resume(runId: string, input?: AgentResumeInput): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
}
```

The first adapter is `PiAgentRuntime`.

DeepSeek Harness remains a future alternate adapter. Product-domain code must not import framework-specific session or tool types.

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

Platform skills receive a Playwright `Page`-level abstraction and do not issue raw CDP commands for normal work.

### 6.3 PlatformPublisher

```ts
interface PlatformPublisher {
  prepare(job: PublishJob, session: BrowserSession): Promise<PreparedPublication>;
  verifyPrepared(input: PreparedPublication): Promise<PreparedVerification>;
  publish(input: ApprovedPublication): Promise<PublishAttempt>;
  verifyResult(input: PublishAttempt): Promise<PublicationEvidence>;
}
```

The first implementation is `XiaohongshuPublisher`.

### 6.4 Material providers

```ts
interface TextProvider {
  generate(plan: TextPlan): Promise<TextMaterial>;
}

interface ImageProvider {
  generate(plan: ImagePlan): Promise<ImageAsset[]>;
}

interface DesignProvider {
  render(plan: DesignPlan): Promise<Asset[]>;
}

interface VideoProvider {
  generate(plan: VideoPlan): Promise<VideoAsset>;
}
```

Concrete vendors are intentionally deferred. Provider unavailability must be explicit.

### 6.5 AssetStore

```ts
interface AssetStore {
  put(input: AssetInput): Promise<Asset>;
  resolve(assetId: string): Promise<ResolvedAsset>;
  delete(assetId: string): Promise<void>;
}
```

MVP implementation: local volume-backed store.

Future implementations may use OSS or R2 without changing the material pipeline.

## 7. Orchestration model

There is one Orchestrator and two role sessions.

```text
Orchestrator
├─ Content Secretary session
└─ Publishing Secretary session
```

The role sessions are not autonomous peers. The Orchestrator owns phase transitions, checkpoints, approval gates, and retry policy.

### 7.1 Agent responsibilities

Agent/model reasoning is allowed for:

- brief interpretation;
- MaterialPlan creation;
- copy generation/adaptation;
- bounded browser-state interpretation;
- bounded recovery from an unexpected UI state;
- deciding that human takeover is safer.

### 7.2 Deterministic responsibilities

Normal browser execution is deterministic:

- open publishing entry;
- detect expected login state;
- upload files;
- fill known fields;
- wait for processing;
- read back values;
- stop for approval;
- click the approved publish action once;
- verify result.

The normal path must not be implemented as a free-running instruction such as "publish this post".

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

- the current deterministic step stops;
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

The Xiaohongshu skill owns platform-specific behavior.

Normal deterministic path:

1. navigate to the supported publishing entry;
2. classify login state;
3. choose 图文 or 视频 according to the job;
4. upload prepared media;
5. wait for upload/processing completion;
6. fill title/body/tags;
7. read back the effective form values;
8. validate against the prepared publication;
9. pause for approval;
10. publish once after approval;
11. verify resulting platform state;
12. record evidence.

Selectors belong under the Xiaohongshu module. They must not leak into the Orchestrator.

### 14.1 Recovery boundary

Bounded agent recovery may:

- inspect text/DOM/accessibility information;
- interpret changed labels;
- find a semantically equivalent control;
- interpret an unexpected dialog;
- recommend human takeover;
- return a candidate locator/next safe action.

Recovery must not:

- publish without approval;
- repeatedly click possible publish buttons;
- alter accepted user content merely to get through the flow;
- bypass identity/risk controls;
- retry an uncertain publish side effect.

If recovery cannot confidently return to the deterministic path, create a human action or fail visibly.

## 15. Material pipeline

```text
CreativeBrief
  ↓
MaterialPlan
  ↓
TextProvider ─────┐
ImageProvider ────┼─→ MaterialPack
DesignProvider ───┤
VideoProvider ────┘
  ↓
Platform Adapter
  ↓
XiaohongshuPack
```

### 15.1 Reliability rule

For MVP:

> video is additive; text + image is the dependable baseline.

A provider failure is local to that material item whenever possible.

Material item status:

```text
planned
generating
ready
failed
rejected
```

Material pack status:

```text
ready
ready_with_degradation
```

The user-selected publish mode still governs whether a degraded pack is publishable. Do not silently convert a requested video publication into an image/text publication without surfacing that decision.

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
- runtime adapter
- provider/model credentials by environment

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
- local asset storage.

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

3. **Xiaohongshu deterministic pre-publish path**
   - login detection;
   - QR/human takeover;
   - upload;
   - fill;
   - prepared-form verification;
   - stop before publish.

4. **Approval + publish-once + evidence**
   - approval action;
   - external action record;
   - one publish action;
   - verification.

5. **Material providers / agent enhancement**
   - real TextProvider/ImageProvider;
   - optional video;
   - bounded recovery;
   - PiAgent adapter where it materially helps.

The first demo should not wait for a sophisticated material-provider matrix. A controlled MaterialPack fixture is acceptable while proving the browser/publish risk.

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
- Deterministic path first; agent recovery second.
- Checkpoint every meaningful boundary.
- Human identity proof is part of the product.
- Publish is a side effect, not just another tool call.
- One browser session is enough for the MVP.
- Local and Docker modes share the same product core.
- Browser runtime is replaceable behind BrowserProvider.
- Provider implementations are replaceable behind capability contracts.
- Do not generalize beyond evidence from the first working Xiaohongshu loop.
