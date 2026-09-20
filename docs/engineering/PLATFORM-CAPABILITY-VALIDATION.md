# Platform capability validation — SPIKE-01

Issue: #34 — 三平台发布能力与真实账号权限验证  
Validation date: 2026-09-20  
Implementation base at start: `dev@1108ca0d791b04d19a479b66184a57f92d427a07`

This document is the working evidence ledger and operator runbook for SPIKE-01.

It deliberately separates:

1. **public-document capability** — what the platform currently documents;
2. **real-account/application capability** — what our actual account/application can reach with its current permissions;
3. **final execution classification** — one of `official_api | browser | human_assisted | blocked`, assigned only after real-account evidence exists.

A public document, fixture, unit test, or model inference must never be recorded as a successful real-account validation.

## Safety / evidence rules

- Do not record passwords, cookies, storage state, access/refresh tokens, app secrets, QR-login artifacts, authorization codes, or browser-profile contents.
- Screenshots must be cropped/redacted to exclude account identifiers and secrets when they are not required evidence.
- API evidence should retain only the minimum useful fields: HTTP/business error code, granted scope names, capability/permission state, returned non-secret resource identifier when required, and timestamp.
- Do not call a final publish/create endpoint in this spike unless a separate explicit approval grants that irreversible side effect.
- Upload-only probes may use a dedicated disposable fixture when the platform contract requires upload reachability evidence, but must stop before the content-creation/publish call.
- If the result is uncertain, record `validation_gap`; do not convert uncertainty into a successful capability classification.

## Current matrix

| Platform | Public-document candidate route | Real-account validation | Final classification | Current blocker / next evidence |
| --- | --- | --- | --- | --- |
| Xiaohongshu | Browser + human takeover for MVP. Current Open Account docs expose `basic_info`; `write_notes` is not a generally-open publishing baseline. | **Pending** | **Unresolved** | XHS-01 / #50 is still open and not present on `dev`. XHS-02 / #51 is in PR #67 and still requires a real authenticated smoke. Need a real creator-account browser session, entry/login evidence, and prepared-before-publish evidence. |
| Douyin | Official OpenAPI. Current docs expose image/video publishing behind `video.create`, application permission, and user OAuth. | **Pending** | **Unresolved** | Need an approved application, target-account OAuth grant containing `video.create`, management-console permission evidence, and one upload-only reachability probe. Do not call `/video/create/` or `/image_text/create/` in this spike without separate publish approval. |
| WeChat Official Account | Official API when the real account has draft/publish permissions; otherwise human-assisted backend finalization is the expected fallback candidate. | **Pending** | **Unresolved** | Need the real Official Account type/certification state and non-secret API permission evidence. Probe draft read capability and freepublish read/list capability; keep mass-send separate from freepublish. |

The **candidate route is not the final SPIKE result**. The final classification column stays unresolved until current-account evidence is attached.

## Xiaohongshu validation

### Public-document baseline

Current Open Account documentation:

- `basic_info` is the currently open general scope;
- `write_notes` is listed as a planned/sensitive publishing scope rather than a generally available service-side publishing contract;
- therefore the Open Account API must not be assumed to replace the browser publishing path for the MVP.

References:

- https://openaccount.xiaohongshu.com/docs/scope
- https://openaccount.xiaohongshu.com/docs/api-reference

### Required real-account smoke

Prerequisite: use the repository's deterministic Xiaohongshu path. Do not create a separate ad-hoc browser script for this spike.

Current repository dependency state:

- #50 owns entry/login/challenge classification and human takeover.
- #51 / PR #67 owns deterministic image-text prepare/readback/approval stop.
- As of this document's creation, #50 is still open and PR #67 explicitly does not claim real-account smoke.

When the dependent path is runnable:

1. Start the supported browser runtime with a dedicated persistent profile.
2. Open the Xiaohongshu creator publishing entry.
3. Record whether the profile is already authenticated.
4. If login/device verification/challenge appears, hand control to the human and record only the action type and eventual outcome.
5. Reach the image-text composer.
6. Use a disposable controlled fixture.
7. Upload the fixture images.
8. Fill title/body/tags through the deterministic adapter.
9. Read the form back and verify it matches the intended fixture.
10. Stop at `approval_required`; do not click the final publish control.
11. Capture non-sensitive evidence of:
    - creator entry reached;
    - login/challenge boundary if encountered;
    - prepared form/readback result;
    - explicit pre-publish stop.

### Final classification rule

- `browser`: real creator flow is reachable and deterministic prepare/readback works, with human takeover only for identity/risk-control steps.
- `human_assisted`: creator flow is reachable but normal prepare cannot be made safely deterministic enough for the current MVP and requires human operation beyond identity proof.
- `blocked`: current account cannot reach the required creator/publish capability.
- `official_api`: only if the real account/application has a currently usable official publishing API and the capability is verified, not inferred from roadmap documentation.

