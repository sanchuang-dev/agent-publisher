# Material Generation Research

Status: research / reconciled implementation baseline  
Research date: 2026-09-20  
Implementation reconciliation: 2026-09-21  
Historical research baseline: `dev@aa8ea906448af3718d672b749ed9edd4d53d6ef7`  
Reconciled implementation baseline: `dev@6dbda991d2feecb46447a044ea047817bcbdd8d6`  
Owning product contract: [../product/PRD.md](../product/PRD.md)  
Owning technical baseline: [TECHNICAL-DESIGN.md](./TECHNICAL-DESIGN.md)

## 1. Purpose

This document evaluates how Agent Publisher should turn a `MaterialPlan` into real publishable media, using the current repository implementation rather than a greenfield architecture.

The three investigated directions are:

1. a Publisher-owned rich-layout renderer that lets an Agent compose static visual material and renders it to SVG/PNG;
2. Canva MCP as an optional higher-quality design backend;
3. a third-party video provider, with Yu-Yu (`https://docs.yu-yu.ai/generate-video`) as the intended first candidate.

The goal is not to select every future vendor. The goal is to identify the smallest architecture that lets the current Xiaohongshu MVP produce real assets without locking the product to one external service.

## 2. Executive conclusion

The research decision is now implemented for the image-text MVP.

The previously identified cross-cutting gaps are closed on `dev`:

1. `DesignProvider` receives resolved copy/source images and returns publishable cover/images;
2. `AssetRepository` + `LocalAssetStore` own durable Publisher asset identity/bytes and resolve canonical `asset://` references for platform upload;
3. `SafeRichLayout` + the selected Builtin renderer produce deterministic real PNG assets without the authenticated publishing browser;
4. `MaterialPreparationService` checkpoints copy/images/cover/design independently and assembles a real image-text `MaterialPack`;
5. the configured product runtime defaults to this real provider pipeline.

Landed capability order:

```text
MAT-02 / #75 Asset foundation ✅
          ↓
MAT-03 / #76 Design contract ✅
          ↓
MAT-04 / #77 SafeRichLayout + Takumi renderer ✅
          ↓
MAT-05 / #78 MaterialPreparationService ✅
          ↓
Xiaohongshu prepare boundary
```

The durable product positioning is:

- **Builtin renderer is the required dependable image-text baseline**, not an emergency fallback.
- **SafeRichLayout is Publisher's renderer-independent safety/product contract.**
- **Canva remains an optional advanced DesignProvider** for higher-quality/template workflows.
- **Video remains additive** and must reuse Publisher checkpoints and asset ingestion rather than creating a parallel Job system.

The next material work should therefore focus on human visual acceptance and additive Canva/video capabilities, not another replacement image-text pipeline.

## 3. Current code reality

### 3.1 Material contracts already exist

`src/materials/contracts.ts` already defines:

- `CreativeBrief`;
- `MaterialPlan`;
- `MaterialPack`;
- `TextMaterial`;
- image/video/design asset references;
- provider error boundaries;
- explicit `ready` / `ready_with_degradation` states.

Provider slots already exist under `src/materials/providers/`:

```text
TextProvider
ImageProvider
DesignProvider
VideoProvider
```

This means the project does **not** need another vendor registry or a second material-domain abstraction.

### 3.2 Content Secretary already owns planning, not execution

`src/agent/content-secretary.ts` now produces a validated `MaterialPlan` through the Pi-based Content Secretary session.

That session intentionally has:

```ts
CONTENT_SECRETARY_ALLOWED_TOOLS = []
```

and its authority stops at proposing a `MaterialPlan`.

This is a useful boundary and should be preserved. Real design/media execution should happen after planning, either deterministically or through a bounded helper session owned by the Publisher Orchestrator.

### 3.3 MCP support is already strong enough for Canva

`src/agent/pi-mcp.ts` already supports controlled MCP configuration with:

- stdio and Streamable HTTP transports;
- per-server tool allowlists;
- OAuth and bearer-env authentication;
- no ambient host MCP discovery;
- no direct tool exposure;
- remote authenticated HTTP restricted to HTTPS;
- per-AgentSession MCP lifecycle.

Therefore Canva does not justify a new MCP runtime.

### 3.4 The Xiaohongshu consumer boundary is now real

