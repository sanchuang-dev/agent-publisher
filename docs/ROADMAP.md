# Agent Publisher Roadmap

Updated: 2026-09-21

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
  → login / human takeover when required
  → deterministic prepare + readback validation
  → explicit approval
  → publish once
  → verify result
  → persist evidence
```

Known platform flow remains deterministic. Agent sessions may plan content and later propose bounded recovery; they do not own Job truth, approval, or irreversible publication.

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
existing Xiaohongshu prepare path
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

### Xiaohongshu deterministic path

Implementation for #50, #51, and #70 is merged into `dev`, but the real-account acceptance evidence is still pending.

- #50 XHS-01: login state / human takeover / resume — implementation landed.
- #51 XHS-02: image-text prepare / readback / approval stop — implementation landed.
- #70 XHS-03: dedicated real-account prepare smoke harness — implementation landed and CI-green.
- Parent #4 remains open until the human-verifiable pre-publish outcome is proven.

The next platform evidence should come from the real-account #70 smoke, stopping at durable `waiting_for_approval + approval_required` with no final publish.

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

#53 is the next core implementation slice.

It may implement deterministic approval binding, publish-once guards, unknown-result verification-first recovery, and evidence persistence without performing a real external publication.

One real Xiaohongshu publication remains a separately authorized irreversible acceptance action.

On uncertainty after the side effect may have occurred:

```text
started
  → unknown
  → verify first
  → never automatically re-publish
```

## Agent recovery

#43 Publishing Recovery is technically unblocked by the landed deterministic XHS path, but it remains behind the normal human/product MVP path.

Correct boundary:

```text
known deterministic step
  → bounded inspect-only recovery
  → structured RecoveryProposal
  → Publisher chooses retry-known-step / human / fail
```

No final publish/delete/overwrite Tool is exposed to the model.

## Platform capability research

#34 remains open until Xiaohongshu / Douyin / WeChat Official Account conclusions are backed by current real account/application evidence.

Public documentation or community research alone is not acceptance evidence.

## Near-term ordering

Use dependency readiness rather than opening every card at once.

1. Run #70 real Xiaohongshu prepare smoke and use that evidence to settle #50/#51/#4 where the observed path satisfies their criteria.
2. Run #73 human Web MVP smoke through the real provider pipeline; use the rendered material for parent #6 human visual acceptance when suitable.
3. Implement #53 PUB-02 as the next core backend slice. Real publish remains separately authorized.
4. Close parent #6 once the human Builtin-material inspection evidence is recorded.
5. Keep #43 behind the core human/product path unless a concrete recovery need blocks acceptance.
6. Continue #34 capability validation and later Canva/video work without turning them into MVP blockers.

## Definition of meaningful MVP progress

A change materially advances MVP when it removes or proves a boundary on one of these paths:

- human-verifiable XHS pre-publish;
- real API/UI task integration;
- publish-once + verify/evidence;
- dependable real image-text material generation.

More framework surface, more provider slots, more Agent abstractions, or more platform targets are not equivalent progress by themselves.
