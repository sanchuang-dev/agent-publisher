export const tinySafeLayoutPng = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=",
  "base64",
);

export function representativeSafeRichLayout(): unknown {
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
