# Xiaohongshu Publishing Skill references

This directory stores **reviewed, non-sensitive platform observations** that are useful to future Publishing Secretary sessions.

## Session learning vs durable experience

Do not treat every failed click, page mismatch, or one-off recovery as durable Skill knowledge.

During a live Job, the Agent should keep the useful lesson in the current session: what it expected, what actually happened, and how the next hypothesis should differ. That short-lived reflection is enough to avoid repeating the same mistake during the current exploration.

Cross-Job experience is more conservative. Promote only evidence that is reusable beyond the immediate run, and preserve the uncertainty of what has not yet been proven.

## Promotion flow

1. Start from dated real smoke evidence or a reproducible real-page failure/success observation.
2. Decide whether the observation is reusable beyond the current Job. Low-signal one-offs may remain run evidence only.
3. Reduce reusable evidence to semantic guidance: visible meaning, safe post-condition, boundary, or recovery lesson.
4. Record provenance and limitations. A single observation may become a narrow reference, but must not be generalized into a universal DOM/selector rule or decision table.
5. Review the proposal for:
   - no credentials/session material;
   - no raw account identifiers or QR artifacts;
   - no final-publish authority;
   - no fixed selector workflow disguised as a Skill;
   - no "page state -> mandatory answer" rule where current-page reasoning should remain open;
   - consistency with Publisher identity, approval, and unknown-draft boundaries.
6. Land the change through the normal reviewed PR path.

Running Agents have read-only access to these references. They do not write or merge production Skill changes themselves.

## Reference status

Current page evidence outranks a historical reference when the two conflict.

A newer observation may supersede an older hint. Repeated successful use, repeated recovery value, or independent confirming observations can strengthen a lesson, but durable changes still go through review. Keep provenance explicit rather than silently rewriting runtime behavior.
