# AGENTS.md

## Organization Governance

This repository is governed by the current `sanchuang-dev/.github/AGENTS.md` plus the repository-specific rules below.

For work-item lifecycle, source-of-truth, environment promotion, testing, permissions, and Organization AI Review, load the current Organization guidance when those concerns apply.

GitHub Project lifecycle (`Todo -> In Progress -> Done`) is management state only and is separate from branch/environment position.

## Product and Safety Boundary

Agent Publisher is a company POC for agent-assisted content preparation and publishing.

The system may prepare content, operate authenticated browser sessions, fill publish forms, and retain evidence. It must preserve explicit human control around identity verification and irreversible publication.

Do not:

- design around bypassing CAPTCHA, MFA, platform risk controls, or identity checks;
- store raw account passwords when persistent authenticated profiles or other safer session mechanisms are available;
- silently publish, delete, or materially alter external content without authority defined by the current task/approval contract;
- infer publication success from a local action alone when platform/runtime evidence can verify the result.

## Architecture Boundary

Prefer:

```text
intent/source
  -> content preparation
  -> platform adapter / skill
  -> authenticated browser/runtime
  -> human verification/approval when required
  -> external side effect
  -> evidence
```

Keep platform-specific browser logic isolated behind adapters/skills.

Use deterministic automation for stable interaction mechanics. Use model/agent reasoning only where it materially reduces brittle hard-coded logic.

Do not turn the POC into a general-purpose browser agent unless the product contract explicitly changes.

## Branch / Environment Policy

The repository follows the Organization default:

```text
feat/* -> dev -> test -> prod
```

- `dev`: normal integration branch and normal base for feature work.
- `test`: acceptance/regression promotion stage.
- `prod`: production/release source.
- `main`: landing/governance branch; not a production environment.

Do not bypass `prod` for production release semantics.

## Change Policy

- Read the current Issue/task contract and relevant implementation before editing.
- Keep changes small, coherent, and reversible.
- Preserve platform/session/publishing boundaries unless the accepted contract changes them.
- Avoid broad framework, browser-runtime, or dependency upgrades unless they are required by the task.
- Treat retries, duplicate submissions, idempotency, account/session state, and partial publication failure as first-class concerns for side-effecting flows.

## Verification

Match evidence to the claim.

For ordinary logic, focused tests may be sufficient. For browser/publishing flows, evidence may require:

- deterministic tests of adapter logic;
- browser/session integration checks;
- platform form-state verification;
- explicit human verification when identity/risk controls intervene;
- proof of external publish/delete outcome when the task claims it;
- duplicate/retry and failure-path checks where side effects are possible.

Do not call a publish flow verified merely because Playwright completed without throwing.

## Secrets and Sensitive State

Never print or reproduce API keys, browser-profile secrets, session cookies, tokens, credentials, or provider secrets in reports, Issues, PR text, AI Review output, or logs.

Authenticated browser profiles and session state are sensitive even when they do not contain a raw password.

PR-controlled code must not receive reviewer/provider credentials.

## AI Review

Repository-specific review focus lives in `.github/ai-review/profile.md`.

Organization AI Review is advisory and read-only. It must not publish content, mutate external platforms, merge, accept work, close Issues, or change Project state.