The merged XHS-02 implementation introduced:

`src/platforms/xiaohongshu/image-text-prepare.ts`

and its publishing path consumes:

```text
MaterialPack
  ↓
cover + images[]
  ↓
AssetPathResolver
  ↓
Playwright setInputFiles(...)
```

This matters because it makes one design-contract weakness concrete: `MaterialPack.design` is not uploaded. The platform path consumes image assets.

The current image-text publishing implementation is already waiting for a controlled `resolveAssetPath(asset)` boundary. That is the natural integration point for a real AssetStore.

### 3.5 Persistence is partially prepared

The first SQLite migration already contains an `assets` table:

```text
assets
├─ id
├─ job_id
├─ kind
├─ uri
├─ mime_type
├─ checksum
├─ metadata_json
├─ status
├─ created_at
└─ updated_at
```

However, no current repository/service layer owns this table, and there is no concrete local asset store.

The database schema is therefore ahead of the application implementation.

## 4. Contract gap: current DesignProvider is not sufficient

The current interface is effectively:

```ts
interface DesignProvider {
  readonly slot: "design";
  render(
    plan: MaterialPlan,
  ): Promise<ProviderResult<readonly DesignAssetReference[]>>;
}
```

This is insufficient for a real renderer for two reasons.

### 4.1 It lacks design inputs

A `MaterialPlan` tells a design provider how many assets are desired and whether design is optional/required, but it does not carry the actual copy or source imagery needed to compose a design.

A real renderer needs at least:

- resolved `TextMaterial`;
- source/generated images when available;
- the image-text plan;
- optional bounded visual requirements.

### 4.2 Its output is not the platform-consumed asset type

Xiaohongshu publishes:

```text
cover: ImageAssetReference
images: ImageAssetReference[]
```

not `DesignAssetReference[]`.

Therefore a design backend should produce **publishable image assets**, while separately preserving an editable/source design reference when useful.

Recommended direction:

```ts
interface DesignRenderInput {
  readonly plan: ImageTextMaterialPlan;
  readonly copy: TextMaterial;
  readonly sourceImages: readonly ImageAssetReference[];
}

interface DesignRenderResult {
  readonly source: DesignAssetReference | null;
  readonly cover: ImageAssetReference;
  readonly images: readonly ImageAssetReference[];
}

interface DesignProvider {
  readonly slot: "design";
  render(
    input: DesignRenderInput,
  ): Promise<ProviderResult<DesignRenderResult>>;
}
```

This lets both Builtin and Canva implementations satisfy the same product boundary:

```text
Builtin:
layout source → SVG → PNG → ImageAssetReference[]

Canva:
Canva design → export PNG → ImageAssetReference[]
```

The optional `source` can retain provenance such as an SVG/layout source or Canva design/edit reference.

## 5. Cross-cutting prerequisite: AssetStore

All three investigated capability paths need the same asset boundary.

### 5.1 Recommended MVP shape

```text
provider bytes / downloaded result
        ↓
LocalAssetStore.put(...)
        ↓
data/assets/{jobId}/{assetId}.{ext}
        ↓
assets table
        ↓
asset://{assetId}
```

The durable `MaterialPack` should retain a stable asset URI, not a machine-specific path and not an expiring provider URL.

The platform adapter then uses:

```text
asset://{assetId}
        ↓
AssetStore.resolveLocalPath(...)
        ↓
controlled filesystem path
        ↓
setInputFiles(...)
```

### 5.2 Why this is required before Canva and video

Canva export URLs and generated-video result URLs are delivery URLs, not durable Publisher asset identities.

External provider URLs may:

- expire;
- require authorization;
- change independently of the Publisher Job;
- expose vendor-specific details to platform modules;
- fail after a resumed Job.

The ingestion boundary should normalize those provider results immediately into Publisher-owned assets.

### 5.3 Minimal responsibilities

The MVP does not need a general object-storage framework. A small boundary is sufficient:

```ts
interface AssetStore {
  put(input: AssetWriteInput): Promise<AssetReference>;
  resolveLocalPath(asset: AssetReference): Promise<string>;
  read(asset: AssetReference): Promise<Buffer>;
}
```

plus an `AssetRepository` for the existing SQLite table.

OSS/R2 can remain later implementations behind the same contract.

## 6. Builtin rich-layout renderer

