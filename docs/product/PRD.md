# Agent Publisher PRD

Status: active product baseline  
Phase: POC / MVP

This document is the repository's canonical product definition for Agent Publisher. It owns durable product intent, user-facing scope, MVP boundaries, interaction model, core architecture decisions, and product reliability requirements.

It does **not** replace GitHub Issues as the contract for individual work items, Project Status as lifecycle state, or code/configuration/runtime as current technical reality.

Frontend interaction and prototype details are defined in [FRONTEND.md](./FRONTEND.md).

Implementation architecture and runtime design are defined in [TECHNICAL-DESIGN.md](../engineering/TECHNICAL-DESIGN.md).

## 1. Product statement

Agent Publisher is a small, real product for agent-assisted content production and browser-based publishing.

The core user feeling should be:

> I assigned work to AI employees, and they are doing the job for me.

It is deliberately **not** a general-purpose browser agent, chat application, prompt playground, or traditional admin dashboard.

The user delegates a publishing task, supervises progress, intervenes only when identity verification or clarification is required, approves irreversible publication, and receives verifiable delivery evidence.

## 2. Visible AI worker model

The product exposes two user-facing worker roles.

### Content Secretary

Responsible for:

- understanding the publishing brief;
- planning the material package;
- generating/adapting copy;
- generating images;
- generating video when requested;
- preparing title, tags, cover, and platform-ready material.

### Publishing Secretary

Responsible for:

- opening the target publishing environment;
- checking login/session state;
- operating the browser;
- uploading material;
- filling platform forms;
- requesting human takeover for identity verification;
- performing pre-publish checks;
- requesting approval;
- publishing after approval;
- collecting result evidence.

These are product roles, not a requirement for two independent autonomous agent runtimes.

The MVP keeps **one Publisher Orchestrator** as the business control owner. It may create isolated agent sessions for the Content Secretary, Publishing Secretary, or a bounded helper such as browser recovery when reasoning is actually needed. Those sessions are execution resources owned by the Orchestrator, not autonomous peers that delegate the Publish Job among themselves.

Reusable agent configuration and per-job agent state are separate concerns: an agent definition may be reused across many jobs, while task conversation/context must remain isolated by job/role (or a narrower helper-task scope).

## 3. MVP user outcome

For the first supported platform, a user can:

1. enter a topic, short brief, source content, link, or source material;
2. choose a publishing form: **图文** or **视频**;
3. have the Content Secretary produce a usable material package;
4. reuse an existing authenticated browser profile;
5. hand browser control to the user when login/MFA/device verification is required;
6. have the Publishing Secretary prepare the real publish form automatically;
7. review the prepared post;
8. explicitly approve publication;
9. receive a clear success/failure result with evidence.

## 4. Initial platform and content priorities

Platform order:

1. Xiaohongshu — first end-to-end MVP target.
2. Douyin — second platform after the first flow is stable.
3. WeChat Official Accounts — third platform.

Content priority:

- **B target:** text + images + video.
- **A reliability baseline:** text + images must remain usable even when video generation fails.

The MVP must not delay the Xiaohongshu end-to-end flow in order to support all three platforms or perfect video generation.

## 5. Core product flow

```text
task brief / source
    ↓
user chooses 图文 or 视频
    ↓
Content Secretary
    ↓
MaterialPlan
    ↓
material providers
    ↓
MaterialPack
    ↓
platform adaptation
    ↓
Publishing Secretary
    ↓
browser profile/session
    ↓
platform publish skill
    ↓
human takeover if identity verification is required
    ↓
prepared publish form
    ↓
explicit publish approval
    ↓
publication
    ↓
result evidence
```

## 6. Product model

### Publish Job

A Publish Job represents one requested publishing outcome.

Baseline lifecycle:

```text
created
  ↓
preparing_materials
  ↓
waiting_for_login        (when required)
  ↓
preparing_publish
  ↓
waiting_for_approval
  ↓
publishing
  ↓
succeeded | failed
```

Every externally meaningful step should be resumable where practical.

### Identity / Browser Profile

Login state belongs to a reusable identity/browser profile rather than to one Publish Job.

A profile may be reused by many jobs for the same authorized account. Password custody is not a product requirement.

### MaterialPlan

Before generation, the Content Secretary creates a bounded plan describing what should be produced for the selected mode.

