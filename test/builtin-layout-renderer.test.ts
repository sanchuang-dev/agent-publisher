import { describe, expect, test } from "vitest";

import {
  BuiltinLayoutRenderer,
  SafeLayoutOverflowError,
  SafeLayoutResourceError,
  SafeRichLayoutValidationError,
  loadBuiltinCjkFonts,
  validateSafeRichLayout,
} from "../src/materials/layout/index.js";

const tinyPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);

function representativeLayout(): unknown {
  return {
    type: "page",
    width: 1080,
    height: 1440,
    background: {
      kind: "linear-gradient",
      angle: 145,
      from: "#F7F8FC",
      to: "#EDE9FE",
    },
    children: [
      {
        type: "stack",
        direction: "column",
        style: {
          padding: 72,
          gap: 36,
        },
        children: [
          {
            type: "badge",
            text: "MIRA · PUBLISHER",
            style: {
              background: { kind: "solid", color: "#5B5EF7" },
              color: "#FFFFFF",
              padding: 16,
              borderRadius: 20,
              fontSize: 24,
              fontWeight: 700,
            },
          },
          {
            type: "heading",
            level: 1,
            text: "把发布工作交给 AI 员工",
            style: {
              color: "#171923",
              fontSize: 76,
              fontWeight: 800,
              lineHeight: 1.16,
            },
          },
          {
            type: "text",
            text: "从内容准备到发布审批，保持过程可见、可接管。中文换行必须稳定。",
            style: {
              color: "#4A5568",
              fontSize: 34,
              lineHeight: 1.55,
            },
          },
          {
            type: "grid",
            columns: 2,
            style: {
              gap: 24,
            },
            children: [
              {
                type: "card",
                style: {
                  background: { kind: "solid", color: "#FFFFFF" },
                  padding: 28,
                  gap: 18,
                  borderRadius: 28,
                  borderWidth: 1,
                  borderColor: "#E2E8F0",
                },
                children: [
                  {
                    type: "heading",
                    level: 3,
                    text: "确定性",
                    style: { color: "#252A34" },
                  },
                  {
                    type: "text",
                    text: "Known flow 使用确定性步骤，避免自由浏览器 Agent。",
                    style: { color: "#667085", fontSize: 27 },
                  },
                ],
              },
              {
                type: "card",
                style: {
                  background: { kind: "solid", color: "#FFFFFF" },
                  padding: 28,
                  gap: 18,
                  borderRadius: 28,
                },
                children: [
                  {
                    type: "image",
                    sourceId: "hero",
                    width: 320,
                    height: 180,
                    fit: "cover",
                    borderRadius: 20,
                  },
                  {
                    type: "text",
                    text: "受控图片资源只从内存注入。",
                    style: { color: "#667085", fontSize: 27 },
                  },
                ],
              },
            ],
          },
          {
            type: "quote",
            text: "技术很酷，但过程必须可见，副作用必须可控。",
            style: {
              background: { kind: "solid", color: "#FFFFFFCC" },
              borderColor: "#5B5EF7",
              padding: 24,
              borderRadius: 18,
              color: "#303746",
            },
          },
          { type: "divider", color: "#CBD5E1", thickness: 2 },
          { type: "spacer", size: 16 },
        ],
      },
    ],
  };
}

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
    const layout = validateSafeRichLayout(representativeLayout());

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
      layout: representativeLayout(),
      resources: { hero: tinyPng },
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
        layout: representativeLayout(),
        resources: {},
      }),
    ).rejects.toBeInstanceOf(SafeLayoutResourceError);
  });
});
