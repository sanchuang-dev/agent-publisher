import { createHash } from "node:crypto";

import { AssetAlreadyExistsError } from "../contracts/asset.js";
import type { AssetStore } from "../assets/store.js";
import type {
  DesignRenderInput,
  DesignRenderResult,
  ImageAssetReference,
  MaterialPlan,
  MaterialProviderFailure,
  ProviderResult,
  TextMaterial,
} from "./contracts.js";
import type {
  DesignProvider,
  ImageProvider,
  MaterialProviderSlots,
  TextProvider,
} from "./providers/index.js";
import {
  SAFE_LAYOUT_HEIGHT,
  SAFE_LAYOUT_WIDTH,
  createBuiltinLayoutRenderer,
  type BuiltinLayoutRenderer,
  type SafeRichLayout,
} from "./rendering/index.js";

const BUILTIN_TITLE_LIMIT = 48;
const BUILTIN_BODY_LIMIT = 1200;

function success<T>(value: T): ProviderResult<T> {
  return { ok: true, value, warnings: [] };
}

function failure(
  slot: MaterialProviderFailure["slot"],
  code: MaterialProviderFailure["code"],
  message: string,
  retryable = false,
): ProviderResult<never> {
  return {
    ok: false,
    error: { slot, code, message, retryable },
  };
}

function boundedText(value: string, maxLength: number): string {
  return Array.from(value.trim()).slice(0, maxLength).join("");
}

function materialTitle(plan: MaterialPlan): string {
  const compact = plan.brief.brief.replace(/\s+/g, " ").trim();
  return boundedText(compact, BUILTIN_TITLE_LIMIT);
}

function canonicalImageReference(assetId: string): ImageAssetReference {
  return {
    kind: "image",
    assetId,
    uri: `asset://${assetId}`,
    mimeType: "image/png",
    width: SAFE_LAYOUT_WIDTH,
    height: SAFE_LAYOUT_HEIGHT,
  };
}

async function persistRenderedImage(
  store: AssetStore,
  bytes: Buffer,
  metadata: {
    readonly role: string;
    readonly index: number;
  },
): Promise<ImageAssetReference> {
  const digest = createHash("sha256").update(bytes).digest("hex");
  const assetId = `material-${digest}`;

  try {
    await store.put({
      id: assetId,
      kind: "image",
      mimeType: "image/png",
      bytes,
      metadata: {
        width: SAFE_LAYOUT_WIDTH,
        height: SAFE_LAYOUT_HEIGHT,
        role: metadata.role,
        index: metadata.index,
        renderer: "takumi",
      },
    });
  } catch (error) {
    if (!(error instanceof AssetAlreadyExistsError)) {
      throw error;
    }

    const existing = await store.read(assetId);
    if (!existing.equals(bytes)) {
      throw new Error(
        `Publisher asset ${assetId} already exists with different bytes.`,
      );
    }
  }

  return canonicalImageReference(assetId);
}

function sourceLayout(
  plan: MaterialPlan,
  index: number,
  count: number,
): SafeRichLayout {
  return {
    version: 1,
    page: {
      type: "page",
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
      padding: 72,
      gap: 40,
      background: {
        kind: "linear-gradient",
        angle: index % 2 === 0 ? 135 : 45,
        from: "#F4F1FF",
        to: "#FFFFFF",
      },
      children: [
        {
          type: "badge",
          text: `Builtin ${index + 1}/${count}`,
          background: "#ECEBFF",
          color: "#4F46E5",
        },
        {
          type: "heading",
          level: 1,
          text: materialTitle(plan),
          color: "#17171B",
          maxLines: 3,
        },
        {
          type: "card",
          background: "#FFFFFF",
          padding: 36,
          children: [
            {
              type: "text",
              text: boundedText(plan.brief.brief, 360),
              fontSize: 34,
              color: "#4B4B55",
              maxLines: 8,
            },
          ],
        },
      ],
    },
  };
}

function designedLayout(
  input: DesignRenderInput,
  index: number,
  sourceResourceId: string,
): SafeRichLayout {
  const isCover = index === -1;
  const pageNumber = isCover ? 0 : index + 1;

  return {
    version: 1,
    page: {
      type: "page",
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
      padding: 64,
      gap: 28,
      background: "#F8F8FC",
      children: [
        {
          type: "badge",
          text: isCover
            ? "Agent Publisher"
            : `${pageNumber} / ${input.plan.imageCount}`,
          background: "#ECEBFF",
          color: "#4F46E5",
        },
        {
          type: "heading",
          level: isCover ? 1 : 2,
          text: input.copy.title,
          color: "#17171B",
          maxLines: isCover ? 3 : 2,
        },
        {
          type: "image",
          resourceId: sourceResourceId,
          width: 952,
          height: isCover ? 760 : 820,
          fit: "cover",
          radius: 32,
        },
        {
          type: "text",
          text: boundedText(input.copy.body, isCover ? 220 : 320),
          fontSize: isCover ? 30 : 28,
          color: "#4B4B55",
          maxLines: isCover ? 4 : 6,
        },
      ],
    },
  };
}

