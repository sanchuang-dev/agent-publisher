# Agent Publisher Roadmap

Updated: 2026-09-20

This document owns **phase ordering, dependency shape, and MVP sequencing**.

It does **not** own live task lifecycle:

- GitHub Issues own work-item contracts and outcomes.
- Organization Project #1 owns coarse `Todo / In Progress / Done` lifecycle.
- PR / review / CI own implementation evidence.
- `dev` code/config/runtime own current technical reality.

Status below is a dated planning snapshot only.

## MVP outcome

The first MVP is one reliable Xiaohongshu publishing loop:

```text
Publish Job
  → material preparation
  → visible persistent browser
  → login / human takeover when required
  → deterministic form preparation
  → readback validation
  → explicit approval
  → publish once
  → verify result
  → persist evidence
```

Known platform flows stay deterministic. Agent sessions are used for content reasoning and bounded recovery, not as authority for Job state, approval, or irreversible publish side effects.

## Current snapshot

### Completed foundations

- Browser / human takeover milestone #2 is completed.
  - #8 browser-runtime
  - #9 DockerCdpBrowserProvider
  - #10 noVNC / human operation
  - #11 profile persistence / single-session constraint
- Persistence and resumable Job core are implemented.
  - #13 SQLite baseline
  - #20 JobRepository / checkpoint
  - #21 Job state machine / ActionRequest / resume
  - #49 ExternalActionRepository / irreversible-action idempotency
- Material contract baseline #26 is completed.
- Application bootstrap #44 is completed.
  - Fastify 5
  - HTTP route boundaries
  - SSE lifecycle baseline
  - explicit composition root
- Agent foundation has substantially landed.
  - #37 Pi SDK baseline
  - #38 AgentDefinition / PiAgentHost / session isolation
  - #39 controlled resources / Skills / Tool boundary
  - #41 Publisher Job context / Pi session resume boundary
  - #42 Content Secretary → MaterialPlan vertical slice

### Remaining Agent work

- #40 MCP programmatic configuration / Pi adapter is the remaining infrastructure slice.
- #43 Publishing Recovery must wait for a stable deterministic platform path from #4. Recovery is not a substitute for building that path.

### Milestone settlement still pending

- Parent #1 remains open even though its final implementation slice #49 is complete. Reconcile and close the parent only through normal acceptance authority.
- Parent #7 remains open until its remaining accepted child outcomes are complete.

## MVP critical path

The shortest current path to a verified real publish is:

```text
                         #40 MCP
                            │
                            │  independent / non-blocking for normal platform path
                            ▼

Browser + Job + ActionRequest + external_actions ✅
                     │
                     ▼
          #50 XHS-01 login / takeover
                     │
                     ▼
          #51 XHS-02 prepare / readback
                     │
                     ▼
              approval_required
                     │
           ┌─────────┴─────────┐
           │                   │
           ▼                   ▼
 #52 EvidenceRepository    #49 external_actions ✅
           │                   │
           └─────────┬─────────┘
                     ▼
          #53 publish-once / verify
                     │
                     ▼
             real platform evidence
                     │
                     ▼
                 MVP loop
```

### #50 — deterministic login / takeover

Prove the real Xiaohongshu publishing entry, login-state detection, durable `login_required`, human takeover, and safe resume on the same persistent browser profile.

No upload or publish belongs here.

### #51 — deterministic prepare

Consume a controlled image-text MaterialPack, upload assets, fill the form, read it back, validate it, create `approval_required`, and stop.

A fixture MaterialPack is acceptable for this phase. Real provider selection must not block proving the platform path.

### #52 — publication evidence persistence

Land the bounded evidence contract/repository independently from the publish click so platform result URLs / content IDs / confirmations have a durable destination.

### #53 — publish once

This is the final irreversible vertical slice:

```text
durable affirmative approval
  → unique external action
  → started persisted
  → one publish interaction
  → deterministic result verification
  → evidence persisted
  → succeeded
```

An uncertain result must become `unknown` and resume must verify first. It must never silently republish.

A real test-account publish requires separate explicit maintainer approval even after #53 implementation is ready.

## Application integration gap after #44

#44 intentionally stopped at the framework/bootstrap boundary. The repository still needs an explicit small application slice for the product-facing wiring between:

```text
Fastify routes / SSE
      ↓
Job / Action application services
      ↓
Publisher Orchestrator
      ↓
JobRepository / ActionRequest / Browser / AgentHost
```

Do not hide this work inside #50/#51 or Agent infrastructure. Create a focused implementation slice before substantive API/orchestrator wiring starts.

## Material strategy for the first loop

The current priority is to prove the publishing loop, not a vendor matrix.

For the first Xiaohongshu path:

- existing Material contracts remain the boundary;
- #42 can produce a contract-valid MaterialPlan;
- #51 may consume a controlled/fake ImageTextMaterialPack;
- real Text/Image/Design provider integrations can follow after the deterministic platform loop is stable;
- video capability must remain explicit and must never be silently converted to image-text.

Parent #6 remains the durable material milestone.

## Recovery sequencing

#43 belongs **after** the deterministic #4 path is stable enough to provide a real recovery target.

Correct ordering:

```text
known deterministic path
  → controlled unexpected UI fixture
  → inspect-only Recovery Agent
  → validated RecoveryProposal
  → Orchestrator chooses retry-known-step / human / fail
```

Do not turn normal publishing into a free-running browser Agent.

## Later phases

These are valuable but are not blockers for the first reliable Xiaohongshu publish:

- #3 frontend productization / contract refresh;
- real Text/Image/Design provider selection under #6;
- video provider and video publishing path;
- #34 real-account capability matrix for Xiaohongshu / Douyin / WeChat Official Account;
- Douyin official API publisher;
- WeChat Official Account publisher;
- broader evidence/artifact UX;
- production authentication, deployment, observability, and multi-account concerns.

## Near-term ordering

Use dependency readiness rather than opening every card at once.

1. Finish/reconcile currently active Agent infrastructure (#40).
2. Implement #50.
3. Implement #52 in parallel when capacity exists.
4. Implement #51 after #50.
5. Add the focused post-#44 Job/Action API + Orchestrator wiring slice before integrated application work.
6. Implement #53 after #49 + #51 + #52 are accepted.
7. Run #43 only after #4 provides a stable deterministic path worth recovering to.
8. Expand material providers, frontend productization, and multi-platform work after the first publish loop is proven.

## Definition of MVP progress

The project should be considered materially closer to MVP only when a change removes a dependency on the path above or proves one of its real-world boundaries.

More framework surface, more provider slots, more Agent abstractions, or more platform targets do not count as equivalent progress by themselves.
