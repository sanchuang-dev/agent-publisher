import { isAbsolute, relative, resolve } from "node:path";

import type { ImageTextMaterialPack } from "../materials/contracts.js";
import type { AssetPathResolver } from "../platforms/xiaohongshu/image-text-prepare.js";
import type { JobRepository } from "../contracts/job.js";
import type { AgentSessionBindingRepository } from "./job-session-binding.js";
import type { AgentToolExecutionEvent } from "./definition.js";
import { JobAgentSessionService } from "./job-session-service.js";
import type { AgentHost } from "./host.js";
import type { PiResourceLoaderFactoryInput } from "./pi-agent-host.js";
import type {
  PublishingSecretaryExecutionInput,
  PublishingSecretaryExecutionResult,
  PublishingSecretaryProgressEvent,
  PublishingSecretaryProgressKey,
  PublishingSecretaryPort,
} from "./publishing-secretary-contract.js";
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  PUBLISHING_BROWSER_MCP_TOOLS,
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

const RESULT_SIGNAL_MARKER = "PUBLISHING_SECRETARY_SIGNAL=";
const DEFAULT_ALLOWED_ORIGINS = [
  "https://creator.xiaohongshu.com",
] as const;

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

type PublishingSecretaryBoundedOutcome = Omit<
  PublishingSecretaryExecutionResult,
  "browserToolCalls"
>;

function semanticSignal(finalText: string): string | null {
  for (const line of finalText.split(/\r?\n/).reverse()) {
    const normalized = line.trim();
    if (!normalized.startsWith(RESULT_SIGNAL_MARKER)) continue;
    return normalized.slice(RESULT_SIGNAL_MARKER.length).trim();
  }
  return null;
}

function interpretRunOutcome(
  finalText: string,
  successfulBrowserToolCalls: number,
): PublishingSecretaryBoundedOutcome {
  const signal = semanticSignal(finalText);

  if (!signal) {
    if (successfulBrowserToolCalls > 0) {
      return {
        kind: "progress",
        summary:
          "Publishing Secretary completed bounded browser work and yielded for the next run.",
        semanticMilestone: "browser_progress_observed",
        identitySurface: null,
      };
    }

    return {
      kind: "failed",
      summary:
        "Publishing Secretary returned without any successful browser action or terminal page signal.",
      semanticMilestone: "no_browser_progress",
      identitySurface: null,
    };
  }

  if (successfulBrowserToolCalls === 0) {
    throw new PublishingSecretaryResultError(
      "Publishing Secretary semantic signal requires current successful browser evidence.",
    );
  }

  switch (signal) {
    case "qr_ready":
      return {
        kind: "needs_identity",
        summary: "QR login is ready for authorized human action.",
        semanticMilestone: "qr_ready",
        identitySurface: "qr_ready",
      };
    case "verification_required":
      return {
        kind: "needs_identity",
        summary:
          "Identity verification is ready for authorized human action.",
        semanticMilestone: "verification_required",
        identitySurface: "verification_required",
      };
    case "prepared_candidate":
      return {
        kind: "prepared_candidate",
        summary:
          "Publishing Secretary believes the current page is ready for Publisher verification.",
        semanticMilestone: "prepared_candidate",
        identitySurface: null,
      };
    case "needs_clarification":
      return {
        kind: "needs_clarification",
        summary:
          "Publishing Secretary stopped because the current page needs human clarification.",
        semanticMilestone: "needs_clarification",
        identitySurface: null,
      };
    case "failed":
      return {
        kind: "failed",
        summary:
          "Publishing Secretary found no materially different safe browser path.",
        semanticMilestone: "safe_paths_exhausted",
        identitySurface: null,
      };
    default:
      throw new PublishingSecretaryResultError(
        "Publishing Secretary returned an unsupported semantic signal.",
      );
  }
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
  allowedOrigins: readonly string[],
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
    "Granted Creator origins: " + allowedOrigins.join(", "),
    "If the current page is blank or outside the task surface, choose a browser_navigate action within the granted Creator origin before trying to inspect or mutate page controls.",
    "You own the page-local browser route. Observe the page, choose the next bounded safe action, act, and re-observe. You may use multiple observe/act loops while progress or new evidence exists.",
    "Do not ask Publisher code which UI control to click. Current page evidence and the reviewed Xiaohongshu Skill guide the route.",
    "Never execute final publication, delete/clear/overwrite unknown content, or bypass QR scan, CAPTCHA, MFA, OTP, device verification, or equivalent identity challenges.",
    "A login page or login button is not itself a human-action boundary. Within the granted Creator origin, you may safely navigate the login UI, choose or switch login methods, and prefer a visible QR/scanning login method when available.",
    "Do not return JSON, a schema object, or a machine-written summary. Focus on observing and operating the browser.",
    "When a QR code is visibly ready for the authorized human, stop and add one final line: PUBLISHING_SECRETARY_SIGNAL=qr_ready",
    "When CAPTCHA, MFA, OTP, device verification, or another human-only identity challenge is visibly ready, stop and add one final line: PUBLISHING_SECRETARY_SIGNAL=verification_required",
    "Do not include QR contents, one-time codes, cookies, storage state, account identifiers, tokens, or other credential material in your response.",
    "If the composer contains content of unknown ownership, stop and add one final line: PUBLISHING_SECRETARY_SIGNAL=needs_clarification",
    "If the accepted material appears fully prepared, stop and add one final line: PUBLISHING_SECRETARY_SIGNAL=prepared_candidate. Publisher will verify it independently in #107; do not self-approve.",
    "If no materially different safe path remains, stop and add one final line: PUBLISHING_SECRETARY_SIGNAL=failed",
    "For ordinary bounded progress, no special output format is required. Stop naturally after making safe progress; Publisher will infer progress from browser-tool evidence.",
    "Accepted material and controlled upload paths:",
    JSON.stringify(material),
  ].join("\n");
}

