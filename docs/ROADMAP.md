# Agent Publisher Roadmap

Updated: 2026-09-22

This document owns **phase ordering, dependency shape, and MVP sequencing**. It is a planning projection, not a second live task board.

Live truth remains:

- GitHub Issues: work-item contracts and outcomes;
- Organization Project #1: coarse lifecycle when available;
- PR / review / CI: implementation evidence;
- `dev` code/config/runtime: current technical reality.

## MVP outcome

The first MVP is one reliable Xiaohongshu image-text loop:

```text
brief
  → Content Secretary
  → Builtin image-text material
  → durable Job
  → visible persistent browser
  → Publishing Secretary observe / plan / act / recover
  → human identity takeover when required
  → Publisher prepared-state readback / validation
  → explicit approval
  → publish once
  → verify result
  → persist evidence
```

Normal pre-publish browser routing is owned by the job-scoped Publishing Secretary: it observes the current page, chooses the next bounded action, acts through approved browser capabilities, and re-observes/re-plans. Publisher-owned deterministic code still owns Job truth, checkpoints, control grants, identity handoff, prepared-state validation, approval, publish-once, and verify-first recovery for uncertain irreversible side effects.

## Current snapshot

### Completed foundations

- #1 persistence / resumable Job milestone is closed.
  - #13 SQLite baseline
  - #20 JobRepository / checkpoint
  - #21 state machine / ActionRequest / resume
  - #49 ExternalActionRepository / irreversible-action idempotency
- #2 browser / human-takeover milestone is closed.
  - #8 browser runtime
  - #9 Docker CDP provider
  - #10 noVNC
  - #11 persistent profile / single-session constraint
- #25 Browser Live View adapter is closed.
- #26 Material contract / provider-slot baseline is closed.
- #44 Fastify application/bootstrap + HTTP/SSE baseline is closed.
- #72 APP-02 real Job API / SSE / XHS pre-publish orchestration is closed.
- Agent foundation #37–#42 is landed, including controlled MCP and Content Secretary → MaterialPlan.
- #52 PublicationEvidence / EvidenceRepository is closed.

### Builtin material path

The implementation chain is complete on `dev`:

```text
#26 contracts ✅
  ↓
#75 AssetRepository + LocalAssetStore ✅
  ↓
#76 DesignProvider contract alignment ✅
  ↓
#77 SafeRichLayout + Takumi renderer ✅
  ↓
#78 MaterialPreparationService + configured provider pipeline ✅
  ↓
Xiaohongshu publishing execution boundary
```

The product runtime now defaults to the real provider pipeline rather than controlled smoke material.

The Builtin path provides:

- Publisher-owned durable `asset://` media;
- real cover + image PNG assets;
- deterministic SafeRichLayout rendering without the authenticated publishing browser;
- per-step checkpoint/reuse for copy, images, cover, and design;
- retryable provider failure recovery without regenerating accepted prior steps;
- explicit optional-design degradation;
- direct compatibility with the Xiaohongshu upload boundary.

Parent #6 remains open only for its human visual acceptance criterion: a maintainer still needs to inspect at least one real-brief Builtin material result. Canva and video remain additive follow-up capabilities, not MVP prerequisites.

### Xiaohongshu pre-publish transition

Implementation for #50, #51, #70, and #95 has landed on `dev` and remains valuable as login/auth guards, prepared-state readback/validation, smoke/diagnostic evidence, and reusable safe browser primitives. It does **not** define the target ownership model for the normal browser route.

The 2026-09-22 real Creator smoke exposed the architecture gap: the page visibly offered “上传图文”, while the fixed `enter_image_text` route still failed. The durable conclusion is to stop treating selector repair as the normal-path owner and move task-local route choice into the Publishing Secretary under GOV-01.

- #50 XHS-01: retain login-state and human-handoff guards.
- #51 XHS-02: retain upload/readback/prepared validation assets where safe to reuse; its fixed prepare sequence is not the future route owner.
- #70 XHS-03: retain the real-account smoke harness as evidence/diagnostic infrastructure.
- #95 XHS-04: retain bounded diagnostics and observed real-page compatibility evidence rather than extending an endless selector path.
- Parent #4 remains the human-verifiable Agent-driven pre-publish outcome and stays open until that product result is proven.

