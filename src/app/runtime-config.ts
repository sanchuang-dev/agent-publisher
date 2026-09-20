import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

import type { ImageAssetReference } from "../materials/contracts.js";
import {
  CONTROLLED_SMOKE_MATERIAL_SOURCE,
  createControlledMaterialSource,
  parsePrepublishMaterial,
} from "./prepublish-material-source.js";
import {
  createMvpPrepublishApplication,
  type MvpPrepublishApplication,
} from "./mvp-prepublish-application.js";

export const APP_CONTROLLED_MATERIAL_PATH_ENV =
  "APP_CONTROLLED_MATERIAL_PATH" as const;
export const APP_CONTROLLED_ASSET_ROOT_ENV =
  "APP_CONTROLLED_ASSET_ROOT" as const;
export const APP_BROWSER_LIVE_VIEW_URL_ENV =
  "APP_BROWSER_LIVE_VIEW_URL" as const;
export const APP_HOST_ENV = "APP_HOST" as const;
export const APP_PORT_ENV = "APP_PORT" as const;

const MIME_EXTENSION: Readonly<Record<string, string>> = {
  "image/png": ".png",
  "image/jpeg": ".jpg",
  "image/webp": ".webp",
};

function requiredEnv(env: NodeJS.ProcessEnv, name: string): string {
  const value = env[name]?.trim();
  if (!value) {
    throw new Error(`Required runtime environment variable is missing: ${name}`);
  }
  return value;
}

export function resolveApplicationPort(env: NodeJS.ProcessEnv): number {
  const raw = env[APP_PORT_ENV]?.trim() || "3000";
  const port = Number(raw);

  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`${APP_PORT_ENV} must be an integer between 1 and 65535`);
  }

  return port;
}

export function resolveApplicationHost(env: NodeJS.ProcessEnv): string {
  return env[APP_HOST_ENV]?.trim() || "127.0.0.1";
}

export function loadControlledRuntimeMaterial(
  materialPath: string,
) {
  const serialized = readFileSync(resolve(materialPath), "utf8");
  const material = parsePrepublishMaterial(serialized);

  if (
    material.source !== CONTROLLED_SMOKE_MATERIAL_SOURCE ||
    material.generatedFromBrief !== false
  ) {
    throw new Error(
      "APP-02 runtime material file must declare controlled_smoke provenance.",
    );
  }

  return material;
}

export function createControlledAssetResolver(
  assetRoot: string,
): (asset: ImageAssetReference) => string {
  const root = resolve(assetRoot);

  return (asset) => {
    if (!/^[A-Za-z0-9._-]{1,128}$/.test(asset.assetId)) {
      throw new Error("Controlled material asset id is outside the safe filename contract.");
    }

    const extension = MIME_EXTENSION[asset.mimeType];
    if (!extension) {
      throw new Error(
        `Controlled material mime type is unsupported: ${asset.mimeType}`,
      );
    }

    const candidate = resolve(root, asset.assetId + extension);
    const relativeCandidate = relative(root, candidate);
    if (
      relativeCandidate === "" ||
      relativeCandidate.startsWith("..") ||
      isAbsolute(relativeCandidate)
    ) {
      throw new Error("Controlled material asset escaped its configured root.");
    }

    const stat = statSync(candidate);
    if (!stat.isFile()) {
      throw new Error("Controlled material asset is not a regular file.");
    }

    if (extname(candidate).toLowerCase() !== extension) {
      throw new Error("Controlled material asset extension does not match its mime type.");
    }

    return candidate;
  };
}

export function createConfiguredMvpPrepublishApplication(
  env: NodeJS.ProcessEnv = process.env,
): MvpPrepublishApplication {
  const materialPath = requiredEnv(env, APP_CONTROLLED_MATERIAL_PATH_ENV);
  const assetRoot = requiredEnv(env, APP_CONTROLLED_ASSET_ROOT_ENV);
  const controlledMaterial = loadControlledRuntimeMaterial(materialPath);

  return createMvpPrepublishApplication({
    materialSource: createControlledMaterialSource(
      async () => controlledMaterial.pack,
    ),
    resolveAssetPath: createControlledAssetResolver(assetRoot),
    ...(env.DATABASE_SQLITE_PATH === undefined
      ? {}
      : { databasePath: env.DATABASE_SQLITE_PATH }),
    ...(env[APP_BROWSER_LIVE_VIEW_URL_ENV]?.trim()
      ? { browserLiveViewUrl: env[APP_BROWSER_LIVE_VIEW_URL_ENV]!.trim() }
      : {}),
  });
}
