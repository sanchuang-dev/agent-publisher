import { readFileSync, statSync } from "node:fs";
import { extname, isAbsolute, relative, resolve } from "node:path";

import { ContentSecretaryService } from "../agent/content-secretary.js";
import { JobAgentSessionService } from "../agent/job-session-service.js";
import {
  createPublisherAiRuntime,
  createPublisherContentSecretaryHost,
  readPublisherAiConfig,
} from "../agent/runtime-ai.js";
import {
  ASSET_ROOT_ENV,
  DEFAULT_ASSET_ROOT,
  LocalAssetStore,
} from "../assets/local-store.js";
import type { ImageAssetReference } from "../materials/contracts.js";
import {
  MaterialPreparationService,
  createBuiltinBaselineCoverProvider,
  createBuiltinMaterialProviderSlots,
} from "../materials/index.js";
import { AgentSessionBindingRepository } from "../storage/agent-session-binding-repository.js";
import { AssetRepository } from "../storage/asset-repository.js";
import {
  DEFAULT_DATABASE_PATH,
  openDatabase,
} from "../storage/db.js";
import { JobRepository } from "../storage/job-repository.js";
import {
  CONTROLLED_SMOKE_MATERIAL_SOURCE,
  createControlledMaterialSource,
  parsePrepublishMaterial,
} from "./prepublish-material-source.js";
import { createProviderPipelineMaterialSource } from "./provider-pipeline-material-source.js";
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
export const APP_BROWSER_LIVE_VIEW_UPSTREAM_ENV =
  "APP_BROWSER_LIVE_VIEW_UPSTREAM" as const;
export const APP_WEB_ROOT_ENV = "APP_WEB_ROOT" as const;
export const APP_MATERIAL_SOURCE_ENV = "APP_MATERIAL_SOURCE" as const;
export const APP_PI_SESSION_DIR_ENV = "APP_PI_SESSION_DIR" as const;
export const APP_HOST_ENV = "APP_HOST" as const;
export const APP_PORT_ENV = "APP_PORT" as const;

export const APP_MATERIAL_SOURCES = [
  "provider_pipeline",
  "controlled_smoke",
] as const;
export type AppMaterialSourceMode = (typeof APP_MATERIAL_SOURCES)[number];

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

function optionalEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = env[name]?.trim();
  return value ? value : undefined;
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

export function resolveApplicationMaterialSource(
  env: NodeJS.ProcessEnv,
): AppMaterialSourceMode {
  const raw = env[APP_MATERIAL_SOURCE_ENV]?.trim() || "provider_pipeline";
  if (raw !== "provider_pipeline" && raw !== "controlled_smoke") {
    throw new Error(
      `${APP_MATERIAL_SOURCE_ENV} must be provider_pipeline or controlled_smoke`,
    );
  }
  return raw;
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

function commonApplicationOptions(env: NodeJS.ProcessEnv) {
  return {
    databasePath:
      optionalEnv(env, "DATABASE_SQLITE_PATH") ?? DEFAULT_DATABASE_PATH,
    ...(optionalEnv(env, APP_BROWSER_LIVE_VIEW_URL_ENV) === undefined
      ? {}
      : {
          browserLiveViewUrl: optionalEnv(
            env,
            APP_BROWSER_LIVE_VIEW_URL_ENV,
          )!,
        }),
    ...(optionalEnv(env, APP_BROWSER_LIVE_VIEW_UPSTREAM_ENV) === undefined
      ? {}
      : {
          browserLiveViewUpstream: optionalEnv(
            env,
            APP_BROWSER_LIVE_VIEW_UPSTREAM_ENV,
          )!,
        }),
    ...(optionalEnv(env, APP_WEB_ROOT_ENV) === undefined
      ? {}
      : { webRoot: optionalEnv(env, APP_WEB_ROOT_ENV)! }),
  };
}

function createControlledConfiguredApplication(
  env: NodeJS.ProcessEnv,
): MvpPrepublishApplication {
  const materialPath = requiredEnv(env, APP_CONTROLLED_MATERIAL_PATH_ENV);
  const assetRoot = requiredEnv(env, APP_CONTROLLED_ASSET_ROOT_ENV);
  const controlledMaterial = loadControlledRuntimeMaterial(materialPath);

  return createMvpPrepublishApplication({
    ...commonApplicationOptions(env),
    materialSource: createControlledMaterialSource(
      async () => controlledMaterial.pack,
    ),
    resolveAssetPath: createControlledAssetResolver(assetRoot),
  });
}

async function createProviderPipelineConfiguredApplication(
  env: NodeJS.ProcessEnv,
): Promise<MvpPrepublishApplication> {
  const databasePath =
    optionalEnv(env, "DATABASE_SQLITE_PATH") ?? DEFAULT_DATABASE_PATH;
  const assetRoot =
    optionalEnv(env, ASSET_ROOT_ENV) ?? DEFAULT_ASSET_ROOT;
  const sessionDirectory =
    optionalEnv(env, APP_PI_SESSION_DIR_ENV) ?? resolve("data", "pi-sessions");

  const materialDb = openDatabase({ databasePath });

  try {
    const jobs = new JobRepository(materialDb);
    const bindings = new AgentSessionBindingRepository(materialDb);
    const assets = new AssetRepository(materialDb);
    const assetStore = new LocalAssetStore(assets, {
      rootDirectory: assetRoot,
    });

    const aiRuntime = await createPublisherAiRuntime(
      readPublisherAiConfig(env),
    );
    const host = createPublisherContentSecretaryHost(aiRuntime, {
      sessionDirectory,
    });
    const sessions = new JobAgentSessionService({
      jobs,
      bindings,
      host,
    });
    const contentSecretary = new ContentSecretaryService({
      jobs,
      bindings,
      sessions,
    });
    const providers = createBuiltinMaterialProviderSlots({
      assetStore,
    });
    const preparation = new MaterialPreparationService({
      jobs,
      providers,
      assetStore,
      baselineCover: createBuiltinBaselineCoverProvider({
        assetStore,
      }),
    });
    const materialSource = createProviderPipelineMaterialSource({
      jobs,
      contentSecretary,
      preparation,
    });

    const application = createMvpPrepublishApplication({
      ...commonApplicationOptions(env),
      materialSource,
      resolveAssetPath: (asset) => assetStore.resolveLocalPath(asset),
    });

    let stopped = false;
    return {
      ...application,
      stop: async () => {
        if (stopped) return;
        stopped = true;

        try {
          await application.stop();
        } finally {
          materialDb.close();
        }
      },
    };
  } catch (error) {
    materialDb.close();
    throw error;
  }
}

/**
 * Product runtime defaults to the real provider pipeline. Controlled smoke
 * material remains available only through the explicit controlled_smoke mode
 * used by deterministic CI/runtime fixtures.
 */
export async function createConfiguredMvpPrepublishApplication(
  env: NodeJS.ProcessEnv = process.env,
): Promise<MvpPrepublishApplication> {
  return resolveApplicationMaterialSource(env) === "controlled_smoke"
    ? createControlledConfiguredApplication(env)
    : createProviderPipelineConfiguredApplication(env);
}
