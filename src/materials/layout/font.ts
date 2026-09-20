import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { readFile, readdir } from "node:fs/promises";

import type { FontDetails } from "@takumi-rs/core";

import { builtinLayoutFontFamily } from "./takumi-compiler.js";

const require = createRequire(import.meta.url);

export const builtinCjkFontPackage =
  "@fontsource-variable/noto-sans-sc" as const;
export const builtinCjkFontLicense = "OFL-1.1" as const;

let cachedFonts: Promise<readonly FontDetails[]> | null = null;

async function loadFonts(): Promise<readonly FontDetails[]> {
  const packageEntry = require.resolve(builtinCjkFontPackage);
  const packageRoot = dirname(packageEntry);
  const filesDirectory = join(packageRoot, "files");
  const fileNames = (await readdir(filesDirectory))
    .filter(
      (name) =>
        name.startsWith("noto-sans-sc-") &&
        name.endsWith("-wght-normal.woff2"),
    )
    .sort();

  if (fileNames.length === 0) {
    throw new Error(
      `No Noto Sans SC variable font subsets found in ${builtinCjkFontPackage}`,
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
export function loadBuiltinCjkFonts(): Promise<readonly FontDetails[]> {
  cachedFonts ??= loadFonts();
  return cachedFonts;
}
