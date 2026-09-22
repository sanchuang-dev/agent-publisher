import { realpath } from "node:fs/promises";
import { isAbsolute, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import type { InlineExtension } from "@earendil-works/pi-coding-agent";

import type {
  AgentMcpProfile,
  AgentSessionScope,
} from "./definition.js";
import type { PiResourceLoaderFactoryInput } from "./pi-agent-host.js";
import { createControlledPiResourceLoader } from "./pi-controlled-resources.js";
import { resolveCdpWebSocketEndpoint } from "../browser/providers/docker-cdp-transport.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.82" as const;
export const PUBLISHING_BROWSER_MCP_SERVER = "playwright-browser" as const;

export const PUBLISHING_BROWSER_MCP_TOOLS = [
  "browser_snapshot",
  "browser_find",
  "browser_tabs",
  "browser_navigate",
  "browser_click",
  "browser_type",
  "browser_fill_form",
  "browser_file_upload",
  "browser_wait_for",
] as const;

const publishingBrowserToolSet = new Set<string>(
  PUBLISHING_BROWSER_MCP_TOOLS,
);

const publisherSafetySkillPath = fileURLToPath(
  new URL("../../skills/publisher-safety/SKILL.md", import.meta.url),
);

const playwrightMcpCliPath = fileURLToPath(
  new URL("../../node_modules/@playwright/mcp/cli.js", import.meta.url),
);

const FINAL_PUBLISH_LABELS = new Set([
  "publish",
  "publish now",
  "post",
  "发布",
  "立即发布",
  "确认发布",
]);

export interface PublishingBrowserCapabilityGrant {
  readonly jobId: string;
  /**
   * Opaque BrowserProvider session id. The grant is issued only after the
   * Publisher has acquired the authorized browser session for this Job.
   */
  readonly browserSessionId: string;
  readonly cdpEndpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly uploadRoot: string;
}

interface NormalizedPublishingBrowserGrant
  extends PublishingBrowserCapabilityGrant {
  readonly cdpEndpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly uploadRoot: string;
}

function required(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeHttpUrl(raw: string, label: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(required(raw, label));
  } catch (error) {
    throw new Error(`${label} must be a valid absolute URL`, {
      cause: error,
    });
  }

  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`${label} must use http or https`);
  }
  if (parsed.username || parsed.password) {
    throw new Error(`${label} must not embed credentials`);
  }
  return parsed;
}

function normalizeOrigin(raw: string): string {
  const parsed = normalizeHttpUrl(raw, "Publishing browser allowed origin");
  return parsed.origin;
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}

function normalizeGrant(
  grant: PublishingBrowserCapabilityGrant,
): NormalizedPublishingBrowserGrant {
  const jobId = required(grant.jobId, "Publishing browser Job id");
  const browserSessionId = required(
    grant.browserSessionId,
    "Publishing browser session id",
  );
  const cdpRaw = required(
    grant.cdpEndpoint,
    "Publishing browser CDP endpoint",
  );
  let cdp: URL;
  try {
    cdp = new URL(cdpRaw);
  } catch (error) {
    throw new Error("Publishing browser CDP endpoint must be a valid absolute URL", {
      cause: error,
    });
  }
  if (
    cdp.protocol !== "http:" &&
    cdp.protocol !== "https:" &&
    cdp.protocol !== "ws:" &&
    cdp.protocol !== "wss:"
  ) {
    throw new Error(
      "Publishing browser CDP endpoint must use http(s) or ws(s)",
    );
  }
  if (cdp.username || cdp.password) {
    throw new Error("Publishing browser CDP endpoint must not embed credentials");
  }
  const allowedOrigins = unique(grant.allowedOrigins.map(normalizeOrigin));
  if (allowedOrigins.length === 0) {
    throw new Error(
      "Publishing browser grant must declare at least one allowed origin",
    );
  }

  return {
    ...grant,
    jobId,
    browserSessionId,
    cdpEndpoint: cdp.toString().replace(/\/$/, ""),
    allowedOrigins,
    uploadRoot: resolve(required(grant.uploadRoot, "Publishing browser upload root")),
  };
}

function isWithinPath(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

function assertAllowedUrl(
  value: unknown,
  allowedOrigins: ReadonlySet<string>,
  label: string,
): void {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new Error(`${label} must be a non-empty URL`);
  }

  const parsed = normalizeHttpUrl(value, label);
  if (!allowedOrigins.has(parsed.origin)) {
    throw new Error(
      `${label} origin is outside the Publisher browser grant: ${parsed.origin}`,
    );
  }
}

function normalizeElementLabel(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = value.trim().replace(/\s+/g, " ").toLowerCase();
  return normalized || undefined;
}

function isFinalPublishLikeClick(args: Record<string, unknown>): boolean {
  const element = normalizeElementLabel(args.element);
  return element !== undefined && FINAL_PUBLISH_LABELS.has(element);
}

async function assertUploadPaths(
  rawPaths: unknown,
  canonicalUploadRoot: string,
): Promise<void> {
  if (rawPaths === undefined) return;
  if (!Array.isArray(rawPaths)) {
    throw new Error("browser_file_upload paths must be an array");
  }

  for (const rawPath of rawPaths) {
    if (typeof rawPath !== "string" || rawPath.trim().length === 0) {
      throw new Error("browser_file_upload path must be a non-empty string");
    }

    const requested = isAbsolute(rawPath)
      ? rawPath
      : resolve(canonicalUploadRoot, rawPath);
    const canonical = await realpath(requested);
    if (!isWithinPath(canonical, canonicalUploadRoot)) {
      throw new Error(
        "browser_file_upload path is outside the Publisher-approved upload root",
      );
    }
  }
}