The replacement execution path is dependency-driven: controlled browser capability (#105) plus Xiaohongshu Skill knowledge (#106) feed the Publishing Secretary vertical slice (#43), while identity handoff (#96) and independent prepared-state validation (#107) preserve Publisher governance. Issue-contract migration and exact dependency wording remain owned by GOV-02 #103.

### Product integration path

The Web/API integration code is also landed:

```text
#72 APP-02 ✅
real Job API + SSE + XHS pre-publish Orchestrator
  ↓
#73 F3-01 implementation ✅
Web UI runtime cutover from fixtures to real Job projection
  ↓
human MVP smoke pending
```

#73 remains open because its contract requires one human Web smoke: create a real Job from the Web UI, complete login in Live View if required, reach the real approval summary, and stop before final publish.

That same smoke can also provide the human visual evidence needed by parent #6 when it runs through the real Builtin provider pipeline.

### Publish-once path

The irreversible publish prerequisites are ready:

```text
#21 approval semantics ✅
        +
#49 external action/idempotency ✅
        +
#51 prepared state implementation ✅
        +
#52 PublicationEvidence ✅
        ↓
#53 PUB-02 publish-once / verify / evidence
```

#53 remains the core irreversible-side-effect slice. It may proceed where its dependencies permit, but it is not the owner of normal browser-route selection.

It may implement deterministic approval binding, publish-once guards, unknown-result verification-first recovery, and evidence persistence without performing a real external publication.

One real Xiaohongshu publication remains a separately authorized irreversible acceptance action.

On uncertainty after the side effect may have occurred:

```text
started
  → unknown
  → verify first
  → never automatically re-publish
```

## Publishing Secretary browser execution

#43 is the Publishing Secretary task-local browser execution vertical slice, not an inspect-only recovery helper. It is gated by the GOV-01 contract and controlled Browser tools (#105), with Xiaohongshu platform knowledge supplied by #106.

Normal pre-publish execution follows:

```text
observe current page
  → plan next bounded action
  → act through approved Browser tools
  → observe post-condition
  → continue / re-plan / human handoff / fail visibly
```

Recovery is part of that ordinary local execution loop. Publisher code independently owns Job/checkpoint transitions, browser-control handoff, prepared-state validation, approval, and irreversible-side-effect governance.

No final publish/delete/overwrite Tool is exposed to the model.

## Platform capability research

#34 remains open until Xiaohongshu / Douyin / WeChat Official Account conclusions are backed by current real account/application evidence.

Public documentation or community research alone is not acceptance evidence.

## Near-term ordering

Use dependency readiness rather than opening every card at once. GOV-02 #103 owns the mutation of existing Issue contracts/dependencies; this roadmap only projects the intended sequence.

1. GOV-01 #102 is the landed architecture gate; use GOV-02 #103 next to remove conflicting old Issue wording without erasing historical evidence.
2. Establish controlled Publishing Secretary browser capability (#105) and Xiaohongshu Skill knowledge (#106), then complete the task-local execution vertical slice (#43).
3. Complete Agent-driven identity routing/handoff (#96) and independent prepared-state validation/approval stop (#107) to prove parent #4 on the real Creator page.
4. Complete the Web product boundary through #97/#108/#109 as dependencies allow; normal users should not need raw CDP/noVNC/internal ports.
5. Keep #53 as the Publisher-owned approval + publish-once + verify-first side-effect path. A real publish remains separately authorized.
6. Use product-level human smoke to settle the remaining #3/#4/#6 acceptance evidence; continue #34 capability validation and additive Canva/video work without making them MVP blockers.

## Definition of meaningful MVP progress

A change materially advances MVP when it removes or proves a boundary on one of these paths:

- human-verifiable Agent-driven XHS pre-publish under Publisher validation;
- real API/UI task integration;
- publish-once + verify/evidence;
- dependable real image-text material generation.

More framework surface, more provider slots, more Agent abstractions, or more platform targets are not equivalent progress by themselves.