function recordLike(value: unknown): Readonly<Record<string, unknown>> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Readonly<Record<string, unknown>>;
}

function publishingBrowserTool(
  event: AgentToolExecutionEvent,
): string | null {
  if (event.toolName !== "mcp") return null;

  const args = recordLike(event.args);
  if (args?.server !== PUBLISHING_BROWSER_MCP_SERVER) return null;

  const tool = args.tool;
  return typeof tool === "string" &&
    (PUBLISHING_BROWSER_MCP_TOOLS as readonly string[]).includes(tool)
    ? tool
    : null;
}

function semanticProgressKey(
  event: AgentToolExecutionEvent,
): PublishingSecretaryProgressKey | null {
  const tool = publishingBrowserTool(event);
  if (!tool) return null;

  const keyByTool: Readonly<Record<string, PublishingSecretaryProgressKey>> = {
    browser_snapshot: "observing",
    browser_find: "finding",
    browser_navigate: "navigating",
    browser_click: "acting",
    browser_type: "filling",
    browser_fill_form: "filling",
    browser_file_upload: "uploading",
    browser_wait_for: "waiting",
  };

  return keyByTool[tool] ?? "acting";
}

function emitProgress(
  input: PublishingSecretaryExecutionInput,
  event: PublishingSecretaryProgressEvent,
): void {
  if (!input.onProgress) return;

  try {
    input.onProgress(event);
  } catch {
    // Progress delivery is observational. The browser run remains authoritative
    // even if persistence or SSE delivery is temporarily unavailable.
    process.emitWarning(
      "Publishing Secretary progress observer failed during an active run.",
      { code: "PUBLISHING_SECRETARY_PROGRESS_OBSERVER_FAILED" },
    );
  }
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
      emitProgress(input, { key: "starting", status: "running" });
      let run: Awaited<ReturnType<typeof session.run>>;
      try {
        run = await session.run({
          prompt: buildTaskPrompt(
            input,
            uploadFiles,
            this.#allowedOrigins,
          ),
          ...(this.#runTimeoutMs === undefined
            ? {}
            : { timeoutMs: this.#runTimeoutMs }),
          onToolExecution: (event) => {
            const key = semanticProgressKey(event);
            if (!key) return;

            emitProgress(input, {
              key,
              status:
                event.phase === "started"
                  ? "running"
                  : event.isError
                    ? "failed"
                    : "succeeded",
            });
          },
        });
      } catch (error) {
        emitProgress(input, { key: "starting", status: "failed" });
        throw error;
      }

      emitProgress(input, { key: "starting", status: "succeeded" });
      const browserExecutions = run.toolExecutions.filter((execution) => {
        if (execution.toolName !== "mcp") return false;
        const args = execution.args;
        if (
          typeof args !== "object" ||
          args === null ||
          Array.isArray(args)
        ) {
          return false;
        }
        const record = args as {
          readonly server?: unknown;
          readonly tool?: unknown;
        };
        return (
          record.server === PUBLISHING_BROWSER_MCP_SERVER &&
          typeof record.tool === "string" &&
          (PUBLISHING_BROWSER_MCP_TOOLS as readonly string[]).includes(
            record.tool,
          )
        );
      });
      const browserToolCalls = browserExecutions.length;
      const successfulBrowserToolCalls = browserExecutions.filter(
        (execution) =>
          execution.completed && execution.isError === false,
      ).length;
      const outcome = interpretRunOutcome(
        run.finalText,
        successfulBrowserToolCalls,
      );

      return {
        ...outcome,
        browserToolCalls,
      };
    } finally {
      await session.dispose();
    }
  }
}
