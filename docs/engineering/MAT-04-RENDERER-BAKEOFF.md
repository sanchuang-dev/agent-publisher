# MAT-04 Renderer Bake-off Evidence

Issue: #77  
PR: #87  
Observed CI run: 35542917263  
Observed environment: Node v22.23.2, Linux x64  
Canvas: 1080 × 1440  
Font source: `@fontsource/noto-sans-sc@5.3.0` WOFF2, loaded from the installed package without host fonts or network fetches. Production registration explicitly includes Simplified Chinese and Latin subsets at weights 400/700 under one Takumi logical family.

## Decision

Use **Takumi `@takumi-rs/core@2.14.0`** as the single production `BuiltinLayoutRenderer` baseline for the MVP.

Publisher keeps `SafeRichLayout` as its own bounded contract. The public renderer API does not expose Takumi HTML, JSX, CSS strings, or node-tree types.

## Evidence

The same Publisher-owned SafeRichLayout fixtures covered CJK text, Flex/Grid-like composition, controlled image bytes, gradients, borders, and radii.

| Fixture | Takumi result | PNG bytes | Observed render time |
| --- | --- | ---: | ---: |
| common/Flex | pass | 55,196 | 147.56 ms |
| Grid | pass | 54,920 | 28.52 ms |

The first call includes renderer/font warm-up, so these timings are diagnostic observations rather than a benchmark claim.

The production SafeRichLayout suite also verifies deterministic repeated PNG bytes, actual 1080 × 1440 PNG dimensions, explicit CJK + Latin mixed-text font coverage, SVG diagnostics, missing-image fail-closed behavior, rejection of unknown/unapproved object fields, and rejection of malformed runtime input before renderer execution.

SafeRichLayout uses a bounded **deterministic clipping** overflow policy at the fixed 1080 × 1440 page boundary. Content may exceed the logical page height within the existing node/depth/size bounds; the renderer clips at the page boundary rather than attempting unbounded layout growth or silently changing the output canvas size.

Bake-off verify evidence from run 35542917263:

- `test/safe-rich-layout.test.ts`: 11/11 passed;
- temporary bake-off evidence test: passed;
- 33 test files / 296 tests passed before browser tests;
- the `verify` job passed while other jobs still exposed the then-stale lockfile.

After committing the generated lockfile and removing temporary Satori/resvg dependencies and the temporary bake-off test, final branch CI run 35543177907 passed **all jobs**:

- `verify`: passed;
- `browser-runtime-smoke`: passed;
- `browser-provider-smokes`: passed with `npm ci`;
- `web-runtime-smoke`: passed;
- production `test/safe-rich-layout.test.ts`: 11/11 passed.

## Satori + resvg reference

The Satori + resvg reference was exercised with the same pinned Fontsource CJK WOFF2 strategy. Current Satori failed before layout rendering with:

```text
Unsupported OpenType signature wOF2
```

This is a reference-compatibility limitation. Publisher does not change its font contract solely to make the reference renderer green.

Satori/resvg are therefore not retained as runtime or test dependencies after the bake-off.

## Environment gap

Linux x64 is verified by CI. Takumi publishes native packages for macOS, Windows, Linux glibc, and Linux musl across its listed arm64/x64 targets, but this work item does **not** claim a macOS or Windows runtime smoke was executed.


## Review hardening

A focused self-review after the initial green CI identified and fixed three contract gaps before merge:

- schema validation now rejects unknown fields at the layout root, page, gradient and every node type rather than merely ignoring them;
- Noto Sans SC registers explicit `chinese-simplified` and `latin` coverage subsets through Takumi's `subsetOf/subsetRank` mechanism;
- vertical overflow semantics are explicit and tested as deterministic page clipping.

The final CI evidence for these hardening changes is recorded on the PR once the current head completes.
