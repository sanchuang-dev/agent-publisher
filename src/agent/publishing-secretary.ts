import { isAbsolute, relative, resolve } from "node:path";

import type { ImageTextMaterialPack } from "../materials/contracts.js";
import type { AssetPathResolver } from "../platforms/xiaohongshu/image-text-prepare.js";
import type { JobRepository } from "../contracts/job.js";
import type { AgentSessionBindingRepository } from "./job-session-binding.js";
import { JobAgentSessionService } from "./job-session-service.js";
import type { AgentHost } from "./host.js";
import type { PiResourceLoaderFactoryInput } from "./pi-agent-host.js";
import type {
  PublishingSecretaryExecutionInput,
  PublishingSecretaryExecutionResult,
  PublishingSecretaryPort,
  PublishingSecretaryResultKind,
} from "./publishing-secretary-contract.js";
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  createPublishingBrowserGuardExtension,
  createPublishingBrowserMcpProfile,
  issuePublishingBrowserCapabilityGrant,
  type PublishingBrowserCapabilityGrant,
  type PublishingBrowserClickAuthorizationContext,
  type PublishingBrowserClickDecision,
} from "./publishing-browser-mcp.js";
import {
  XIAOHONGSHU_PUBLISHING_ROLE,
  createXiaohongshuPublishingDefinition,
  createXiaohongshuPublishingResourceLoader,
} from "./xiaohongshu-publishing-skill.js";

const RESULT_MARKER = "PUBLISHING_SECRETARY_RESULT=";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://creator.xiaohongshu.com",
] as const;
const MAX_RESULT_TEXT = 500;

export type PublishingSecretaryHostFactory = (
  grant: PublishingBrowserCapabilityGrant,
) => AgentHost;

export interface PublishingSecretaryServiceDependencies {
  readonly jobs: Pick<JobRepository, "getById">;
  readonly bindings: AgentSessionBindingRepository;
  readonly createHost: PublishingSecretaryHostFactory;
  readonly uploadRoot: string;
  readonly resolveAssetPath: AssetPathResolver;
  readonly allowedOrigins?: readonly string[];
  readonly runTimeoutMs?: number;
}

export class PublishingSecretaryResultError extends Error {
  readonly code = "PUBLISHING_SECRETARY_RESULT_INVALID" as const;

  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "PublishingSecretaryResultError";
  }
}

function boundedText(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new PublishingSecretaryResultError(
      `Publishing Secretary result ${label} must be a string.`,
    );
  }

  const normalized = value.trim();
  if (!normalized || normalized.length > MAX_RESULT_TEXT) {
    throw new PublishingSecretaryResultError(
      `Publishing Secretary result ${label} must contain 1-${MAX_RESULT_TEXT} characters.`,
    );
  }
  return normalized;
}

function parseResultPayload(finalText: string): {
  readonly kind: PublishingSecretaryResultKind;
  readonly summary: string;
  readonly semanticMilestone: string | null;
} {
  const markerIndex = finalText.lastIndexOf(RESULT_MARKER);
  if (markerIndex < 0) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary did not return the required structured result marker.",
    );
  }

  const raw = finalText
    .slice(markerIndex + RESULT_MARKER.length)
    .split(/\r?\n/, 1)[0]
    ?.trim();

  if (!raw) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary returned an empty structured result.",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary returned invalid structured JSON.",
      { cause: error },
    );
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary structured result must be an object.",
    );
  }

  const record = parsed as Record<string, unknown>;
  const kind = record.kind;
  if (
    kind !== "progress" &&
    kind !== "needs_identity" &&
    kind !== "prepared_candidate" &&
    kind !== "needs_clarification" &&
    kind !== "failed"
  ) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary returned an unsupported result kind.",
    );
  }

  const milestone =
    record.semanticMilestone === undefined ||
    record.semanticMilestone === null
      ? null
      : boundedText(record.semanticMilestone, "semanticMilestone");

  return {
    kind,
    summary: boundedText(record.summary, "summary"),
    semanticMilestone: milestone,
  };
}

const forbiddenObservedClick =
  /(?:发布|提交|publish|submit|删除|清空|覆盖|退出登录)/iu;

export function authorizeXiaohongshuPrepublishClick(
  context: PublishingBrowserClickAuthorizationContext,
): PublishingBrowserClickDecision {
  const observed = context.observedTarget.replace(/\s+/g, " ").trim();

  if (forbiddenObservedClick.test(observed)) {
    return {
      allowed: false,
      reason:
        "Publisher safety policy denied an irreversible or account-destructive observed control.",
    };
  }

  return { allowed: true };
}

function uniqueMaterialAssets(pack: ImageTextMaterialPack) {
  const byId = new Map<string, (typeof pack.images)[number]>();
  byId.set(pack.cover.assetId, pack.cover);
  for (const image of pack.images) {
    byId.set(image.assetId, image);
  }
  return [...byId.values()];
}

async function controlledUploadFiles(
  pack: ImageTextMaterialPack,
  uploadRoot: string,
  resolveAssetPath: AssetPathResolver,
): Promise<readonly { readonly assetId: string; readonly path: string }[]> {
  const root = resolve(uploadRoot);
  const files = [];

  for (const asset of uniqueMaterialAssets(pack)) {
    const absolute = resolve(await resolveAssetPath(asset));
    const path = relative(root, absolute);
    if (
      !path ||
      path.startsWith("..") ||
      isAbsolute(path)
    ) {
      throw new PublishingSecretaryResultError(
        `Controlled asset ${asset.assetId} is outside the Publishing Secretary upload root.`,
      );
    }
    files.push({ assetId: asset.assetId, path });
  }

  return files;
}