export function createBuiltinTextProvider(): TextProvider {
  return {
    slot: "text",
    async generate(plan) {
      const brief = plan.brief.brief.trim();
      if (!brief) {
        return failure(
          "text",
          "MATERIAL_INVALID_REQUEST",
          "Builtin text generation requires a non-empty CreativeBrief.",
        );
      }

      const value: TextMaterial = {
        title: materialTitle(plan),
        body: boundedText(brief, BUILTIN_BODY_LIMIT),
        tags: [],
      };
      return success(value);
    },
  };
}

export function createBuiltinImageProvider(options: {
  readonly assetStore: AssetStore;
  readonly renderer?: BuiltinLayoutRenderer;
}): ImageProvider {
  const renderer = options.renderer ?? createBuiltinLayoutRenderer();

  return {
    slot: "image",
    async generate(plan) {
      const count =
        plan.mode === "image_text"
          ? plan.imageCount
          : plan.supportingImageCount;

      if (count < 1) {
        return success([]);
      }

      try {
        const images: ImageAssetReference[] = [];
        for (let index = 0; index < count; index += 1) {
          const rendered = await renderer.render(sourceLayout(plan, index, count));
          images.push(
            await persistRenderedImage(options.assetStore, rendered.bytes, {
              role: "builtin_source",
              index,
            }),
          );
        }
        return success(images);
      } catch (error) {
        return failure(
          "image",
          "MATERIAL_GENERATION_FAILED",
          error instanceof Error
            ? `Builtin image generation failed: ${error.message}`
            : "Builtin image generation failed.",
          true,
        );
      }
    },
  };
}

export function createBuiltinDesignProvider(options: {
  readonly assetStore: AssetStore;
  readonly renderer?: BuiltinLayoutRenderer;
}): DesignProvider {
  const renderer = options.renderer ?? createBuiltinLayoutRenderer();

  return {
    slot: "design",
    async render(input): Promise<ProviderResult<DesignRenderResult>> {
      if (input.sourceImages.length !== input.plan.imageCount) {
        return failure(
          "design",
          "MATERIAL_INVALID_REQUEST",
          `Builtin design requires exactly ${input.plan.imageCount} source images; received ${input.sourceImages.length}.`,
        );
      }

      try {
        const sourceBytes = await Promise.all(
          input.sourceImages.map(async (asset) => {
            if (asset.uri !== `asset://${asset.assetId}`) {
              throw new Error(
                `Source image ${asset.assetId} is not a canonical Publisher asset.`,
              );
            }
            return options.assetStore.read(asset.assetId);
          }),
        );

        const coverSourceId = "source";
        const coverRendered = await renderer.render(
          designedLayout(input, -1, coverSourceId),
          { [coverSourceId]: sourceBytes[0]! },
        );
        const cover = await persistRenderedImage(
          options.assetStore,
          coverRendered.bytes,
          { role: "builtin_design_cover", index: 0 },
        );

        const images: ImageAssetReference[] = [];
        for (let index = 0; index < input.plan.imageCount; index += 1) {
          const resourceId = "source";
          const rendered = await renderer.render(
            designedLayout(input, index, resourceId),
            { [resourceId]: sourceBytes[index]! },
          );
          images.push(
            await persistRenderedImage(options.assetStore, rendered.bytes, {
              role: "builtin_design_page",
              index,
            }),
          );
        }

        return success({
          source: null,
          cover,
          images,
        });
      } catch (error) {
        return failure(
          "design",
          "MATERIAL_GENERATION_FAILED",
          error instanceof Error
            ? `Builtin design rendering failed: ${error.message}`
            : "Builtin design rendering failed.",
          true,
        );
      }
    },
  };
}

export function createBuiltinMaterialProviderSlots(options: {
  readonly assetStore: AssetStore;
  readonly renderer?: BuiltinLayoutRenderer;
}): MaterialProviderSlots {
  const renderer = options.renderer ?? createBuiltinLayoutRenderer();

  return {
    text: createBuiltinTextProvider(),
    image: createBuiltinImageProvider({
      assetStore: options.assetStore,
      renderer,
    }),
    design: createBuiltinDesignProvider({
      assetStore: options.assetStore,
      renderer,
    }),
  };
}