### 6.1 Landed decision

The Builtin image-text renderer is now a required Publisher-owned MVP capability.

Production flow:

```text
MaterialPlan + TextMaterial + controlled source images
        ↓
SafeRichLayout
        ↓
schema + policy validation
        ↓
BuiltinLayoutRenderer (Takumi)
        ↓
deterministic PNG bytes
        ↓
LocalAssetStore
        ↓
asset://...
        ↓
MaterialPack.cover + MaterialPack.images
```

The implementation deliberately does **not** execute arbitrary model-generated HTML/JavaScript in the persistent authenticated browser runtime.

### 6.2 SafeRichLayout boundary

The landed Publisher-owned vocabulary covers bounded static composition such as:

```text
Page
Stack
Grid
Heading
Text
Image
Badge
Quote
Card
Divider
Spacer
```

Validation is fail-closed for unknown/unapproved fields. The contract bounds canvas size, node/depth complexity, text/layout values, colors, gradients, spacing, image placement, and related presentation properties.

The layout contract does not expose arbitrary renderer JSX/HTML/CSS, script execution, browser APIs, or renderer-controlled network fetches.

### 6.3 Renderer decision

MAT-04 compared Takumi with Satori + resvg against representative fixtures and kept one production renderer.

The selected baseline is `@takumi-rs/core@2.14.0`.

The temporary Satori reference path failed against the pinned WOFF2 strategy with `Unsupported OpenType signature wOF2` and was removed rather than retained as a second production stack.

This is an implementation choice, not a product-contract dependency: callers speak SafeRichLayout, not Takumi node types.

### 6.4 Fonts, images, and overflow

- CJK/Latin font bytes come from pinned `@fontsource/noto-sans-sc@5.3.0` local WOFF2 resources (OFL-1.1), not host-installed fonts or runtime CDN fetches.
- source images reach the renderer as controlled bytes resolved from Publisher assets;
- model/provider URLs do not become renderer network requests;
- the first social-card canvas is 1080 × 1440;
- vertical overflow uses deterministic clipping at the fixed page boundary within the existing complexity bounds;
- cover/images persisted into the material pack must be durable Publisher assets.

### 6.5 Verification outcome

The renderer baseline has current repository evidence for:

- real 1080 × 1440 PNG output;
- CJK + Latin mixed text;
- flex/grid-like composition;
- images, gradients, borders, and radius;
- deterministic repeated output;
- malicious/unknown input rejection;
- local/CI/Linux-compatible native package execution.

The remaining product-level criterion is visual inspection of a real-brief Builtin material result under parent Issue #6.

## 7. Canva MCP

### 7.1 Technical feasibility

Canva provides an official remote MCP server and supports design search, generation, editing, asset access, exports, and related operations.

Reference: https://www.canva.dev/docs/mcp/

The existing Publisher MCP layer is already compatible with the architectural shape of Canva's remote MCP and OAuth model, so Canva should be integrated through the existing Pi MCP boundary rather than through a second Canva-specific agent runtime.

### 7.2 Authentication is per user

Canva explicitly does not support one organization-level/service-account authentication that automatically grants access to all users. Each user authenticates individually and receives access according to their Canva permissions.

Reference: https://www.canva.dev/docs/mcp/troubleshooting/

For the current Publisher POC, which is explicitly single-operator, the first implementation can use one operator-owned Canva connection.

A later multi-user product would need an explicit Publisher-user ↔ Canva-credential ownership model.

### 7.3 Preserve the existing Content Secretary boundary

Do not add Canva tools to the planning Content Secretary session.

Prefer:

```text
Content Secretary product role
├─ planning session
│   └─ no execution tools → MaterialPlan
└─ bounded design helper session
    └─ Canva MCP allowlist only
```

This keeps planning deterministic and makes Canva failure an external capability failure rather than a corruption of material planning.

### 7.4 Recommended first Canva capability: existing design/template editing

For the first usable Canva integration, prefer a controlled flow around an existing Canva design:

```text
known design/template
    ↓
copy-design or editable design selection
    ↓
start-editing-transaction
    ↓
perform-editing-operations
    ↓
commit-editing-transaction
    ↓
export-design
    ↓
download
    ↓
AssetStore
```

