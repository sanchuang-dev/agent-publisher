# Agent Publisher Roadmap

Updated: 2026-09-20

This document owns **phase ordering, dependency shape, and MVP sequencing**. It is a planning projection, not a second live task board.

Live truth remains:

- GitHub Issues: work-item contracts and outcomes;
- Organization Project #1: coarse lifecycle when available;
- PR / review / CI: implementation evidence;
- `dev` code/config/runtime: current technical reality.

## MVP outcome

The first MVP is one reliable Xiaohongshu image-text loop:

```text
brief / controlled material
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
- Agent foundation #37–#42 is landed, including controlled MCP and Content Secretary → MaterialPlan.
- #52 PublicationEvidence / EvidenceRepository is closed.

### Xiaohongshu deterministic path

Implementation for #50 and #51 is merged into `dev`, but their Issues remain open because real-account acceptance evidence is still required.

- #50 XHS-01: login state / human takeover / resume — code landed, real smoke pending.
- #51 XHS-02: image-text prepare / readback / approval stop — code landed, real smoke pending.
- #70 XHS-03: dedicated real-account prepare smoke harness; this is the acceptance/diagnostic entry for the two items above.
- Parent #4 remains open until the human-verifiable pre-publish outcome is proven.

Do not close #50/#51 merely because their implementation PRs merged.

## Product integration path

#44 intentionally stopped at framework/bootstrap. Product integration is now explicit:

```text
#72 APP-02
real Job API + SSE + XHS pre-publish Orchestrator
  ↓
#73 F3-01
Web UI runtime cutover from fixtures to real Job projection
  ↓
human can run a real task to waiting_for_approval
```

- #72 currently owns the first application-runtime vertical slice and must stop before final publish.
- #73 depends on a stable/accepted #72 contract and must not invent a second backend/runtime model.
- #70 remains independently useful below these layers to distinguish platform failures from application/UI wiring failures.

## Publish-once path

The irreversible publish foundation is already split correctly:

```text
#49 external action/idempotency ✅
          +
#51 verified prepared state / durable approval pause
          +
#52 PublicationEvidence ✅
          ↓
#53 PUB-02 publish-once / verify / evidence
```

#53 may implement deterministic publish-once behavior, but one real external publication still requires separate explicit maintainer authorization.

On uncertainty after the side effect may have occurred:

```text
started
  → unknown
  → verify first
  → never automatically re-publish
```

## Material MVP path

Parent #6 now has an executable image-text material path rather than an untracked research recommendation:

```text
#26 contracts ✅
  ↓
#75 AssetRepository + LocalAssetStore
  ↓
#76 DesignProvider contract alignment
  ↓
#77 Builtin SafeRichLayout renderer
  ↓
#78 real MaterialPreparationService
  ↓
existing Xiaohongshu prepare path
```

The Builtin renderer is the dependable MVP baseline. Canva and video are additive capabilities, not prerequisites for producing valid image-text material.

PR #71 contains the current material-generation research and future Canva / Yu-Yu recommendations.

## Agent recovery

#43 Publishing Recovery is now technically unblocked by the landed deterministic XHS path, but it is not ahead of the human/product MVP path.

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

1. Finish/review #72 application-runtime vertical slice.
2. Build/run #70 real Xiaohongshu prepare smoke in parallel where practical.
3. Start #73 after #72's product contract is stable enough to consume.
4. Implement #53 as the publish-once backend slice; real publish remains separately authorized.
5. Advance #75 → #78 so controlled smoke material can be replaced by the real Builtin material path.
6. Keep #43 behind the core human/product path unless a concrete recovery need blocks acceptance.
7. Continue #34 capability validation and later Canva/video work without turning them into MVP blockers.

## Definition of meaningful MVP progress

A change materially advances MVP when it removes or proves a boundary on one of these paths:

- human-verifiable XHS pre-publish;
- real API/UI task integration;
- publish-once + verify/evidence;
- dependable real image-text material generation.

More framework surface, more provider slots, more Agent abstractions, or more platform targets are not equivalent progress by themselves.
