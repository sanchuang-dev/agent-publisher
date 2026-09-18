import { describe, expect, test } from "vitest";

import {
  resolveDesignProviderFailure,
  resolveVideoProviderFailure,
} from "../src/materials/degradation.js";
import {
  createCoverFixture,
  createFakeProviderSlots,
  createFakeTextProvider,
  createImageFixtures,
  createImageTextMaterialPackFixture,
  createImageTextPlanFixture,
  createTextMaterialFixture,
  createUnavailableVideoProvider,
  createVideoMaterialPackFixture,
  createVideoPlanFixture,
  providerFailure,
} from "../src/materials/testing/fake-providers.js";

describe("material contracts", () => {
  test("image_text MaterialPlan is represented by a legal pack with cover and images", () => {
    const plan = createImageTextPlanFixture();
    const pack = createImageTextMaterialPackFixture(plan);

    expect(plan.mode).toBe("image_text");
    expect(pack.mode).toBe("image_text");
    expect(pack.planId).toBe(plan.id);
    expect(pack.status).toBe("ready");
    expect(pack.cover.kind).toBe("image");
    expect(pack.images).toHaveLength(plan.imageCount);
    expect("video" in pack).toBe(false);
  });

  test("video MaterialPlan is represented by video, cover and optional supporting images", () => {
    const plan = createVideoPlanFixture();
    const pack = createVideoMaterialPackFixture(plan);

    expect(plan.mode).toBe("video");
    expect(pack.mode).toBe("video");
    expect(pack.planId).toBe(plan.id);
    expect(pack.status).toBe("ready");
    expect(pack.video.kind).toBe("video");
    expect(pack.cover.kind).toBe("image");
    expect(pack.images).toHaveLength(plan.supportingImageCount);
  });

  test("provider failure uses the stable product-domain error contract", async () => {
    const provider = createUnavailableVideoProvider("maintenance window");
    const result = await provider.generate(createVideoPlanFixture());

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected provider failure");
    }

    expect(result.error).toEqual({
      slot: "video",
      code: "MATERIAL_PROVIDER_UNAVAILABLE",
      message: "maintenance window",
      retryable: true,
    });
  });

  test("video provider unavailable fails explicitly when degradation is not allowed", async () => {
    const plan = createVideoPlanFixture("fail");
    const result = await createUnavailableVideoProvider().generate(plan);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected provider failure");
    }

    const resolution = resolveVideoProviderFailure(
      plan,
      {
        copy: createTextMaterialFixture(),
        cover: createCoverFixture(),
        images: createImageFixtures(plan.supportingImageCount),
      },
      result.error,
    );

    expect(resolution.ok).toBe(false);
    if (resolution.ok) {
      throw new Error("expected explicit failure");
    }
    expect(resolution.error.code).toBe("MATERIAL_PROVIDER_UNAVAILABLE");
  });

  test("allowed video degradation preserves the dependable text and image baseline", async () => {
    const plan = createVideoPlanFixture("allow_without_video");
    const result = await createUnavailableVideoProvider().generate(plan);
    const cover = createCoverFixture();
    const images = createImageFixtures(plan.supportingImageCount);

    expect(result.ok).toBe(false);
    if (result.ok) {
      throw new Error("expected provider failure");
    }

    const resolution = resolveVideoProviderFailure(
      plan,
      {
        copy: createTextMaterialFixture(),
        cover,
        images,
      },
      result.error,
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error("expected explicit video degradation");
    }

    const pack = resolution.value;
    expect(pack.mode).toBe("video");
    expect(pack.status).toBe("ready_with_degradation");
    expect(pack.video).toBeNull();
    expect(pack.cover).toBe(cover);
    expect(pack.images).toBe(images);
    expect(pack.degradations[0].originalMode).toBe("video");
    expect(pack.degradations[0].resultingMode).toBe("video");
    expect(pack.degradations[0].reason.length).toBeGreaterThan(0);
    expect(pack.warnings[0]?.userVisible).toBe(true);
    expect("video" in pack).toBe(true);
  });

  test("optional design failure can degrade without losing image_text baseline assets", () => {
    const plan = createImageTextPlanFixture();
    const cover = createCoverFixture();
    const images = createImageFixtures(plan.imageCount);
    const failure = providerFailure(
      "design",
      "MATERIAL_PROVIDER_UNAVAILABLE",
      "design provider offline",
      true,
    );

    expect(failure.ok).toBe(false);
    if (failure.ok) {
      throw new Error("expected provider failure");
    }

    const resolution = resolveDesignProviderFailure(
      plan,
      {
        copy: createTextMaterialFixture(),
        cover,
        images,
      },
      failure.error,
    );

    expect(resolution.ok).toBe(true);
    if (!resolution.ok) {
      throw new Error("expected optional design degradation");
    }

    expect(resolution.value.mode).toBe("image_text");
    expect(resolution.value.status).toBe("ready_with_degradation");
    expect(resolution.value.cover).toBe(cover);
    expect(resolution.value.images).toBe(images);
    expect(resolution.value.design).toBeNull();
    expect(resolution.value.warnings[0]?.userVisible).toBe(true);
  });

  test("fake provider slots accept the plans needed by later pipeline tests", async () => {
    const text = createFakeTextProvider();
    const providers = createFakeProviderSlots({ text });
    const imageTextPlan = createImageTextPlanFixture();
    const videoPlan = createVideoPlanFixture();

    const textResult = await providers.text.generate(imageTextPlan);
    const imageResult = await providers.image.generate(videoPlan);
    const designResult = await providers.design?.render(imageTextPlan);
    const videoResult = await providers.video?.generate(videoPlan);

    expect(textResult.ok).toBe(true);
    expect(imageResult.ok).toBe(true);
    expect(designResult?.ok).toBe(true);
    expect(videoResult?.ok).toBe(true);
    expect(text.calls[0]).toBe(imageTextPlan);
    expect(providers.image.slot).toBe("image");
    expect(providers.video?.slot).toBe("video");

    if (videoResult?.ok) {
      expect(videoResult.value.kind).toBe("video");
      expect("cover" in videoResult.value).toBe(false);
    }
  });
});
