import type {
  DesignAssetReference,
  DesignRenderInput,
  DesignRenderResult,
  ImageAssetReference,
  ImageTextCreativeBrief,
  ImageTextMaterialPack,
  ImageTextMaterialPlan,
  MaterialPlan,
  MaterialProviderFailure,
  ProviderResult,
  ReadyVideoMaterialPack,
  TextMaterial,
  VideoAssetReference,
  VideoCreativeBrief,
  VideoMaterialPlan,
} from "../contracts.js";
import type {
  DesignProvider,
  ImageProvider,
  MaterialProviderSlots,
  TextProvider,
  VideoProvider,
} from "../providers/index.js";

function providerSuccess<T>(value: T): ProviderResult<T> {
  return { ok: true, value, warnings: [] };
}

export function providerFailure(
  slot: MaterialProviderFailure["slot"],
  code: MaterialProviderFailure["code"],
  message: string,
  retryable = false,
): ProviderResult<never> {
  return {
    ok: false,
    error: {
      slot,
      code,
      message,
      retryable,
    },
  };
}

export interface FakeTextProvider extends TextProvider {
  readonly calls: MaterialPlan[];
}

export interface FakeImageProvider extends ImageProvider {
  readonly calls: MaterialPlan[];
}

export interface FakeDesignProvider extends DesignProvider {
  readonly calls: DesignRenderInput[];
}

export interface FakeVideoProvider extends VideoProvider {
  readonly calls: VideoMaterialPlan[];
}

export function createImageTextPlanFixture(): ImageTextMaterialPlan {
  const brief: ImageTextCreativeBrief = {
    id: "brief-image-text",
    brief: "给 Agent Publisher 做一篇图文介绍",
    platform: "xiaohongshu",
    mode: "image_text",
  };

  return {
    id: "plan-image-text",
    mode: "image_text",
    brief,
    imageCount: 2,
    coverRequired: true,
    design: "optional",
  };
}

export function createVideoPlanFixture(
  onVideoUnavailable: VideoMaterialPlan["onVideoUnavailable"] = "fail",
): VideoMaterialPlan {
  const brief: VideoCreativeBrief = {
    id: "brief-video",
    brief: "给 Agent Publisher 做一条视频介绍",
    platform: "xiaohongshu",
    mode: "video",
  };

  return {
    id: "plan-video",
    mode: "video",
    brief,
    coverRequired: true,
    supportingImageCount: 1,
    onVideoUnavailable,
  };
}

export function createTextMaterialFixture(): TextMaterial {
  return {
    title: "把发布工作交给 AI 员工",
    body: "从内容准备到发布审批，保持过程可见、可接管。",
    tags: ["AI员工", "内容运营"],
  };
}

function createImageReference(
  assetId: string,
): ImageAssetReference {
  return {
    kind: "image",
    assetId,
    uri: `asset://fixture/${assetId}`,
    mimeType: "image/png",
    width: 1080,
    height: 1440,
  };
}

export function createCoverFixture(): ImageAssetReference {
  return createImageReference("cover-1");
}

export function createImageFixtures(count = 2): readonly ImageAssetReference[] {
  return Array.from({ length: count }, (_, index) =>
    createImageReference(`image-${index + 1}`),
  );
}

export function createDesignSourceFixture(): DesignAssetReference {
  return {
    kind: "design",
    assetId: "design-source-1",
    uri: "asset://fixture/design-source-1",
    mimeType: "application/json",
  };
}

export function createDesignRenderResultFixture(
  plan: ImageTextMaterialPlan = createImageTextPlanFixture(),
): DesignRenderResult {
  return {
    source: createDesignSourceFixture(),
    cover: createImageReference("design-cover-1"),
    images: Array.from({ length: plan.imageCount }, (_, index) =>
      createImageReference(`design-image-${index + 1}`),
    ),
  };
}

export function createVideoAssetFixture(): VideoAssetReference {
  return {
    kind: "video",
    assetId: "video-1",
    uri: "asset://fixture/video-1",
    mimeType: "video/mp4",
    durationMs: 15000,
  };
}

export function createImageTextMaterialPackFixture(
  plan: ImageTextMaterialPlan = createImageTextPlanFixture(),
): ImageTextMaterialPack {
  return {
    mode: "image_text",
    status: "ready",
    planId: plan.id,
    copy: createTextMaterialFixture(),
    cover: createCoverFixture(),
    images: createImageFixtures(plan.imageCount),
    design: null,
    warnings: [],
    degradations: [],
  };
}

export function createVideoMaterialPackFixture(
  plan: VideoMaterialPlan = createVideoPlanFixture(),
): ReadyVideoMaterialPack {
  return {
    mode: "video",
    status: "ready",
    planId: plan.id,
    copy: createTextMaterialFixture(),
    cover: createCoverFixture(),
    images: createImageFixtures(plan.supportingImageCount),
    design: null,
    video: createVideoAssetFixture(),
    warnings: [],
    degradations: [],
  };
}

export function createFakeTextProvider(
  result: ProviderResult<TextMaterial> = providerSuccess(
    createTextMaterialFixture(),
  ),
): FakeTextProvider {
  const calls: MaterialPlan[] = [];

  return {
    slot: "text",
    calls,
    async generate(plan) {
      calls.push(plan);
      return result;
    },
  };
}

export function createFakeImageProvider(
  result: ProviderResult<readonly ImageAssetReference[]> = providerSuccess(
    createImageFixtures(),
  ),
): FakeImageProvider {
  const calls: MaterialPlan[] = [];

  return {
    slot: "image",
    calls,
    async generate(plan) {
      calls.push(plan);
      return result;
    },
  };
}

export function createFakeDesignProvider(
  result: ProviderResult<DesignRenderResult> = providerSuccess(
    createDesignRenderResultFixture(),
  ),
): FakeDesignProvider {
  const calls: DesignRenderInput[] = [];

  return {
    slot: "design",
    calls,
    async render(input) {
      calls.push(input);
      return result;
    },
  };
}

export function createFakeVideoProvider(
  result: ProviderResult<VideoAssetReference> = providerSuccess(
    createVideoAssetFixture(),
  ),
): FakeVideoProvider {
  const calls: VideoMaterialPlan[] = [];

  return {
    slot: "video",
    calls,
    async generate(plan) {
      calls.push(plan);
      return result;
    },
  };
}

export function createUnavailableVideoProvider(
  message = "Video provider is temporarily unavailable.",
): FakeVideoProvider {
  return createFakeVideoProvider(
    providerFailure(
      "video",
      "MATERIAL_PROVIDER_UNAVAILABLE",
      message,
      true,
    ),
  );
}

export function createFakeProviderSlots(
  overrides: Partial<MaterialProviderSlots> = {},
): MaterialProviderSlots {
  return {
    text: overrides.text ?? createFakeTextProvider(),
    image: overrides.image ?? createFakeImageProvider(),
    design: overrides.design ?? createFakeDesignProvider(),
    video: overrides.video ?? createFakeVideoProvider(),
  };
}
