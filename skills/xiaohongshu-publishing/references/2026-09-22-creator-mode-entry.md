# Verified Creator mode-entry observation — 2026-09-22

Status: reviewed experience candidate promoted by XHS-SKILL-01.

## Provenance

Source: real logged-in Xiaohongshu Creator smoke evidence recorded on Issue #95, especially comment `5770750152`, following the bounded `enter_image_text` failure captured in comment `5770737310`.

This reference intentionally contains no account identity, cookie/token, QR artifact, browser-profile content, selector dump, or screenshot payload.

## Observed page state

On the real Creator page:

- the page was already authenticated;
- the current surface was the video-upload mode;
- the top-level publishing choices visibly included `上传视频 / 上传图文 / 写文章`;
- the legacy fixed `enter_image_text` path failed before upload/form mutation began.

## Guidance justified by this observation

For an image-text Job starting from an equivalent semantic state:

- re-observe the current page rather than treating the legacy failure as proof that the page is unusable;
- `上传图文` is a useful semantic cue for the requested image-text direction when it is visibly available;
- choose one bounded image-text navigation action, then re-observe the resulting page;
- do not ask the human to find or click the image-text entry merely because a remembered selector failed.

## What this does NOT prove

This evidence does not prove:

- a stable DOM structure or reusable selector;
- that the same labels are always present;
- that upload/fill/readback will succeed afterward;
- that the current page is safe to overwrite if an unknown draft is present;
- that publication is approved or authorized.

Treat this as a semantic experience hint, not a workflow checkpoint or selector contract.