Canva currently exposes the core design/edit/export operations to normal plans, while some higher-level features such as resizing and Brand Kit/template capabilities have plan restrictions.

Tool/rate-limit reference: https://www.canva.dev/docs/mcp/tools/

This path has good product value for a company operator because it preserves an existing visual language without requiring the Publisher to own a full design editor.

### 7.5 Generative Canva is a separate product slice

Canva's documented generation path is:

```text
generate-design
    ↓
candidate designs
    ↓
user chooses a candidate
    ↓
create-design-from-candidate
```

Canva's integration verification explicitly warns against automatically selecting a generated candidate on behalf of the user.

Reference: https://www.canva.dev/docs/mcp/verify-integration/

Therefore the full generative Canva path introduces a real human-action state into Publisher:

```text
generate-design
    ↓
candidate A / B / C
    ↓
clarification_required
    ↓
user selection
    ↓
resume Job/session
    ↓
create-design-from-candidate
```

Publisher's backend is already structurally prepared for this through:

- `clarification_required`;
- durable Job checkpoints;
- AgentSession resume.

The current Web UI, however, does not yet expose a material-candidate selection surface. That UI is a distinct implementation requirement and should not be hidden inside a Canva adapter card.

### 7.6 Export and durable ingestion

Canva exports are asynchronous and completed exports return download URLs. Canva's Connect API documents those URLs as valid for 24 hours.

Reference: https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/

Therefore:

```text
Canva export URL
      ↓
immediate Publisher download
      ↓
AssetStore
      ↓
asset://...
```

The temporary URL must not become the durable `MaterialPack` URI.

### 7.7 Edit handoff

Canva recommends that any design-touching workflow expose a direct edit URL so the user can continue in Canva.

Reference: https://www.canva.dev/docs/mcp/workflows/design-edit/

A Canva-backed `DesignAssetReference` is therefore a good place to retain safe provenance such as:

- Canva design ID;
- edit URL;
- provider metadata needed for later handoff.

The exported PNGs remain separate `ImageAssetReference` objects.

### 7.8 MCP timeout/config impact

Canva documents that `generate-design` can need a timeout around 60 seconds.

Reference: https://www.canva.dev/docs/mcp/troubleshooting/

The current Publisher `AgentMcpServerDefinition` does not expose a request-timeout field. The existing MCP adapter supports per-server request timeouts, so Canva integration should add one small Publisher-owned configuration field rather than hard-code a Canva special case.

### 7.9 Difficulty

Estimated engineering difficulty:

- controlled existing-design/template-style Canva POC: **medium**;
- full generative candidate workflow: **medium-high**.

The higher cost of the generative path is product-state integration, not MCP protocol implementation.

## 8. Yu-Yu VideoProvider

Intended provider documentation:

https://docs.yu-yu.ai/generate-video

### 8.1 Current evidence limitation

At research time, the documentation URL could not be retrieved by the available browsing environment; the fetch failed before page content was available.

No endpoint names, request fields, response shapes, task states, model names, limits, or pricing are therefore asserted in this document.

The Yu-Yu section is intentionally limited to the API facts that must be validated before implementation.

### 8.2 Facts that materially change the Publisher design

Before implementing the adapter, verify:

| API fact | Why it matters |
| --- | --- |
| synchronous vs asynchronous generation | determines whether current `VideoProvider.generate()` is sufficient |
| provider task/job ID | required for crash-safe resume |
| idempotency support | determines safe retry semantics after an unknown request result |
| text-to-video / image-to-video modes | determines the generic VideoSpec boundary |
| source image input: URL/base64/upload ID | determines AssetStore → provider handoff |
| supported duration/resolution/aspect ratio | determines capability validation |
| audio support | determines whether output is considered final media |
| result URL lifetime/authentication | determines ingestion timing |
| duration metadata | current `VideoAssetReference.durationMs` is required |
| status/error schema | maps to stable Publisher provider failures |
| cancel/webhook support | affects recovery and resource cleanup |
| rate limits/cost semantics | affects retry/backoff and user-visible failure |

### 8.3 Likely architectural requirement for asynchronous generation

If Yu-Yu is an asynchronous submit/poll service, do not hide the whole lifecycle inside a long in-memory loop:

```ts
generate() {
  submit();
  while (...) poll();
  return finalVideo;
}
```

That would lose provider-task identity on process failure and could trigger duplicate paid generation after restart.

