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
import type {
  BrowserAutomationAttachmentProvider,
  BrowserSession,
} from "../browser/provider.js";

export const PLAYWRIGHT_MCP_VERSION = "0.0.82" as const;
export const PUBLISHING_BROWSER_MCP_SERVER = "playwright-browser" as const;

export const PUBLISHING_BROWSER_MCP_TOOLS = [
  "browser_snapshot",
  "browser_find",
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

const publishingBrowserGrantBrand = Symbol("publishing-browser-grant");

export interface PublishingBrowserClickAuthorizationContext {
  readonly jobId: string;
  readonly browserSessionId: string;
  readonly pageUrl: string;
  readonly targetRef: string;
  /** Snapshot text captured from the MCP result, never model-supplied text. */
  readonly observedTarget: string;
  readonly requestedElement?: string;
}

export interface PublishingBrowserClickDecision {
  readonly allowed: boolean;
  readonly reason?: string;
}

export type PublishingBrowserClickAuthorizer = (
  context: PublishingBrowserClickAuthorizationContext,
) =>
  | PublishingBrowserClickDecision
  | Promise<PublishingBrowserClickDecision>;

export interface PublishingBrowserCapabilityGrantInput {
  readonly jobId: string;
  readonly browserProvider: BrowserAutomationAttachmentProvider;
  readonly browserSession: BrowserSession;
  readonly allowedOrigins: readonly string[];
  readonly uploadRoot: string;
  /**
   * Publisher-owned allow policy for observed click targets. There is no
   * permissive default: a click is denied unless this policy explicitly
   * authorizes the target observed in the latest browser snapshot.
   */
  readonly authorizeClick: PublishingBrowserClickAuthorizer;
}

export interface PublishingBrowserCapabilityGrant {
  readonly [publishingBrowserGrantBrand]: true;
  readonly jobId: string;
  readonly browserSession: BrowserSession;
  readonly browserSessionId: string;
  readonly cdpEndpoint: string;
  readonly allowedOrigins: readonly string[];
  readonly uploadRoot: string;
  readonly authorizeClick: PublishingBrowserClickAuthorizer;
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

function normalizeCdpEndpoint(raw: string): string {
  const value = required(raw, "Publishing browser CDP endpoint");
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch (error) {
    throw new Error("Publishing browser CDP endpoint must be a valid absolute URL", {
      cause: error,
    });
  }

  if (
    parsed.protocol !== "http:" &&
    parsed.protocol !== "https:" &&
    parsed.protocol !== "ws:" &&
    parsed.protocol !== "wss:"
  ) {
    throw new Error("Publishing browser CDP endpoint must use http(s) or ws(s)");
  }
  if (parsed.username || parsed.password) {
    throw new Error("Publishing browser CDP endpoint must not embed credentials");
  }
  return parsed.toString().replace(/\/$/, "");
}

function normalizeGrant(
  grant: PublishingBrowserCapabilityGrant,
): NormalizedPublishingBrowserGrant {
  if (grant[publishingBrowserGrantBrand] !== true) {
    throw new Error("Publishing browser grants must be issued by Publisher");
  }

  const jobId = required(grant.jobId, "Publishing browser Job id");
  const browserSessionId = required(
    grant.browserSessionId,
    "Publishing browser session id",
  );
  if (grant.browserSession.id !== browserSessionId) {
    throw new Error("Publishing browser grant session identity mismatch");
  }
  if (grant.browserSession.page.isClosed()) {
    throw new Error("Publishing browser grant references a closed browser page");
  }
  if (typeof grant.authorizeClick !== "function") {
    throw new Error("Publishing browser grant requires a Publisher click authorizer");
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
    cdpEndpoint: normalizeCdpEndpoint(grant.cdpEndpoint),
    allowedOrigins,
    uploadRoot: resolve(
      required(grant.uploadRoot, "Publishing browser upload root"),
    ),
  };
}

export async function issuePublishingBrowserCapabilityGrant(
  input: PublishingBrowserCapabilityGrantInput,
): Promise<PublishingBrowserCapabilityGrant> {
  const jobId = required(input.jobId, "Publishing browser Job id");
  if (input.browserSession.page.isClosed()) {
    throw new Error("Cannot issue a browser grant for a closed BrowserSession");
  }

  const attachment = await input.browserProvider.resolveAutomationAttachment(
    input.browserSession.id,
  );
  if (attachment.sessionId !== input.browserSession.id) {
    throw new Error("BrowserProvider returned an attachment for a different session");
  }

  const grant: PublishingBrowserCapabilityGrant = {
    [publishingBrowserGrantBrand]: true,
    jobId,
    browserSession: input.browserSession,
    browserSessionId: input.browserSession.id,
    cdpEndpoint: attachment.cdpEndpoint,
    allowedOrigins: input.allowedOrigins,
    uploadRoot: input.uploadRoot,
    authorizeClick: input.authorizeClick,
  };
  return normalizeGrant(grant);
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

export function createPublishingBrowserMcpProfile(
  inputGrant: PublishingBrowserCapabilityGrant,
): AgentMcpProfile {
  const grant = normalizeGrant(inputGrant);

  return {
    servers: [
      {
        name: PUBLISHING_BROWSER_MCP_SERVER,
        transport: {
          kind: "stdio",
          command: process.execPath,
          args: [
            playwrightMcpCliPath,
            `--cdp-endpoint=${grant.cdpEndpoint}`,
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

const snapshotRefPattern = /^(?:f\\d+)?e\\d+$/;

function currentAllowedPageUrl(
  grant: NormalizedPublishingBrowserGrant,
  allowedOrigins: ReadonlySet<string>,
): string {
  const page = grant.browserSession.page;
  if (page.isClosed()) {
    throw new Error("Publisher browser session page is closed");
  }

  const rawUrl = page.url();
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("Current browser page URL is invalid");
  }
  if (
    (parsed.protocol !== "http:" && parsed.protocol !== "https:") ||
    !allowedOrigins.has(parsed.origin)
  ) {
    throw new Error(
      `Current browser page is outside the Publisher browser grant: ${rawUrl}`,
    );
  }
  return parsed.toString();
}

function requestedElement(args: Record<string, unknown>): string | undefined {
  const value = args.element;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function observedTarget(
  args: Record<string, unknown>,
  refs: ReadonlyMap<string, string>,
  tool: string,
): { readonly ref: string; readonly text: string } {
  const target = args.target;
  if (typeof target !== "string" || !snapshotRefPattern.test(target)) {
    throw new Error(`${tool} requires a snapshot ref target`);
  }
  const text = refs.get(target);
  if (!text) {
    throw new Error(
      `${tool} target ${target} was not observed in the latest Publisher-controlled snapshot`,
    );
  }
  return { ref: target, text };
}

function assertObservedFillFormTargets(
  args: Record<string, unknown>,
  refs: ReadonlyMap<string, string>,
): void {
  if (!Array.isArray(args.fields) || args.fields.length === 0) {
    throw new Error("browser_fill_form fields must be a non-empty array");
  }
  for (const field of args.fields) {
    if (field === null || typeof field !== "object" || Array.isArray(field)) {
      throw new Error("browser_fill_form field must be an object");
    }
    observedTarget(
      field as Record<string, unknown>,
      refs,
      "browser_fill_form",
    );
  }
}

function observedRefsFromContent(content: readonly unknown[]): Map<string, string> {
  const refs = new Map<string, string>();
  for (const item of content) {
    if (item === null || typeof item !== "object") continue;
    const candidate = item as { type?: unknown; text?: unknown };
    if (candidate.type !== "text" || typeof candidate.text !== "string") continue;

    const text = candidate.text;
    const pattern = /\\[ref=((?:f\\d+)?e\\d+)\\]/g;
    for (const match of text.matchAll(pattern)) {
      const ref = match[1];
      const index = match.index ?? 0;
      const snippetStart = Math.max(0, index - 180);
      const snippetEnd = Math.min(text.length, index + 220);
      refs.set(ref, text.slice(snippetStart, snippetEnd).replace(/\\s+/g, " ").trim());
    }
  }
  return refs;
}

function clearsObservationBeforeExecution(tool: string): boolean {
  return (
    tool === "browser_navigate" ||
    tool === "browser_click" ||
    tool === "browser_type" ||
    tool === "browser_fill_form" ||
    tool === "browser_file_upload"
  );
}

/**
 * Defense-in-depth for the generic MCP proxy surface.
 *
 * The guard binds every action to the BrowserProvider-acquired session, checks
 * the current page origin before operating it, requires snapshot refs for
 * interactive targets, and delegates click permission to a Publisher-owned
 * allow policy over the actually observed target. There is deliberately no
 * model-controlled bypass and no permissive click default.
 */
export async function createPublishingBrowserGuardExtension(
  inputGrant: PublishingBrowserCapabilityGrant,
): Promise<InlineExtension> {
  const grant = normalizeGrant(inputGrant);
  const canonicalUploadRoot = await realpath(grant.uploadRoot);
  const allowedOrigins = new Set(grant.allowedOrigins);
  const observedRefs = new Map<string, string>();

  return {
    name: "publisher-browser-capability-guard",
    hidden: true,
    factory(pi) {
      pi.on("tool_call", async (event) => {
        if (event.toolName !== "mcp") return undefined;

        const call = nestedMcpCall(event.input as Record<string, unknown>);
        if (
          call.server !== undefined &&
          call.server !== PUBLISHING_BROWSER_MCP_SERVER
        ) {
          return {
            block: true,
            reason: `Publisher browser grant does not authorize MCP server "${call.server}"`,
          };
        }
        if (!call.tool) return undefined;
        if (!publishingBrowserToolSet.has(call.tool)) {
          return {
            block: true,
            reason: `Publisher browser grant does not authorize tool "${call.tool}"`,
          };
        }

        try {
          if (call.tool === "browser_navigate") {
            assertAllowedUrl(call.args.url, allowedOrigins, "browser_navigate URL");
          } else {
            currentAllowedPageUrl(grant, allowedOrigins);
          }

          if (call.tool === "browser_click") {
            const target = observedTarget(call.args, observedRefs, call.tool);
            const decision = await grant.authorizeClick({
              jobId: grant.jobId,
              browserSessionId: grant.browserSessionId,
              pageUrl: currentAllowedPageUrl(grant, allowedOrigins),
              targetRef: target.ref,
              observedTarget: target.text,
              ...(requestedElement(call.args) === undefined
                ? {}
                : { requestedElement: requestedElement(call.args)! }),
            });
            if (!decision || decision.allowed !== true) {
              throw new Error(
                decision?.reason?.trim() ||
                  "Publisher click authorizer denied the observed target",
              );
            }
          }

          if (call.tool === "browser_type") {
            observedTarget(call.args, observedRefs, call.tool);
            if (call.args.submit === true) {
              throw new Error(
                "browser_type submit is not authorized; irreversible submission remains Publisher-owned",
              );
            }
          }

          if (call.tool === "browser_fill_form") {
            assertObservedFillFormTargets(call.args, observedRefs);
          }

          if (call.tool === "browser_file_upload") {
            await assertUploadPaths(call.args.paths, canonicalUploadRoot);
          }

          if (clearsObservationBeforeExecution(call.tool)) {
            observedRefs.clear();
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

      pi.on("tool_result", async (event) => {
        if (event.toolName !== "mcp") return undefined;
        const call = nestedMcpCall(event.input as Record<string, unknown>);
        if (call.server !== PUBLISHING_BROWSER_MCP_SERVER || !call.tool) {
          return undefined;
        }
        if (!publishingBrowserToolSet.has(call.tool)) return undefined;

        try {
          currentAllowedPageUrl(grant, allowedOrigins);
        } catch {
          observedRefs.clear();
          return {
            content: [
              {
                type: "text" as const,
                text:
                  "Publisher browser origin boundary crossed; browser result redacted and further actions are blocked.",
              },
            ],
            isError: true,
          };
        }

        if (event.isError) return undefined;
        const nextRefs = observedRefsFromContent(event.content);
        if (call.tool === "browser_find") {
          for (const [ref, text] of nextRefs) observedRefs.set(ref, text);
        } else if (nextRefs.size > 0) {
          observedRefs.clear();
          for (const [ref, text] of nextRefs) observedRefs.set(ref, text);
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
