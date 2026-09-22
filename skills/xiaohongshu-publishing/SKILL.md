---
name: xiaohongshu-publishing
description: Platform guidance for a bounded Publishing Secretary preparing Xiaohongshu Creator content without owning identity, approval, or final publication.
---

# Xiaohongshu Publishing

Use this Skill as **platform knowledge**, not as a fixed browser workflow.

## Operating model

- Start from the page that actually exists now. Observe first, choose one bounded action, then observe again.
- Prefer semantic page meaning and visible labels over remembered DOM paths or selectors.
- Treat an old element reference as stale after navigation, mode changes, dialogs, uploads, or other page mutations. Re-observe before acting again.
- A successful past path is guidance only. If the page differs, explore the current safe affordances instead of replaying a selector sequence.

## Recognizing the Creator publishing surface

Useful semantic cues may include:

- a Xiaohongshu Creator publishing surface;
- publishing-mode choices such as `上传视频`, `上传图文`, or `写文章`;
- an image-text composer with media upload, title, body, or topic/tag fields;
- login, QR, MFA, device-verification, or risk-control UI.

Do not infer authorization from a URL or one label alone. Use the current observed page state.

## Choosing the requested mode

The Publish Job's mode is fixed input.

For an **image-text** task:

- if the current Creator surface is on video/article mode and a semantic `上传图文` choice is available, choosing that image-text direction is an appropriate bounded navigation action;
- if the current page is already the image-text composer, stay on it and inspect whether the composer is fresh and suitable rather than navigating away;
- do not change the Job to video/article merely because that mode is currently selected.

For a **video** task, use the analogous current-page reasoning for the video direction. Do not silently convert the requested mode.

## Identity boundary

Login, QR scanning, MFA, device verification, CAPTCHA, and equivalent identity/risk-control steps belong to the authorized human.

When such a boundary appears:

- stop browser mutation;
- report the observed identity requirement through the Publisher-owned handoff path;
- do not bypass, solve, or work around the challenge;
- resume only after Publisher returns browser control.

## Composer and material safety

Before changing an existing composer, determine whether it is fresh.

If title/body/topics/media or another meaningful draft state already exists and its ownership is unknown:

- do not clear, overwrite, append duplicate uploads, or "fix" it speculatively;
- stop and report the unknown-draft condition for Publisher clarification/human handling.

When the composer is fresh, use only the accepted task material supplied by Publisher. After upload/fill actions, observe again and check the visible post-condition instead of assuming the action succeeded.

## Prepared-before-publish condition

The Publishing Secretary may report that preparation appears complete only when the current page gives evidence that:

- the requested publish mode is active;
- intended media is present and no visible upload/processing failure remains;
- title/body/topics correspond to the accepted material at the semantic level available to the browser session;
- there is no unresolved identity challenge, unknown draft, blocking dialog, or ambiguous page state.

This is **not approval**. Publisher-owned readback/validation decides whether the Job may enter `waiting_for_approval`.

## Final publish is forbidden

Never click, invoke, or search for a way to execute the final irreversible publish action as an ordinary browser task.

The Publishing Secretary does not own:

- publish approval;
- publish-once authority;
- retry of an uncertain publication;
- Job state/checkpoint mutation;
- external-action records.

If the only apparent next action is final publication, stop and return control to Publisher.

## Recovery

When the page changes or an action fails:

1. observe the current state again;
2. distinguish identity boundary, unknown draft, transient UI state, and ordinary navigation;
3. choose at most one bounded safe action supported by the current observation;
4. observe the result again;
5. if confidence is insufficient, stop and ask Publisher for human/clarification handling.

Do not turn recovery into repeated guessing or repeated clicks.

## Verified experience references

Repository-reviewed observations from real smoke runs live under `references/`.

Use them as semantic hints with explicit provenance and limitations. They must never become an undocumented selector workflow.

## Experience refinement

A runtime Agent must not permanently edit this Skill.

New experience follows this controlled path:

`real smoke evidence → non-sensitive reference proposal → review for semantics/safety/provenance → PR → merge`

A proposal should capture what was observed, what guidance is justified, what remains unproven, and the source evidence. Do not store cookies, tokens, QR artifacts, account identifiers, browser-profile contents, raw DOM dumps, or secret-bearing screenshots.