Prefer a checkpoint-aware sequence:

```text
submit video generation
    ↓
persist providerTaskId
    ↓
poll/re-enter
    ↓
persist progress/result
    ↓
download completed media
    ↓
AssetStore
    ↓
VideoAssetReference
```

The existing Publisher `job_steps.output_json` and `checkpoint_json` can already hold this recovery metadata. A separate video queue/database is not justified for the MVP.

### 8.4 Difficulty

**Not yet responsibly rateable from current evidence.**

If Yu-Yu exposes a conventional submit → task ID → poll → media URL protocol, the Publisher integration may be only medium difficulty because the existing Job/checkpoint model already supplies most of the required recovery semantics.

Do not label video as the hardest implementation solely because the underlying media model is complex. Publisher is consuming a service, not building a video model.

## 9. Recommended target architecture

```text
Publish Job
    ↓
Content Secretary
    ↓
MaterialPlan
    ↓
MaterialPreparationService
    ├─ TextProvider
    ├─ ImageProvider
    ├─ DesignProvider
    │    ├─ BuiltinRichLayoutDesignProvider
    │    └─ CanvaDesignProvider
    └─ VideoProvider
         └─ YuYuVideoProvider
    ↓
AssetStore
    ↓
MaterialPack
    ↓
Platform Publisher
    ↓
AssetStore.resolveLocalPath()
    ↓
browser upload
```

Important ownership rule:

> Material providers produce or transform material. AssetStore owns durable media identity and bytes. Platform publishers consume MaterialPack and never depend on Canva/Yu-Yu-specific URLs or APIs.

## 10. Material preparation and recovery semantics

Real material generation should become a checkpointed material phase rather than one opaque call.

Representative steps:

```text
material_plan
generate_copy
generate_images
render_design
generate_video
assemble_material_pack
```

Each completed item should be retained across downstream failures.

Examples:

- design provider fails when design is optional → preserve valid base images;
- Canva fails → Builtin may be selected as an explicit fallback without regenerating accepted copy;
- video fails under an allowed degradation policy → preserve copy/images and surface the degradation;
- one page render fails → retry that material item rather than regenerate the whole pack;
- provider task reaches unknown state → recover/verify before submitting another paid generation.

This matches the existing product principle: visible failure, recovery, degradation, and no duplicated side effects.

## 11. Implementation slices

Slices A–D below are now landed as Issues #75–#78. Their descriptions are retained as implementation-history context; Canva and Yu-Yu remain follow-up work.

These are implementation recommendations, not pre-created Issues.

### Slice A — Material asset foundation

Outcome:

- add `AssetRepository` for the existing schema;
- add MVP `LocalAssetStore`;
- use stable `asset://` references;
- provide `resolveLocalPath()` compatible with the merged Xiaohongshu `AssetPathResolver`;
- test ingest/read/resolve and missing/corrupt asset behavior.

This is the common prerequisite for all real providers.

### Slice B — DesignProvider contract correction

Outcome:

- make design input include resolved copy and source images;
- return publishable cover/images plus optional editable/source design reference;
- migrate fake providers/tests;
- preserve current degradation behavior.

Keep this bounded to the material contract; do not implement a vendor in the same change if that makes the slice difficult to review.

### Slice C — Builtin rich-layout DesignProvider

Outcome:

- define `SafeRichLayout`;
- schema/policy validation;
- deterministic CJK font strategy;
- Satori → SVG;
- resvg-js → PNG;
- ingest output into AssetStore;
- produce one real Xiaohongshu-ready `MaterialPack` from a controlled brief.

### Slice D — Real MaterialPreparationService

Outcome:

- connect the existing Content Secretary `MaterialPlan` to real Text/Image/Design provider execution;
- checkpoint provider steps;
- preserve accepted results across retry/degradation;
- assemble a real `MaterialPack`;
- hand it to the platform path.

### Slice E — Canva MCP spike

Outcome:

- connect the official remote Canva MCP using current Publisher MCP infrastructure;
- validate one operator OAuth;
- validate fail-closed allowlist;
- validate one read/design operation and export;
- validate configured request timeout;
- ingest one exported file into AssetStore;
- record product/account/plan limitations.

Do not add candidate-selection UI in the spike.

### Slice F — Canva controlled DesignProvider

