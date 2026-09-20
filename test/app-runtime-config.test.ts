import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test } from "vitest";

import {
  createControlledAssetResolver,
  loadControlledRuntimeMaterial,
  resolveApplicationHost,
  resolveApplicationPort,
} from "../src/app/runtime-config.js";
import {
  CONTROLLED_SMOKE_MATERIAL_SOURCE,
  PROVIDER_PIPELINE_MATERIAL_SOURCE,
  serializePrepublishMaterial,
} from "../src/app/prepublish-material-source.js";
import { createImageTextMaterialPackFixture } from "../src/materials/testing/fake-providers.js";

describe("APP-02 runtime configuration", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  test("loads only explicitly controlled material provenance", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-runtime-config-"));
    cleanupRoots.push(root);
    const materialPath = join(root, "material.json");
    const pack = createImageTextMaterialPackFixture();

    writeFileSync(
      materialPath,
      serializePrepublishMaterial({
        source: CONTROLLED_SMOKE_MATERIAL_SOURCE,
        generatedFromBrief: false,
        pack,
      }),
    );

    expect(loadControlledRuntimeMaterial(materialPath)).toMatchObject({
      source: "controlled_smoke",
      generatedFromBrief: false,
      pack: {
        mode: "image_text",
        planId: pack.planId,
      },
    });

    writeFileSync(
      materialPath,
      serializePrepublishMaterial({
        source: PROVIDER_PIPELINE_MATERIAL_SOURCE,
        generatedFromBrief: true,
        pack,
      }),
    );

    expect(() => loadControlledRuntimeMaterial(materialPath)).toThrow(
      /must declare controlled_smoke provenance/,
    );
  });

  test("resolves assets only inside the configured controlled root", () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-runtime-assets-"));
    cleanupRoots.push(root);
    const assets = join(root, "assets");
    mkdirSync(assets);

    const pack = createImageTextMaterialPackFixture();
    const coverPath = join(assets, pack.cover.assetId + ".png");
    writeFileSync(coverPath, "fixture");

    const resolver = createControlledAssetResolver(assets);

    expect(resolver(pack.cover)).toBe(resolve(coverPath));
    expect(() =>
      resolver({
        ...pack.cover,
        assetId: "../escape",
      }),
    ).toThrow(/safe filename contract/);
    expect(() =>
      resolver({
        ...pack.cover,
        mimeType: "image/svg+xml",
      }),
    ).toThrow(/mime type is unsupported/);
  });

  test("uses bounded host and port defaults", () => {
    expect(resolveApplicationHost({})).toBe("127.0.0.1");
    expect(resolveApplicationPort({})).toBe(3000);
    expect(resolveApplicationPort({ APP_PORT: "4310" })).toBe(4310);
    expect(() => resolveApplicationPort({ APP_PORT: "0" })).toThrow(
      /between 1 and 65535/,
    );
    expect(() => resolveApplicationPort({ APP_PORT: "not-a-port" })).toThrow(
      /between 1 and 65535/,
    );
  });

  test("Compose keeps app HTTP local while CDP stays internal", () => {
    const compose = readFileSync(
      resolve(import.meta.dirname, "..", "compose.yaml"),
      "utf8",
    );

    expect(compose).toMatch(/app-runtime:/);
    expect(compose).toMatch(/profiles:\n\s+- app/);
    expect(compose).toMatch(/127\.0\.0\.1:3000:3000/);
    expect(compose).toMatch(
      /BROWSER_CDP_ENDPOINT: "http:\/\/browser-runtime:9222"/,
    );
    expect(compose).not.toMatch(
      /(?:^|\n)\s*-\s*"(?:127\.0\.0\.1:)?9222:9222"/m,
    );
  });
});
