import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "node",
          include: ["test/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: "./web/vite.config.ts",
        test: {
          name: "web",
          include: ["web/test/**/*.test.ts", "web/test/**/*.test.tsx"],
          exclude: ["web/test/browser-smoke.test.ts"],
          environment: "jsdom",
        },
      },
    ],
  },
});
