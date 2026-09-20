import { describe, expect, test } from "vitest";

import {
  BuiltinLayoutRenderer,
  SafeLayoutOverflowError,
  SafeLayoutResourceError,
  SafeRichLayoutValidationError,
  loadBuiltinCjkFonts,
  validateSafeRichLayout,
} from "../src/materials/layout/index.js";

import {
  representativeSafeRichLayout,
  tinySafeLayoutPng,
} from "./fixtures/safe-rich-layout.js";

function pngDimensions(buffer: Buffer): { width: number; height: number } {
  expect(buffer.subarray(0, 8)).toEqual(
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
  );
  return {
    width: buffer.readUInt32BE(16),
    height: buffer.readUInt32BE(20),
  };
}

describe("SafeRichLayout policy", () => {
  test("accepts the representative bounded social-card fixture", () => {
    const layout = validateSafeRichLayout(representativeSafeRichLayout());

    expect(layout.type).toBe("page");
    expect(layout.width).toBe(1080);
    expect(layout.height).toBe(1440);
    expect(layout.children).toHaveLength(1);
  });

  test("rejects executable/escape-hatch fields instead of ignoring them", () => {
    expect(() =>
      validateSafeRichLayout({
        type: "page",
        width: 1080,
        height: 1440,
        children: [],
        script: "fetch('https://example.invalid')",
      }),
    ).toThrow(SafeRichLayoutValidationError);
  });

  test("rejects URL/path shaped image sources", () => {
    expect(() =>
      validateSafeRichLayout({
        type: "page",
        width: 1080,
        height: 1440,
        children: [
          {
            type: "image",
            sourceId: "https://example.invalid/image.png",
            width: 100,
            height: 100,
          },
        ],
      }),
    ).toThrow(SafeRichLayoutValidationError);

    expect(() =>
      validateSafeRichLayout({
        type: "page",
        width: 1080,
        height: 1440,
        children: [
          {
            type: "image",
            sourceId: "../secret.png",
            width: 100,
            height: 100,
          },
        ],
      }),
    ).toThrow(SafeRichLayoutValidationError);
  });

  test("rejects unsupported canvas sizes instead of silently resizing", () => {
    expect(() =>
      validateSafeRichLayout({
        type: "page",
        width: 1200,
        height: 630,
        children: [],
      }),
    ).toThrow(SafeRichLayoutValidationError);
  });
});

describe("BuiltinLayoutRenderer", () => {
  test("loads explicit bundled Simplified Chinese font subsets", async () => {
    const fonts = await loadBuiltinCjkFonts();

    expect(fonts.length).toBeGreaterThan(0);
    for (const font of fonts) {
      expect(font.name).toBe("Noto Sans SC");
      expect(font.data.byteLength).toBeGreaterThan(1000);
    }
  });

  test("renders real deterministic 1080x1440 PNG/SVG with CJK, grid, flex, image, gradient and radius", async () => {
    const renderer = new BuiltinLayoutRenderer();
    const input = {
      layout: representativeSafeRichLayout(),
      resources: { hero: tinySafeLayoutPng },
    };

    const first = await renderer.render(input);
    const second = await renderer.render(input);

    expect(first.renderer).toBe("takumi");
    expect(pngDimensions(first.png)).toEqual({
      width: 1080,
      height: 1440,
    });
    expect(first.png.byteLength).toBeGreaterThan(10_000);
    expect(first.svg).toContain("<svg");
    expect(first.svg).toContain('width="1080"');
    expect(first.svg).toContain('height="1440"');
    expect(second.png.equals(first.png)).toBe(true);
    expect(second.svg).toBe(first.svg);
  }, 20_000);

  test("fails closed when content measures beyond the fixed page canvas", async () => {
    const renderer = new BuiltinLayoutRenderer();
    const oversized = {
      type: "page",
      width: 1080,
      height: 1440,
      children: [
        {
          type: "stack",
          direction: "column",
          children: [
            {
              type: "card",
              style: { height: 1000 },
              children: [{ type: "text", text: "第一块" }],
            },
            {
              type: "card",
              style: { height: 1000 },
              children: [{ type: "text", text: "第二块" }],
            },
          ],
        },
      ],
    };

    await expect(
      renderer.render({ layout: oversized }),
    ).rejects.toBeInstanceOf(SafeLayoutOverflowError);
  }, 20_000);

  test("fails closed when a referenced image resource is not supplied", async () => {
    const renderer = new BuiltinLayoutRenderer();

    await expect(
      renderer.render({
        layout: representativeSafeRichLayout(),
        resources: {},
      }),
    ).rejects.toBeInstanceOf(SafeLayoutResourceError);
  });
});