function nestedMcpCall(
  input: Record<string, unknown>,
): {
  readonly server?: string;
  readonly tool?: string;
  readonly args: Record<string, unknown>;
} {
  const server =
    typeof input.server === "string" ? input.server : undefined;
  const tool = typeof input.tool === "string" ? input.tool : undefined;
  const args =
    input.args !== null &&
    typeof input.args === "object" &&
    !Array.isArray(input.args)
      ? (input.args as Record<string, unknown>)
      : {};

  return {
    ...(server === undefined ? {} : { server }),
    ...(tool === undefined ? {} : { tool }),
    args,
  };
}

export async function createPublishingBrowserMcpProfile(
  inputGrant: PublishingBrowserCapabilityGrant,
): Promise<AgentMcpProfile> {
  const grant = normalizeGrant(inputGrant);
  // Reuse the BrowserProvider transport adapter. Chromium's DevTools discovery
  // advertises a loopback WebSocket URL, and direct HTTP discovery through the
  // Compose service hostname can be rejected by Chromium's Host validation.
  // Resolve once here and give Playwright MCP the exact WebSocket endpoint.
  const resolvedCdpEndpoint = await resolveCdpWebSocketEndpoint(
    grant.cdpEndpoint,
    10_000,
  );

  return {
    servers: [
      {
        name: PUBLISHING_BROWSER_MCP_SERVER,
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [
            playwrightMcpCliPath,
            `--cdp-endpoint=${resolvedCdpEndpoint}`,
            `--allowed-origins=${grant.allowedOrigins.join(";")}`,
            "--block-service-workers",
            "--codegen=none",
            "--image-responses=omit",
            "--no-webmcp",
          ],
          // Playwright MCP restricts file access to cwd/workspace roots unless
          // explicitly configured otherwise. Publisher additionally verifies
          // every upload path before the MCP call executes.
          cwd: grant.uploadRoot,
        },
        includeTools: PUBLISHING_BROWSER_MCP_TOOLS,
      },
    ],
  };
}

/**
 * Defense-in-depth for the generic MCP proxy surface.
 *
 * pi-mcp-adapter already hides non-allowlisted tools, while this preflight
 * independently verifies the selected server/tool and the high-risk arguments
 * that are specific to Publisher browser authority. The final publish action
 * is not present as a dedicated Tool; obvious publish-button clicks are also
 * denied here, while the authoritative prepared/approval boundary remains
 * Publisher-owned.
 */
export async function createPublishingBrowserGuardExtension(
  inputGrant: PublishingBrowserCapabilityGrant,
): Promise<InlineExtension> {
  const grant = normalizeGrant(inputGrant);
  const canonicalUploadRoot = await realpath(grant.uploadRoot);
  const allowedOrigins = new Set(grant.allowedOrigins);

  return {
    name: "publisher-browser-capability-guard",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "mcp") return undefined;

        const input = event.input as Record<string, unknown>;
        const call = nestedMcpCall(input);

        if (
          call.server !== undefined &&
          call.server !== PUBLISHING_BROWSER_MCP_SERVER
        ) {
          return {
            block: true,
            reason: `Publisher browser grant does not authorize MCP server "${call.server}"`,
          };
        }

        if (!call.tool) {
          return undefined;
        }

        if (!publishingBrowserToolSet.has(call.tool)) {
          return {
            block: true,
            reason: `Publisher browser grant does not authorize tool "${call.tool}"`,
          };
        }

        try {
          if (call.tool === "browser_navigate") {
            assertAllowedUrl(
              call.args.url,
              allowedOrigins,
              "browser_navigate URL",
            );
          }

          if (call.tool === "browser_tabs") {
            const action =
              typeof call.args.action === "string"
                ? call.args.action
                : undefined;
            if (action !== "list" && action !== "new") {
              throw new Error(
                `browser_tabs action "${String(action)}" is not authorized for the persistent Publisher browser`,
              );
            }
            if (action === "new") {
              assertAllowedUrl(
                call.args.url,
                allowedOrigins,
                "browser_tabs new URL",
              );
            }
          }

          if (call.tool === "browser_file_upload") {
            await assertUploadPaths(call.args.paths, canonicalUploadRoot);
          }

          if (
            call.tool === "browser_click" &&
            isFinalPublishLikeClick(call.args)
          ) {
            throw new Error(
              "Final publication is Publisher-owned and is not authorized by the browser capability grant",
            );
          }
        } catch (error) {
          return {
            block: true,
            reason:
              error instanceof Error
                ? error.message
                : "Publisher browser capability guard rejected the call",
          };
        }

        return undefined;
      });
    },
  };
}

export function assertPublishingBrowserScope(
  scope: AgentSessionScope,
  inputGrant: PublishingBrowserCapabilityGrant,
): void {
  const grant = normalizeGrant(inputGrant);
  if (scope.jobId !== grant.jobId) {
    throw new Error(
      `Publishing browser grant for Job ${grant.jobId} cannot be used by Job ${scope.jobId}`,
    );
  }
  if (scope.role !== "publishing") {
    throw new Error(
      `Publishing browser grant requires role "publishing", received "${scope.role}"`,
    );
  }
}

export async function createPublishingBrowserResourceLoader(
  input: PiResourceLoaderFactoryInput,
  grant: PublishingBrowserCapabilityGrant,
) {
  assertPublishingBrowserScope(input.scope, grant);

  const guard = await createPublishingBrowserGuardExtension(grant);
  return createControlledPiResourceLoader({
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools,
    extensionFactories: [...input.extensionFactories, guard],
    policy: {
      skillPaths: [publisherSafetySkillPath],
      mandatorySkillPaths: [publisherSafetySkillPath],
      readRoots: [],
      executionGuardAllowedTools: input.allowedTools,
    },
  });
}
