---
name: xiaohongshu-publishing
description: Platform guidance for a bounded Publishing Secretary preparing Xiaohongshu Creator content without performing human identity actions or owning approval/final publication.
---

# Xiaohongshu Publishing

Use this Skill as **platform knowledge**, not as a fixed browser workflow.

## Operating model

- Start from the page that actually exists now. Observe first, choose one bounded action, then observe again.
- Prefer semantic page meaning and visible labels over remembered DOM paths or selectors.
- Treat an old element reference as stale after navigation, mode changes, dialogs, uploads, or other page mutations. Re-observe before acting again.
- Stay within the granted single-active-page browser capability. The MVP does not grant tab/popup management; if a required path escapes into another page, stop with a bounded capability gap instead of trying to manage extra tabs.
- A successful past path is guidance only. If the page differs, explore the current safe affordances instead of replaying a selector sequence.
- The current observed page is stronger evidence than a historical reference. Treat prior experience as a useful hypothesis that may be outdated, incomplete, or inapplicable to the current state.

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

- if the current Creator surface is on video/article mode and a semantic `上传图文` choice is available, that is useful evidence for an image-text direction, not a mandatory scripted step;
- if the current page is already the image-text composer, use that current state as stronger evidence than an older entry-path reference;
- do not change the Job to video/article merely because that mode is currently selected.

For a **video** task, use the analogous current-page reasoning for the video direction. Do not silently convert the requested mode.

## Identity navigation and human boundary

Finding the identity surface is part of the Publishing Secretary's browser task. The human should not have to locate the login button, choose the login method, or switch the page into QR-login mode.

Within the granted Xiaohongshu Creator origin, the Agent may:

- observe a logged-out Creator page;
- navigate ordinary login UI;
- choose or switch login methods;
- prefer a visible QR/scanning login method when available;
- re-observe after each bounded action until a real human-action surface is ready.

A login label, login page, or login-method selector is **not** by itself the human boundary.

The human boundary begins only when the page is ready for an identity action the Agent must not perform, such as:

- a QR code that is ready for the authorized human to scan;
- CAPTCHA;
- MFA / OTP;
- device verification;
- another equivalent identity/risk-control challenge.

At that point:

- stop browser mutation;
- report a bounded safe state: `qr_ready` or `verification_required`;
- hand control through the Publisher-owned login path;
- do not bypass, solve, or work around the challenge;
- do not copy or persist QR contents, one-time codes, cookies, storage state, account identifiers, passwords, or tokens;
- resume only after Publisher returns browser control.

If the login UI changes before reaching a human-action surface, treat that as ordinary browser exploration: re-observe, revise the hypothesis, and try a materially different bounded safe path. Do not ask the human to find the QR/login route for the Agent.

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

A generic browser click capability is **not** publish authority. The browser capability layer supplied by #105 enforces the Publisher-owned final-publish boundary; this Skill does not claim that prompt text alone can make an unrestricted click tool safe. If a candidate click could be the final publish action, do not click it.

## Recovery and exploration

A failed or surprising action is new evidence, not an instruction to replay the same action or immediately give up.

Use a bounded observe-act-observe loop:

1. observe the current state again;
2. compare what actually happened with the working hypothesis and note what the result taught you;
3. distinguish a hard boundary (a prepared human-only identity action such as QR scan/CAPTCHA/MFA/OTP/device verification, unknown draft, approval/final publication, or another irreversible risk) from an ordinary login/page/navigation mismatch;
4. for an ordinary mismatch, revise the working hypothesis and choose one materially different bounded safe action supported by the current observation;
5. observe the result again and update the hypothesis before choosing another action.

Each loop may contain at most one browser mutation, but recovery may use multiple loops while the task is making progress or producing new evidence.

If the page is materially unchanged, do not repeat the same failed action just because it is still available. Try a meaningfully different safe hypothesis or observation path.

Stop and report a bounded gap when a hard boundary is reached, when no materially different safe path remains, or when further attempts are no longer producing new evidence. Do not turn exploration into blind repeated guessing or repeated clicks.

## Verified experience references

Repository-reviewed observations from real smoke runs live under `references/`.

Current reviewed references:

- `references/2026-09-22-creator-mode-entry.md` — a logged-in Creator page was visibly on video mode with `上传视频 / 上传图文 / 写文章`; the legacy image-text entry path failed before mutation, so the justified lesson is to re-observe and consider the semantic image-text direction rather than replaying a selector.

Use references as semantic hints with explicit provenance and limitations. A live page may contradict or supersede an older hint. References must never become an undocumented selector workflow or a decision table.

## Experience refinement

Within one Agent session, keep recovery learning lightweight and local: remember the attempted hypothesis, the observed outcome, and the useful lesson for the next attempt. Do not promote every failure into durable platform knowledge.

A runtime Agent must not permanently edit this Skill.

Potentially reusable cross-Job experience follows this controlled path:

`real smoke evidence → non-sensitive reference/proposal → review for reusability/semantics/safety/provenance → PR → merge`

A proposal should capture what was observed, what guidance is justified, what remains unproven, and the source evidence. One observation may justify a narrowly scoped reference with explicit limitations; it must not become a universal rule merely because it happened once.

Repeated successful use, repeated recovery value, or independent confirming observations may strengthen or supersede earlier guidance through the same review path.

Do not store cookies, tokens, QR artifacts, account identifiers, browser-profile contents, raw DOM dumps, or secret-bearing screenshots.
