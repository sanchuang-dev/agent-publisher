# Agent Publisher PRD

Status: active product baseline  
Phase: POC / MVP

This document is the repository's canonical product definition for Agent Publisher. It owns durable product intent, user-facing scope, MVP boundaries, interaction model, core architecture decisions, and product reliability requirements.

It does **not** replace GitHub Issues as the contract for individual work items, Project Status as lifecycle state, or code/configuration/runtime as current technical reality.

Frontend interaction and prototype details are defined in [FRONTEND.md](./FRONTEND.md).

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

These are product roles, not a requirement for two independent agent runtimes.

The MVP architecture uses **one Orchestrator with two role sessions** rather than two isolated agent systems.

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

### Runtime abstraction

Business code should depend on an internal `AgentRuntime` contract rather than one framework's API.

The MVP framework preference is:

1. **PiAgent / AgentHarness** — primary MVP candidate for stability and fast integration.
2. **DeepSeek Harness (DSH)** — active alternative and future candidate.

Framework choice must remain replaceable behind the runtime adapter.

### Orchestration model

Use:

> one Orchestrator + Content Secretary role session + Publishing Secretary role session

Do not build a multi-agent organization merely because the product exposes two worker roles.

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

Use a BrowserProvider boundary so the runtime may be:

- local Playwright;
- self-hosted browser worker;
- managed/cloud browser;
- remote CDP-compatible browser.

Platform skills should depend on browser/session capabilities rather than deployment location.

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

## 12. MVP scope

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

## 13. Safety and trust boundaries

- Never commit or intentionally log account credentials, cookies, storage state, browser profiles, tokens, or QR-login artifacts.
- Prefer user-mediated authentication and persistent browser state over password custody.
- When a platform asks the user to prove identity, the system should hand control to the authorized user rather than bypass the check.
- Publish/delete/overwrite actions are explicit side effects and require an approval policy.
- Browser traces, screenshots, recordings, and downloaded artifacts may contain sensitive information and must be handled accordingly.
- Human approval and resume logic must not accidentally repeat an already-completed irreversible action.

## 14. MVP success criteria

The MVP is established when the team can demonstrate the following real flow on the agreed test account:

> Given a short brief and a selected 图文 or 视频 mode, Agent Publisher prepares usable material, reuses or obtains an authenticated Xiaohongshu browser session, fills the real publish form, pauses for human identity verification when necessary, waits for explicit publish approval, publishes once, and records verifiable result evidence.

For the MVP, text + image output must remain dependable even if video generation is unavailable or degraded.

The result must be verified on the real platform. A passing unit test, browser script, or CI run alone does not satisfy this product criterion.

## 15. Product principles

- Small and real beats broad and conceptual.
- Reuse before rebuild.
- Stability before maximum autonomy.
- Deterministic automation before unnecessary model reasoning.
- AI employees are a product interaction model, not an excuse for unnecessary multi-agent complexity.
- Human identity proof is a first-class interaction, not an exception to hide.
- Explicit approval belongs at irreversible boundaries, not on every browser click.
- Material generation and platform execution remain separate concerns.
- Video is additive; text + image is the dependable baseline.
- First prove one platform end to end; then generalize what actually repeats.