## Douyin validation

### Public-document baseline

Current official documentation says:

- the content publishing solution supports direct image/video publication through OpenAPI;
- image upload and content creation use the `video.create` scope;
- the permission requires application access plus user authorization;
- when creating content on the user's behalf, the product must make each operation explicitly perceptible to the user.

References:

- https://open.douyin.com/platform/resource/docs/ability/content-management/douyin-publish-solution
- https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/create/create-video
- https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/publish-img/upload/
- https://open.douyin.com/platform/resource/docs/openapi/video-management/douyin/publish-img/publish/
- https://open.douyin.com/platform/resource/docs/openapi/account-permission/get-access-token
- https://open.douyin.com/platform/resource/docs/accession-guide/type-and-permission

### Required real-application evidence

Use a dedicated development/test application and target account.

Record, without secrets:

1. Application review/approval state.
2. Whether the application's interface permissions include the content-publishing capability / `video.create`.
3. OAuth grant result:
   - granted scope names only;
   - target-account identity should be anonymized;
   - do not record `access_token`, `refresh_token`, authorization code, client secret, or full OAuth response.
4. Upload-only reachability:
   - use a disposable image fixture;
   - call the documented image-upload path only;
   - retain timestamp, HTTP/business result code, and a redacted indication that an `image_id` was returned;
   - do not retain the token or raw request dump.
5. Stop before `/image_text/create/` or `/video/create/` unless a separate explicit approval authorizes a real publication.

### Approval mapping

The platform's requirement that each delegated publication be perceptible to the user maps naturally to Publisher's existing `approval_required` boundary. A future Douyin `PlatformPublisher` should not expose the final create call as a free-running model tool.

### Final classification rule

- `official_api`: real application permission + target-account OAuth `video.create` grant + upload capability are verified.
- `blocked`: application or account cannot obtain the required publishing permission.
- `human_assisted`: use only if official API permission is unavailable but a compliant human workflow remains product-worthy.
- Do not select `browser` as a convenience fallback merely because API permission is missing; it requires an independent product/compliance decision.

## WeChat Official Account validation

### Boundary to preserve

`freepublish` and mass-send are distinct product actions.

- **freepublish**: publishes a draft/article through the publication capability.
- **mass-send**: proactively sends content to followers/audience.

They must not be represented by one generic irreversible action or one approval summary.

Background references from Issue #34 point to the current WeChat Official Account developer documentation for Draft Box and Publish. Automated retrieval of those pages is not reliable in this environment, so the real-account console/API result is the decisive evidence for this spike.

### Required real-account evidence

Record the following without AppSecret/access tokens:

1. Official Account type.
2. Certification/authentication state.
3. Developer/API access enabled state.
4. Console-visible permission/capability state for:
   - material/draft operations;
   - publication/freepublish;
   - mass-send, recorded separately.
5. Read-only API probe using the current account token:
   - draft count/list read capability;
   - freepublish published-list/status read capability where available;
   - retain only endpoint name, timestamp, HTTP/business result code, and a redacted capability conclusion.
6. If draft access works but freepublish is denied, record the exact platform error code/message and classify the expected implementation fallback as draft preparation + human backend finalization.
7. Do not call a mass-send or freepublish submit endpoint in this spike without separate explicit approval.

### Final classification rule

- `official_api`: the real account has the required draft + freepublish capability and read-only probes demonstrate permission reachability.
- `human_assisted`: the account can prepare drafts/materials through supported APIs but final publication is unavailable and must be completed by an authorized human in the platform backend.
- `blocked`: the current account cannot support a useful prepare/publish chain under its present type/certification/permissions.
- `browser`: not a default fallback; requires a separate reasoned decision if official capabilities are unavailable.

## Evidence record template

Use one record per platform validation attempt.

```text
platform:
validated_at:
environment:
account_condition:
application_condition:
candidate_route:
final_classification:
prepare:
validate:
publish:
verify:
human_takeover:
irreversible_boundary:
evidence:
  - type:
    result:
    redactions:
blockers:
validation_gaps:
follow_up_issue:
```

Allowed final classifications are exactly:

```text
official_api
browser
human_assisted
blocked
```

If current evidence cannot justify one of those, keep `final_classification` unresolved and list the missing evidence instead of guessing.

## SPIKE exit criteria

SPIKE-01 may be considered technically complete only when all three platform rows have:

- a dated real-account/application validation result;
- a final classification from the allowed set;
- evidence that matches the claimed capability;
- explicit human-takeover and irreversible-action boundaries;
- exact blockers for unavailable permissions;
- a concrete follow-up implementation dependency/Issue.

No claim of successful publication belongs in this spike unless a separately authorized controlled publication was actually executed and verified.
