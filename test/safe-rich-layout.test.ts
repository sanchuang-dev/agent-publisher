import { describe, expect, test } from "vitest";

import {
  SAFE_LAYOUT_HEIGHT,
  SAFE_LAYOUT_WIDTH,
  SafeLayoutValidationError,
  createBuiltinLayoutRenderer,
  validateSafeRichLayout,
  type SafeRichLayout,
} from "../src/materials/rendering/index.js";

const onePixelPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAAC0lEQVR4nGP4DwQACfsD/fteaysAAAAASUVORK5CYII=",
  "base64",
);

function representativeLayout(): SafeRichLayout {
  return {
    version: 1,
    page: {
      type: "page",
      width: 1080,
      height: 1440,
      padding: 72,
      gap: 36,
      background: {
        kind: "linear-gradient",
        angle: 135,
        from: "#F4F1FF",
        to: "#FFFFFF",
      },
      children: [
        {
          type: "badge",
          text: "Agent Publisher",
          background: "#ECEBFF",
          color: "#4F46E5",
        },
        {
          type: "heading",
          level: 1,
          text: "把发布工作交给 AI 员工",
          color: "#17171B",
          maxLines: 2,
        },
        {
          type: "text",
          text: "从内容准备、物料生成到人工审批，过程保持可见、可恢复、可接管。",
          fontSize: 34,
          color: "#4B4B55",
          maxLines: 3,
        },
        {
          type: "grid",
          columns: 2,
          gap: 24,
          children: [
            {
              type: "card",
              background: "#FFFFFF",
              children: [
                {
                  type: "heading",
                  level: 3,
                  text: "确定性发布",
                  color: "#24242B",
                },
                {
                  type: "text",
                  text: "已知平台流程继续由确定性步骤负责。",
                  fontSize: 28,
                },
              ],
            },
            {
              type: "card",
              background: "#FFFFFF",
              children: [
                {
                  type: "heading",
                  level: 3,
                  text: "人工可接管",
                  color: "#24242B",
                },
                {
                  type: "text",
                  text: "登录、审批与风险边界明确交还给人。",
                  fontSize: 28,
                },
              ],
            },
          ],
        },
        {
          type: "image",
          resourceId: "hero",
          width: 936,
          height: 300,
          fit: "cover",
          radius: 28,
        },
        {
          type: "quote",
          text: "技术负责把流程做稳，人负责决定什么时候真的发布。",
          attribution: "MVP boundary",
        },
      ],
    },
  };
}

function readPngDimensions(bytes: Buffer): { width: number; height: number } {
  if (
    bytes.length < 24 ||
    bytes.subarray(1, 4).toString("ascii") !== "PNG"
  ) {
    throw new Error("not a PNG");
  }
  return {
    width: bytes.readUInt32BE(16),
    height: bytes.readUInt32BE(20),
  };
}