Example:

```text
图文
- title
- body
- tags
- cover
- 6 images

视频
- title
- body
- tags
- cover
- video
- optional supporting images
```

The user selects the publishing form. The secretary plans **within that mode**.

### MaterialPack

The material layer produces a reusable package before platform publication.

Baseline shape:

```text
MaterialPack
├─ copy
│  ├─ title
│  ├─ body
│  └─ tags[]
├─ images[]
├─ cover?
└─ video?
```

The package should support platform adaptation rather than mixing platform browser logic into material generation.

### Platform Publisher

Platform behavior is isolated by platform.

Each implementation owns platform-specific navigation, selectors, upload behavior, publish-form preparation, publish action, and result verification.

### Approval Gate

External irreversible actions are gated by explicit user approval by default.

Identity verification and publish approval are separate interactions.

### Evidence

A successful automation run is not sufficient evidence of publication.

The product should capture the strongest practical evidence available, such as:

- resulting URL;
- post/content identifier;
- platform confirmation state;
- final screenshot;
- completion timestamp.

## 7. Material generation architecture

Material generation is a pipeline, not one monolithic model call.

```text
CreativeBrief
    ↓
MaterialPlan
    ↓
TextProvider
ImageProvider
DesignProvider
VideoProvider
    ↓
MaterialPack
    ↓
Platform Adapter
```

Provider responsibilities:

- **TextProvider** — title, body, tags, script/copy.
- **ImageProvider** — original visual assets.
- **DesignProvider** — template/layout/cover composition such as Canva or another renderer.
- **VideoProvider** — generated video such as an external video model.

Canva, image models, and video models are provider implementations, not core product dependencies.

Concrete vendor selection is intentionally deferred for the MVP. Keep provider slots for `TextProvider`, `ImageProvider`, `DesignProvider`, and `VideoProvider`. Unconfigured providers should report capability unavailable instead of forcing early vendor lock-in.

### Graceful degradation

Video is an enhancement, not a hard dependency for the MVP.

If video generation fails while text and images are ready, the job may continue as a usable image/text package when the selected task allows that fallback.

Material items should be independently retryable rather than forcing whole-pack regeneration.

Suggested item states:

```text
planned
generating
ready
failed
rejected
```

Suggested pack readiness:

```text
ready
ready_with_degradation
```

## 8. Agent orchestration

### Harness baseline

The MVP uses the **Pi ecosystem as the preferred embedded agent harness**. The first implementation should evaluate the embeddable `@earendil-works/pi-coding-agent` SDK before Publisher builds harness features around the lower-level Agent Core alone.

Publisher should reuse mature Pi capabilities for session execution, tools, skills, resource loading, model/runtime integration, events, and context compaction where they satisfy the product boundary.

DeepSeek Harness remains an experimental/future migration candidate rather than a parallel MVP baseline.

### Reusable definitions, isolated sessions

Publisher should represent a class of agent work as a reusable definition containing the relevant model policy, system instructions, skills, tools, MCP profile, context policy, and session policy.

A definition may create many independent sessions:

```text
Content Secretary definition
├─ session for Job A
├─ session for Job B
└─ session for Job C
```

The reusable definition is not a singleton conversation. Job-specific transcript, dynamic context, temporary tool grants, and observations must not leak across unrelated jobs.

Pi session history supports agent continuity; **Publisher SQLite remains the source of truth for Job state, checkpoints, human actions, approvals, publication side effects, and evidence.**

### Skills, tools, MCP, and context

- Skills should use the existing Agent Skills / Pi skill mechanism instead of a Publisher-specific skill format.
- Tools should use Pi's tool registration/selection/interception mechanisms. Each session receives only the tools appropriate to its role and current task.
- MCP is an external capability source and should be integrated through a mature Pi-compatible adapter/extension before considering a custom MCP runtime.
- Publisher owns which MCP servers/tools are configured and allowed; the service must not inherit arbitrary developer-machine MCP configuration.
- Stable role instructions belong in controlled system resources/skills. Job brief/material/browser observations are dynamic session context or tool results.
- Irreversible publication is not exposed as a generic model tool. Approval and publish-once remain deterministic Publisher-owned workflow steps.

### Orchestration model

Use:

> one Publisher Orchestrator + orchestrator-owned agent sessions created only when reasoning is useful

The product still exposes Content Secretary and Publishing Secretary as its two worker roles. An implementation may use additional bounded helper sessions, such as browser recovery, without becoming an autonomous multi-agent organization.

Agent sessions do not own phase transitions, checkpoints, approval gates, retry authority for irreversible side effects, or Job completion.

### Deterministic first

Known, repeatable browser and workflow steps should be deterministic.

Use agent/model reasoning for bounded work such as:

- understanding a brief;
- generating a MaterialPlan;
- generating/adapting copy;
- interpreting uncertain page state;
- recovery from unexpected browser/UI changes;
- deciding a safe next step after bounded failure.

Do **not** require model reasoning for every browser click.

### Human action protocol

All human intervention should use a unified action-required model.

Baseline reasons:

```text
login_required
approval_required
clarification_required
```

The job pauses, records the required action, and resumes from a checkpoint after the user responds.

## 9. Reliability model

MVP reliability has priority over maximum autonomy.

The guiding rule is:

> 失败可见、可恢复、可降级、不可重复副作用。

### Checkpointed execution

The workflow should behave as a checkpointed state machine rather than a one-shot agent run.

Representative steps:

```text
generate_copy
generate_images
generate_video
open_platform
ensure_login
upload_assets
fill_form
wait_approval
publish
verify
```

### Re-entrant steps

Before executing a step, the system should check whether the required state is already satisfied when practical.

Examples:

- do not upload the same asset again after resume if upload already succeeded;
- do not publish again after a successful irreversible publish;
- do not regenerate accepted material merely because another provider failed.

### Fallback expectations

External capabilities should fail independently where possible.

Examples:

- video provider fails → preserve usable text/image output;
- design provider fails → retain basic image assets when acceptable;
- browser recovery fails → request human takeover;
- managed browser unavailable → allow another BrowserProvider where supported;
- primary model provider unavailable → runtime may use an approved fallback provider.

Fallback must not silently change user intent or repeat irreversible external side effects.

## 10. Runtime portability

The product must remain practical for:

- macOS local development;
- Windows local development;
- self-hosting on Alibaba Cloud or a similar VM/container environment;
- potential Cloudflare deployment for compatible components.

### Browser portability

Core product logic must not own one specific Chrome installation.

The first MVP implementation is a DevTools/CDP-backed BrowserProvider. It attaches to an already-running Chromium-family browser with Playwright `connectOverCDP()`, while platform skills continue to use Playwright Page/Locator APIs rather than raw CDP commands. This makes existing login state and visible human takeover easy to reuse.

The BrowserProvider contract must still allow later alternatives such as a Playwright-managed browser/server, self-hosted browser worker, managed cloud browser, or another remote CDP-compatible browser. Platform skills depend on browser/session capabilities rather than deployment location or a hard-coded executable path.

### Asset portability

Generated files should be represented as assets rather than raw machine-specific paths.

Use an AssetStore boundary.

Possible implementations:

- local filesystem for development;
- Alibaba Cloud OSS for self-hosting;
- Cloudflare R2 for Cloudflare-compatible deployment.

The POC should avoid architecture that requires local persistent filesystem semantics everywhere.

## 11. Engineering baseline

Current baseline:

- Node.js + TypeScript;
- Playwright for deterministic browser automation;
- React + Vite for the operator UI;
- Material Design 3 as the frontend design-system baseline;
- SQLite is sufficient for POC task/profile metadata;
- no Redis, distributed queue, or microservice split unless a concrete need is proven;
- external AI/media services are preferred over rebuilding model infrastructure.

Frontend interaction specifics remain in [FRONTEND.md](./FRONTEND.md).

### SQLite persistence design

SQLite is the MVP source of truth for task execution and resume state.

Baseline tables:

```text
jobs
job_steps
action_requests
browser_profiles
assets
evidence
external_actions
```

- `jobs`: job identity, platform, 图文/视频 mode, status/current step, profile reference, brief/material summary, timestamps, optimistic version.
- `job_steps`: checkpointed step execution, attempts, idempotency key, input/output/error summary, timestamps.
- `action_requests`: login, approval, and clarification requests plus resolution state.
- `browser_profiles`: provider/profile reference, platform/account label, session health metadata, last verified time. Keep browser secrets outside ordinary product tables.
- `assets`: material references, type, URI, MIME/metadata, checksum/status.
- `evidence`: result URL/content ID/screenshot or other verification references.
- `external_actions`: irreversible external actions with a unique action key and states such as `prepared | started | succeeded | unknown | failed`.