function buildTaskPrompt(
  input: PublishingSecretaryExecutionInput,
  uploadFiles: readonly { readonly assetId: string; readonly path: string }[],
): string {
  const material = {
    platform: "xiaohongshu",
    mode: input.materialPack.mode,
    planId: input.materialPack.planId,
    title: input.materialPack.copy.title,
    body: input.materialPack.copy.body,
    tags: input.materialPack.copy.tags,
    uploadFiles,
  };

  return [
    "Prepare the current Xiaohongshu Creator page for this accepted Publisher material.",
    "You own the page-local browser route. Observe the page, choose the next bounded safe action, act, and re-observe. You may use multiple observe/act loops while progress or new evidence exists.",
    "Do not ask Publisher code which UI control to click. Current page evidence and the reviewed Xiaohongshu Skill guide the route.",
    "Never execute final publication, delete/clear/overwrite unknown content, or bypass login/MFA/device verification.",
    "If identity verification is required, stop browser mutation once recognized and return needs_identity.",
    "If the composer already contains content of unknown ownership, stop and return needs_clarification.",
    "If the accepted material appears fully prepared, return prepared_candidate. Publisher will verify it independently in #107; do not self-approve.",
    "If safe progress is possible but this run stops before a terminal outcome, return progress.",
    "If no materially different safe path remains, return failed.",
    "Accepted material and controlled upload paths:",
    JSON.stringify(material),
    "Finish with exactly one final marker line and no hidden reasoning after it:",
    'PUBLISHING_SECRETARY_RESULT={"kind":"prepared_candidate","summary":"bounded user-safe summary","semanticMilestone":"optional semantic milestone"}',
    "Allowed kind values: progress, needs_identity, prepared_candidate, needs_clarification, failed.",
  ].join("\n");
}

export async function createXiaohongshuPublishingBrowserResourceLoader(
  input: PiResourceLoaderFactoryInput,
  grant: PublishingBrowserCapabilityGrant,
) {
  const guard = await createPublishingBrowserGuardExtension(grant);
  return createXiaohongshuPublishingResourceLoader({
    ...input,
    extensionFactories: [...input.extensionFactories, guard],
  });
}

export class PublishingSecretaryService implements PublishingSecretaryPort {
  readonly #jobs: Pick<JobRepository, "getById">;
  readonly #bindings: AgentSessionBindingRepository;
  readonly #createHost: PublishingSecretaryHostFactory;
  readonly #uploadRoot: string;
  readonly #resolveAssetPath: AssetPathResolver;
  readonly #allowedOrigins: readonly string[];
  readonly #runTimeoutMs: number | undefined;

  constructor(dependencies: PublishingSecretaryServiceDependencies) {
    this.#jobs = dependencies.jobs;
    this.#bindings = dependencies.bindings;
    this.#createHost = dependencies.createHost;
    this.#uploadRoot = resolve(dependencies.uploadRoot);
    this.#resolveAssetPath = dependencies.resolveAssetPath;
    this.#allowedOrigins =
      dependencies.allowedOrigins ?? DEFAULT_ALLOWED_ORIGINS;
    this.#runTimeoutMs = dependencies.runTimeoutMs;
  }

  async execute(
    input: PublishingSecretaryExecutionInput,
  ): Promise<PublishingSecretaryExecutionResult> {
    const grant = await issuePublishingBrowserCapabilityGrant({
      jobId: input.jobId,
      browserProvider: input.browserProvider,
      browserSession: input.browserSession,
      allowedOrigins: this.#allowedOrigins,
      uploadRoot: this.#uploadRoot,
      authorizeClick: authorizeXiaohongshuPrepublishClick,
    });

    const definition = createXiaohongshuPublishingDefinition(
      createPublishingBrowserMcpProfile(grant),
    );
    const host = this.#createHost(grant);
    const sessions = new JobAgentSessionService({
      jobs: this.#jobs,
      bindings: this.#bindings,
      host,
    });
    const scope = {
      jobId: input.jobId,
      role: XIAOHONGSHU_PUBLISHING_ROLE,
    };
    const uploadFiles = await controlledUploadFiles(
      input.materialPack,
      this.#uploadRoot,
      this.#resolveAssetPath,
    );

    const existing = this.#bindings.getForScope(scope);
    const session = existing
      ? await sessions.resume({
          jobId: input.jobId,
          role: XIAOHONGSHU_PUBLISHING_ROLE,
          definition,
        })
      : await sessions.create({
          jobId: input.jobId,
          role: XIAOHONGSHU_PUBLISHING_ROLE,
          definition,
        });

    try {
      const run = await session.run({
        prompt: buildTaskPrompt(input, uploadFiles),
        ...(this.#runTimeoutMs === undefined
          ? {}
          : { timeoutMs: this.#runTimeoutMs }),
      });
      const parsed = parseResultPayload(run.finalText);
      const browserToolCalls = run.toolExecutions.filter((execution) => {
        if (execution.toolName !== "mcp") return false;
        const args = execution.args;
        return (
          typeof args === "object" &&
          args !== null &&
          !Array.isArray(args) &&
          (args as { readonly server?: unknown }).server ===
            PUBLISHING_BROWSER_MCP_SERVER
        );
      }).length;

      return {
        ...parsed,
        browserToolCalls,
      };
    } finally {
      await session.dispose();
    }
  }
}
