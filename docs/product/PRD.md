# Agent Publisher PRD

Status: active product baseline  
Phase: POC / MVP

This document is the repository's canonical product definition for Agent Publisher. It owns product intent, user-facing scope, MVP boundaries, core interaction model, and durable product decisions.

It does **not** replace GitHub Issues as the contract for individual work items, Project Status as lifecycle state, or code/configuration as current technical reality.

## 1. Product statement

Agent Publisher is a small, real product for agent-assisted content production and browser-based publishing.

A user provides a publishing intent or source material. The system prepares platform-appropriate content and media, operates an authenticated browser session, asks the user to complete identity verification when required, prepares the target platform's publish form, requests approval before irreversible publication, publishes, and records evidence of the result.

The POC is deliberately not a general-purpose browser agent.

## 2. MVP user outcome

For the first supported platform, a user can:

1. enter a topic, short brief, or source content;
2. generate/edit the title, body, tags, and required media;
3. reuse an existing authenticated browser profile;
4. hand browser control to the user when login/MFA/device verification is required;
5. have the system prepare the complete publish form automatically;
6. review the prepared post;
7. explicitly approve publication;
8. receive a clear success/failure result with evidence.

## 3. Initial platform order

1. Xiaohongshu — first end-to-end MVP target.
2. Douyin — second platform after the first flow is stable.
3. WeChat Official Accounts — third platform.

The architecture may expose a platform contract from the start, but the MVP must not delay Xiaohongshu delivery in order to implement all three platforms.

## 4. Core product flow

```text
intent / source
    ↓
material preparation
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

## 5. Product model

### Publish Job

A Publish Job represents one requested publishing outcome.

Suggested lifecycle:

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

### Identity / Browser Profile

Login state belongs to a reusable identity/browser profile rather than to one Publish Job.

A profile may be reused by many jobs for the same authorized account. Passwords are not a product requirement.

### Platform Publisher

Platform behavior is isolated by platform.

Each implementation owns platform-specific navigation, selectors, upload behavior, publish-form preparation, publish action, and result verification.

### Material Provider

Text, image, and video production are capabilities, not reasons to rebuild model infrastructure.

The POC should integrate existing model/media providers where practical.

### Approval Gate

External irreversible actions are gated by explicit user approval by default.

Identity verification and publish approval are separate interactions.

### Evidence

A successful automation run is not sufficient evidence of publication. The product should capture the strongest practical evidence available, such as resulting URL, post identifier, confirmation state, or screenshot.

## 6. Architecture baseline

The initial engineering baseline is:

- Node.js + TypeScript;
- Playwright for deterministic browser automation;
- local Playwright browser runtime first if it is the fastest path;
- browser provider abstraction so a self-hosted or managed cloud browser can replace the runtime later;
- React + Vite for a minimal operator UI when a UI is needed;
- SQLite is sufficient for POC task/profile metadata;
- no Redis, distributed queue, or microservice split unless the POC proves a concrete need.

Core contracts:

```text
PublishJob
MaterialProvider
BrowserProvider
PlatformPublisher
ApprovalGate
EvidenceStore
```

Agent/model reasoning is a capability used inside the flow, not a mandatory top-level architecture layer.

Known, repeatable browser steps should remain deterministic. Agent/model recovery is appropriate when page structure or content requires interpretation.

## 7. MVP scope

### In scope

- one real Xiaohongshu image/text publishing path;
- persistent login state/profile reuse;
- manual takeover for identity verification;
- title/body/tags/media preparation;
- automatic publish-form filling;
- explicit approval before publish;
- publication result verification/evidence;
- one operator at a time is sufficient.

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
- rebuilding image/video/model infrastructure already available from external providers.

## 8. Safety and trust boundaries

- Never commit or intentionally log account credentials, cookies, storage state, browser profiles, tokens, or QR-login artifacts.
- Prefer user-mediated authentication and persistent browser state over password custody.
- When a platform asks the user to prove identity, the system should hand control to the authorized user rather than bypass the check.
- Publish/delete/overwrite actions are explicit side effects and require an approval policy.
- Browser traces, screenshots, recordings, and downloaded artifacts may contain sensitive information and must be handled accordingly.

## 9. MVP success criteria

The MVP is established when the team can demonstrate the following real flow on the agreed test account:

> Given a short content brief, Agent Publisher prepares a Xiaohongshu post, reuses or obtains an authenticated browser session, fills the real publish form, waits for explicit approval, publishes successfully, and records verifiable result evidence.

The result must be verified on the real platform. A passing unit test, browser script, or CI run alone does not satisfy this product criterion.

## 10. Product principles

- Small and real beats broad and conceptual.
- Reuse before rebuild.
- Deterministic automation before unnecessary model reasoning.
- Human identity proof is a first-class interaction, not an exception to hide.
- Explicit approval belongs at irreversible boundaries, not on every browser click.
- First prove one platform end to end; then generalize what actually repeats.