describe("SafeRichLayout policy", () => {
  test("accepts the representative 1080x1440 static layout", () => {
    expect(() => validateSafeRichLayout(representativeLayout())).not.toThrow();
  });

  test("rejects unsupported canvas sizes", () => {
    const layout = representativeLayout();
    expect(() =>
      validateSafeRichLayout({
        ...layout,
        page: {
          ...layout.page,
          width: 1200 as 1080,
        },
      }),
    ).toThrow(SafeLayoutValidationError);
  });

  test("rejects executable or network-shaped background input", () => {
    const layout = representativeLayout();
    expect(() =>
      validateSafeRichLayout({
        ...layout,
        page: {
          ...layout.page,
          background: "url(https://example.com/payload)" as "#FFFFFF",
        },
      }),
    ).toThrow(SafeLayoutValidationError);
  });

  test("rejects malformed runtime JSON with bounded validation errors", () => {
    expect(() => validateSafeRichLayout(null)).toThrow(
      SafeLayoutValidationError,
    );

    const layout = representativeLayout();
    const unsafe = {
      ...layout,
      page: {
        ...layout.page,
        children: [
          {
            type: "stack",
            direction: "diagonal",
            align: "teleport",
            children: [{ type: "text", text: "invalid enum" }],
          },
        ],
      },
    };

    expect(() => validateSafeRichLayout(unsafe)).toThrow(
      SafeLayoutValidationError,
    );
  });

  test("rejects unsupported image fit and text weight from untrusted input", () => {
    const layout = representativeLayout();
    const unsafe = {
      ...layout,
      page: {
        ...layout.page,
        children: [
          {
            type: "image",
            resourceId: "hero",
            width: 100,
            height: 100,
            fit: "url(https://example.com)",
          },
          {
            type: "text",
            text: "bounded",
            weight: 999,
          },
        ],
      },
    };

    expect(() => validateSafeRichLayout(unsafe)).toThrow(
      SafeLayoutValidationError,
    );
  });

  test("rejects unsupported runtime node types instead of ignoring them", () => {
    const layout = representativeLayout();
    const unsafe = {
      ...layout,
      page: {
        ...layout.page,
        children: [
          ...layout.page.children,
          { type: "script", text: "fetch('https://example.com')" },
        ],
      },
    } as unknown as SafeRichLayout;

    expect(() => validateSafeRichLayout(unsafe)).toThrow(
      SafeLayoutValidationError,
    );
  });

  test("rejects oversized text before rendering", () => {
    const layout = representativeLayout();
    const unsafe = {
      ...layout,
      page: {
        ...layout.page,
        children: [
          {
            type: "text",
            text: "长".repeat(1201),
          },
        ],
      },
    } as SafeRichLayout;

    expect(() => validateSafeRichLayout(unsafe)).toThrow(
      SafeLayoutValidationError,
    );
  });

  test("rejects excessive nesting", () => {
    let child: unknown = { type: "text", text: "底" };
    for (let index = 0; index < 10; index += 1) {
      child = {
        type: "stack",
        direction: "column",
        children: [child],
      };
    }

    const unsafe = {
      version: 1,
      page: {
        type: "page",
        width: 1080,
        height: 1440,
        children: [child],
      },
    } as unknown as SafeRichLayout;

    expect(() => validateSafeRichLayout(unsafe)).toThrow(
      SafeLayoutValidationError,
    );
  });
});

describe("BuiltinLayoutRenderer", () => {
  test("renders deterministic CJK PNG bytes with explicit self-hosted fonts", async () => {
    const renderer = createBuiltinLayoutRenderer();
    const layout = representativeLayout();
    const resources = { hero: onePixelPng };

    const first = await renderer.render(layout, resources);
    const second = await renderer.render(layout, resources);

    expect(first.engine).toBe("takumi");
    expect(first.mimeType).toBe("image/png");
    expect(first.width).toBe(SAFE_LAYOUT_WIDTH);
    expect(first.height).toBe(SAFE_LAYOUT_HEIGHT);
    expect(first.bytes.equals(second.bytes)).toBe(true);
    expect(readPngDimensions(first.bytes)).toEqual({
      width: SAFE_LAYOUT_WIDTH,
      height: SAFE_LAYOUT_HEIGHT,
    });
    expect(first.bytes.byteLength).toBeGreaterThan(10_000);
  }, 20_000);

  test("renders SVG without exposing Takumi node/HTML types in the public input", async () => {
    const renderer = createBuiltinLayoutRenderer();
    const svg = await renderer.renderSvg(representativeLayout(), {
      hero: onePixelPng,
    });

    expect(svg.startsWith("<svg")).toBe(true);
    expect(svg).toContain('width="1080"');
    expect(svg).toContain('height="1440"');
  }, 20_000);

  test("fails before renderer execution when an image resource is missing", async () => {
    const renderer = createBuiltinLayoutRenderer();

    await expect(renderer.render(representativeLayout(), {})).rejects.toBeInstanceOf(
      SafeLayoutValidationError,
    );
  });
});