Outcome:

- use an existing approved Canva design/template-like source;
- copy/edit/commit/export through bounded tools;
- retain Canva design/edit provenance;
- export and ingest PNG assets;
- Builtin remains available when Canva is unavailable.

### Slice G — Canva generative candidate workflow

Outcome:

- `generate-design`;
- present candidates;
- pause through `clarification_required`;
- add UI for candidate choice;
- resume;
- `create-design-from-candidate`;
- export/ingest.

This is intentionally later than the controlled Canva path.

### Slice H — Yu-Yu API spike

Outcome:

- read and record the real API contract;
- verify authentication;
- verify one generation against a non-production/controlled prompt;
- establish submit/status/result semantics;
- determine idempotency/retry behavior;
- determine asset ingress/egress shape;
- decide whether `VideoProvider` remains one method or needs an explicit resumable operation model.

Only after this spike should the concrete Yu-Yu adapter task be contracted.

## 12. Relative difficulty

| Capability | Difficulty | Main reason |
| --- | --- | --- |
| AssetStore foundation | low-medium | small implementation, but correctness affects every provider |
| Design contract correction | low-medium | bounded type/API change with existing consumers/tests |
| Builtin rich-layout | medium | layout safety, fonts, overflow and real output quality |
| MaterialPreparationService | medium | orchestration and checkpoint/retry semantics |
| Canva controlled design | medium | OAuth + MCP + external failure + export ingestion |
| Canva generative mode | medium-high | candidate-selection human action + UI + resume |
| Yu-Yu video | unknown pending API validation | asynchronous/idempotency semantics may dominate |

## 13. MVP recommendation

For the Xiaohongshu MVP, the dependable path should be:

```text
brief
  ↓
Content Secretary
  ↓
MaterialPlan
  ↓
copy
  ↓
Builtin rich-layout renderer
  ↓
PNG assets
  ↓
AssetStore
  ↓
MaterialPack
  ↓
Xiaohongshu prepare
  ↓
approval
  ↓
publish
```

Canva should enhance this baseline rather than define whether the product can produce image-text material at all.

Yu-Yu video should plug into the same asset and checkpoint model after the API contract is verified.

The desired failure property is:

> Canva can be unavailable and video can be unavailable while Publisher still retains a complete, locally controlled path that can produce valid image-text material for the supported platform.

## 14. Research sources

Repository evidence:

- `src/materials/contracts.ts`
- `src/materials/providers/*`
- `src/materials/degradation.ts`
- `src/materials/material-plan-validation.ts`
- `src/agent/content-secretary.ts`
- `src/agent/pi-mcp.ts`
- `src/storage/migrations/index.ts`
- `src/platforms/xiaohongshu/image-text-prepare.ts`
- `src/platforms/xiaohongshu/prepare-service.ts`
- Issue #6
- closed Issue #26
- closed Issue #42
- merged XHS-02 / PR #67

External references:

- Canva MCP overview: https://www.canva.dev/docs/mcp/
- Canva tools/rate limits: https://www.canva.dev/docs/mcp/tools/
- Canva troubleshooting/authentication: https://www.canva.dev/docs/mcp/troubleshooting/
- Canva integration verification: https://www.canva.dev/docs/mcp/verify-integration/
- Canva design edit handoff: https://www.canva.dev/docs/mcp/workflows/design-edit/
- Canva export API: https://www.canva.dev/docs/connect/api-reference/exports/create-design-export-job/
- Satori: https://github.com/vercel/satori
- resvg-js: https://github.com/thx/resvg-js
- intended Yu-Yu video provider documentation: https://docs.yu-yu.ai/generate-video

## 15. What remains undecided

The Builtin image-text baseline, SafeRichLayout boundary, Takumi production renderer, pinned Noto Sans SC font source, LocalAssetStore, and real MaterialPreparationService are now implementation facts rather than research questions.

The remaining material/product questions are:

- whether Canva is exposed as a user-selectable mode or automatic enhancement;
- Canva credential UX beyond the single-operator POC;
- the exact Yu-Yu VideoProvider API shape and async/idempotency behavior;
- future OSS/R2 AssetStore implementation;
- a long-term multi-vendor media routing matrix.

Those decisions should be made by the smallest implementation/spike that can verify the remaining uncertainty.