Enable foreign keys, use WAL mode for the local app, set a practical busy timeout, and commit checkpoint/state changes transactionally.

If an irreversible action reaches an uncertain result, move to verification/recovery before any retry. Do not repeat the action until duplicate effects have been ruled out.

## 12. Xiaohongshu MVP skill boundary

The Xiaohongshu publisher is a bounded platform skill.

Deterministic automation owns the normal path:

1. open the publishing entry;
2. detect authenticated session state;
3. select 图文 or 视频 from the job;
4. upload prepared assets;
5. fill known fields;
6. wait for uploads/processing;
7. read back and validate the prepared form;
8. pause for publish approval;
9. execute the approved publish action once;
10. verify the result and capture evidence.

Agent reasoning is reserved for bounded recovery when the deterministic path fails, such as interpreting changed labels, unexpected dialogs, relocated controls, or deciding that human takeover is safer. Recovery should prefer inspection before mutation.

The recovery path may not change accepted content without user intent, publish without approval, or repeat a publication whose previous result is uncertain. When recovery cannot confidently restore the known path, transition to human takeover or a visible failure state.

## 13. MVP scope

### In scope

- one real Xiaohongshu publishing path;
- user-selectable 图文 / 视频 mode;
- stable text + image material generation;
- video generation as an enhancement;
- persistent login state/profile reuse;
- manual takeover for identity verification;
- automatic publish-form filling;
- explicit approval before publish;
- publication result verification/evidence;
- one operator at a time is sufficient;
- resumable task state where practical.

### Out of scope for MVP

- general-purpose autonomous browsing;
- multi-account content farms or account matrices;
- CAPTCHA/MFA/risk-control bypass;
- high-frequency automated posting;
- workflow builders;
- distributed job infrastructure;
- scheduling;
- analytics dashboards;
- full support for Xiaohongshu, Douyin, and WeChat in the same first increment;
- rebuilding image/video/model infrastructure already available from external providers;
- making DSH/PiAgent concepts visible to end users;
- full autonomous decision-making about whether the user wants 图文 or 视频.

## 14. Safety and trust boundaries

- Never commit or intentionally log account credentials, cookies, storage state, browser profiles, tokens, or QR-login artifacts.
- Prefer user-mediated authentication and persistent browser state over password custody.
- When a platform asks the user to prove identity, the system should hand control to the authorized user rather than bypass the check.
- Publish/delete/overwrite actions are explicit side effects and require an approval policy.
- Browser traces, screenshots, recordings, and downloaded artifacts may contain sensitive information and must be handled accordingly.
- Human approval and resume logic must not accidentally repeat an already-completed irreversible action.

## 15. MVP success criteria

The MVP is established when the team can demonstrate the following real flow on the agreed test account:

> Given a short brief and a selected 图文 or 视频 mode, Agent Publisher prepares usable material, reuses or obtains an authenticated Xiaohongshu browser session, fills the real publish form, pauses for human identity verification when necessary, waits for explicit publish approval, publishes once, and records verifiable result evidence.

For the MVP, text + image output must remain dependable even if video generation is unavailable or degraded.

The result must be verified on the real platform. A passing unit test, browser script, or CI run alone does not satisfy this product criterion.

## 16. Product principles

- Small and real beats broad and conceptual.
- Reuse before rebuild.
- Stability before maximum autonomy.
- Deterministic automation before unnecessary model reasoning.
- AI employees are a product interaction model, not an excuse for unnecessary autonomous multi-agent complexity.
- Reuse mature agent-harness capabilities before inventing Publisher-specific registries, session managers, or protocol runtimes.
- Reuse agent definitions across jobs, but isolate task sessions and keep business truth outside model conversation state.
- Human identity proof is a first-class interaction, not an exception to hide.
- Explicit approval belongs at irreversible boundaries, not on every browser click.
- Material generation and platform execution remain separate concerns.
- Video is additive; text + image is the dependable baseline.
- First prove one platform end to end; then generalize what actually repeats.
