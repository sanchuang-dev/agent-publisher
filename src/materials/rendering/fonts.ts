import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { createRequire } from "node:module";

export const BUILTIN_CJK_FONT_FAMILY = "Noto Sans SC";

export interface BuiltinFontResource {
  readonly data: Buffer;
  readonly name: typeof BUILTIN_CJK_FONT_FAMILY;
  readonly weight: 400 | 700;
}

const require = createRequire(import.meta.url);

/**
 * Loads self-hosted OFL-1.1 Noto Sans SC files from the pinned Fontsource npm
 * package. Runtime rendering does not depend on host-installed fonts or a font
 * CDN/network request.
 *
 * createRequire().resolve() is intentionally used instead of import.meta.resolve
 * so the loader behaves the same under Node and Vitest's SSR transform.
 */
export async function loadBuiltinCjkFonts(): Promise<
  readonly BuiltinFontResource[]
> {
  const packageCssPath = require.resolve("@fontsource/noto-sans-sc/400.css");
  const packageRoot = dirname(packageCssPath);

  return Promise.all(
    ([400, 700] as const).map(async (weight) => ({
      data: await readFile(
        join(
          packageRoot,
          "files",
          `noto-sans-sc-chinese-simplified-${weight}-normal.woff2`,
        ),
      ),
      name: BUILTIN_CJK_FONT_FAMILY,
      weight,
    })),
  );
}
