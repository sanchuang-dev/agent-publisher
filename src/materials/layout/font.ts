import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import type { Font } from "@takumi-rs/core";

import { builtinLayoutFontFamily } from "./takumi-compiler.js";

const require = createRequire(import.meta.url);

export const builtinCjkFontPackage =
  "@fontsource-variable/noto-sans-sc" as const;
export const builtinCjkFontLicense = "OFL-1.1" as const;

let cachedFonts: Promise<readonly Font[]> | null = null;

async function loadFonts(): Promise<readonly Font[]> {
  const packageEntry = require.resolve(builtinCjkFontPackage);
  const packageRoot = dirname(packageEntry);
  const filesDirectory = join(packageRoot, "files");
  const fileNames = (await readdir(filesDirectory))
    .filter(
      (name) =>
        name.endsWith(".woff2") &&
        name.includes("chinese-simplified") &&
        name.includes("wght"),
    )
    .sort();

  if (fileNames.length === 0) {
    throw new Error(
      `No Simplified Chinese variable font files found in ${builtinCjkFontPackage}`,
    );
  }

  return Promise.all(
    fileNames.map(async (fileName) => ({
      name: builtinLayoutFontFamily,
      data: await readFile(join(filesDirectory, fileName)),
      style: "normal" as const,
    })),
  );
}

/**
 * Loads the bundled Fontsource CJK subsets exactly once.
 *
 * The renderer never falls back to host-installed fonts for its declared CJK
 * family, which keeps Linux/macOS output independent from workstation setup.
 */
export function loadBuiltinCjkFonts(): Promise<readonly Font[]> {
  cachedFonts ??= loadFonts();
  return cachedFonts;
}
