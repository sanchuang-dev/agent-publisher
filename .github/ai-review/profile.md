# AI Review Profile — Agent Publisher

Organization policy: `sanchuang-ai-review-policy/v1`.

## Repository contract

Agent Publisher is a Node.js + TypeScript POC using Playwright for authenticated, browser-based content publishing.

Normal verification command:

```bash
npm run check
```

This runs TypeScript type checking plus the repository test suite.

## Review focus

Prioritize high-confidence regressions introduced or materially worsened by the PR in:

- publication approval boundaries and irreversible external side effects;
- duplicate posts, retries, idempotency, and partial-success handling;
- authenticated browser/session state;
- accidental logging, persistence, or exposure of cookies, storage state, browser profiles, credentials, API keys, tokens, QR artifacts, screenshots, traces, or recordings;
- MFA/CAPTCHA/device-verification flows that incorrectly attempt bypass rather than human handoff;
- platform adapter isolation and cross-platform behavior leakage;
- Playwright synchronization that can publish against stale/wrong page state;
- incorrect success detection where a local click is treated as proof of external publication;
- account/platform mix-ups that could publish to the wrong destination;
- unsafe delete/overwrite operations;
- provider/model integration that exposes reviewer or production credentials to PR-controlled code.

## Delta-first rule

Review the PR delta first.

Existing POC limitations, unsupported platforms, legacy selectors, or incomplete product scope are not blocking findings unless the PR introduces or materially worsens a defect against the current task/repository contract.

## Validation gaps

Treat these as validation gaps unless the contract explicitly requires them and evidence establishes a defect:

- real platform login/account availability;
- CAPTCHA/MFA/SSO/device verification;
- live Xiaohongshu, Douyin, or WeChat behavior;
- account-specific anti-automation/risk controls;
- visual correctness requiring human inspection;
- external publication confirmation unavailable to CI;
- provider/network behavior unavailable to the review runtime.

A green `npm run check` does not prove that a real external post was published correctly.

## Secrets

Never reproduce a secret value, cookie, token, browser-profile artifact, or session material in review output.

Describe only the class of sensitive material, exposure path, affected location, impact, and remediation direction.
