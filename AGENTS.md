# AGENTS.md

## Organization Governance

This repository is governed by the current `sanchuang-dev/.github/AGENTS.md` plus the repository-specific rules below.

Load the current Organization policy when work touches work items, environment promotion, testing, permissions, or AI Review.

## Product Contract

`docs/product/PRD.md` is the canonical repository product definition for durable product intent, MVP boundaries, interaction model, and product decisions.

It does not replace:

- GitHub Issues as individual work-item contracts and outcome records;
- Project Status as lifecycle projection;
- code/configuration/runtime as current technical reality.

When a current Issue intentionally changes product behavior, update the PRD when that decision becomes durable rather than maintaining contradictory product rules.

## Repository Role

`agent-publisher` is a company POC for agent-assisted content production and browser-based publishing.

The initial product target is a small, real publishing loop across Xiaohongshu, Douyin, and WeChat Official Accounts. Xiaohongshu is the first MVP path. Do not expand the project into a general-purpose browser agent unless an explicit task changes that boundary.

## Branch / Environment Policy

The active flow is:

```text
feat/* -> dev -> test -> prod
```

- `dev`: normal integration base for engineering work.
- `test`: acceptance and smoke verification.
- `prod`: production source if/when a production deployment is introduced.
- `main`: landing/governance branch only; it is not an environment and must not bypass `prod`.

## Architecture Baseline

- Node.js + TypeScript.
- Playwright is the browser execution substrate behind `BrowserProvider` and restricted browser tools; it does not own publishing-path decisions.
- For each Publish Job, the Publishing Secretary owns task-local browser execution: `observe → plan → act → observe/recover` against the current page state.
- The Publisher Orchestrator deterministically owns business control: Job state/checkpoints, browser-control grants, identity handoff, prepared readback/validation, approval, publish-once, and verify-first recovery for uncertain irreversible side effects.
- Keep browser runtime/provider concerns behind an adapter so local, self-hosted, and managed browsers can be swapped during the POC.
- Platform Skills/adapters provide platform knowledge, success conditions, known affordances, and prohibited actions. Locator hints may be reused, but a fixed selector sequence is not the product execution contract.
- Final irreversible publication is not exposed as an ordinary Agent browser tool; it remains behind Publisher-owned approval and side-effect governance.
- Reuse external AI/media capabilities instead of rebuilding image, video, or model infrastructure during the POC.

## Identity and Side Effects

- Do not commit or log passwords, cookies, browser profiles, storage state, tokens, QR-login artifacts, or other session credentials.
- Prefer persistent browser profile/session state over storing raw passwords.
- MFA, CAPTCHA, SSO, device verification, and similar identity checks should hand control to the authorized human; do not build bypass mechanisms.
- Publishing, deleting, overwriting, or otherwise causing an external irreversible side effect requires explicit approval by default unless the current task contract grants a narrower automation policy.
- Treat screenshots, traces, recordings, downloaded files, and browser artifacts as potentially sensitive.

## Verification

Match evidence to the claim.

- Pure orchestration/contract logic: focused automated tests are usually sufficient.
- Browser flow changes: verify against the actual supported page/runtime when practical.
- Authentication/session changes: require stronger evidence and never expose credential material.
- A successful script or CI run is not evidence that an external post was published; verify the resulting platform state when publication is part of the claim.
- Record external-service or account-access gaps explicitly instead of guessing.

## POC Discipline

Prefer the smallest coherent change that proves the next product risk. Reuse working libraries and services where their license and operational boundary are acceptable. Avoid speculative abstractions that do not help the current publishing loop.


## AI Review

Repository-specific review focus lives in `.github/ai-review/profile.md`.

Organization AI Review is advisory and read-only. It must not execute PR-controlled code, publish content, mutate external platforms, merge, accept work, close Issues, or change Project state.

A green AI Review is evidence only; it is not product acceptance or release authority.
