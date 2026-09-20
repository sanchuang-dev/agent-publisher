# Material Generation Research

Status: research / implementation recommendation  
Research date: 2026-09-20  
Repository baseline: `dev@aa8ea906448af3718d672b749ed9edd4d53d6ef7`  
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

The current architecture is directionally correct, but the real provider integrations should not start by dropping vendor adapters directly behind the existing provider interfaces.

Two cross-cutting gaps must be addressed first:

1. the current `DesignProvider` contract cannot produce the image assets that the Xiaohongshu publishing path actually consumes;
2. the schema contains an `assets` table, but the repository has no durable `AssetRepository` / `AssetStore` implementation that can ingest provider output and later resolve an `asset://` reference to a controlled local upload path.

Recommended capability order:

```text
Material foundation
  ↓
Builtin rich-layout DesignProvider
  ↓
real Material preparation pipeline
  ↓
Canva template/design enhancement
  ↓
Canva generative candidate workflow
  ↓
Yu-Yu VideoProvider after API contract validation
```

The recommended product positioning is:

- **Builtin renderer is the dependable baseline**, not merely an emergency fallback.
- **Canva is an optional advanced DesignProvider**, useful for existing brand/template workflows and later generative design.
- **Video remains additive**. It should reuse Publisher checkpoints and asset ingestion rather than introducing a parallel job system.

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

### 6.1 Recommendation

Build a Publisher-owned static rich-layout renderer and treat it as the dependable image-text baseline.

Do **not** let an Agent execute arbitrary HTML/JS inside the persistent browser runtime.

Instead, let an Agent produce a validated static layout document that is expressive enough for social cards but incapable of arbitrary execution or network access.

Suggested flow:

```text
MaterialPlan + TextMaterial + source images
        ↓
bounded design helper / deterministic planner
        ↓
SafeRichLayout[]
        ↓
schema + policy validation
        ↓
Satori
        ↓
SVG
        ↓
resvg-js
        ↓
PNG
        ↓
AssetStore
        ↓
MaterialPack.cover + MaterialPack.images
```

### 6.2 SafeRichLayout

A minimal initial vocabulary could include:

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

The model may control bounded presentation attributes such as:

- spacing;
- font size/weight within allowed ranges;
- color tokens or validated colors;
- alignment;
- background;
- border/radius;
- image placement;
- emphasis;
- page composition.

It should not be able to introduce:

- JavaScript;
- iframe;
- arbitrary fetch/network requests;
- arbitrary external image/font URLs;
- unbounded CSS;
- arbitrary SVG references;
- browser-only APIs.

### 6.3 Why Satori + resvg-js fits the project

Satori converts a static JSX/object tree using a supported HTML/CSS subset into SVG. It supports direct object input without requiring raw HTML string execution, requires supplied fonts for text rendering, and does not support arbitrary `<script>`, external `<link>`, or `<style>` execution.

Reference: https://github.com/vercel/satori

resvg-js converts SVG to PNG from Node.js and has native/prebuilt support across common platforms including Apple Silicon.

Reference: https://github.com/thx/resvg-js

This avoids coupling material rendering to the authenticated browser-runtime container.

### 6.4 Important implementation constraints

#### Fonts

Chinese output must not rely on whatever font happens to be installed on the developer machine.

The renderer needs a deterministic CJK font strategy for local and Docker execution.

Do not commit a font file without first verifying its redistribution/license boundary.

#### Image ingestion

Source images should be read from AssetStore and passed as controlled buffer/data input to the renderer.

Do not allow arbitrary model-generated external image URLs to become renderer network requests.

#### Overflow and bounded generation

Layout validation should enforce practical limits such as:

- fixed supported canvas sizes;
- maximum page count;
- maximum node count;
- bounded title/body length per page;
- allowed font-size ranges;
- allowed image count;
- deterministic overflow failure rather than clipped silent success.

For Xiaohongshu, `1080 × 1440` is a practical first card size, but the size should live in a platform/design policy rather than be hard-coded throughout the material domain.

### 6.5 Difficulty

Estimated engineering difficulty: **medium**.

The difficult part is not rasterization. It is defining a sufficiently expressive but bounded layout contract, deterministic font behavior, and product-quality overflow handling.

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

## 15. What this document does not decide

This research does not yet make the following durable product decisions:

- the final CJK font package/license;
- final `SafeRichLayout` schema;
- whether Canva is exposed as a user-selectable mode or automatic enhancement;
- Canva credential UX beyond the single-operator POC;
- the exact Yu-Yu VideoProvider API shape;
- future OSS/R2 AssetStore implementation;
- a long-term multi-vendor media routing matrix.

Those decisions should be made by the smallest implementation/spike that can verify the remaining uncertainty.
