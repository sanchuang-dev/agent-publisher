import { fileURLToPath } from "node:url";

import type {
  AgentDefinition,
  AgentMcpProfile,
} from "./definition.js";
import type { PiResourceLoaderFactoryInput } from "./pi-agent-host.js";
import { createControlledPiResourceLoader } from "./pi-controlled-resources.js";
import { PUBLISHING_BROWSER_MCP_TOOLS } from "./publishing-browser-mcp.js";

export const XIAOHONGSHU_PUBLISHING_ROLE = "publishing" as const;
export const XIAOHONGSHU_PUBLISHING_DEFINITION_ID =
  "xiaohongshu-publishing-secretary" as const;

/**
 * Publisher-local tools owned by this Skill profile.
 *
 * Browser execution is intentionally not implemented here. #105 may attach a
 * Publisher-controlled MCP profile, which adds only Pi's top-level `mcp`
 * gateway. The MCP server's includeTools allowlist remains the browser
 * capability boundary.
 */
export const XIAOHONGSHU_PUBLISHING_LOCAL_TOOLS = ["read"] as const;

/**
 * Browser capability names come from BRW-01's accepted tool surface.
 *
 * Keep one source of truth: this Skill may narrow behavior semantically, but it
 * must not maintain a second browser-tool catalog that can drift from #105.
 * Generic browser_click is capability, not publish authority; the browser
 * capability layer enforces Publisher-owned click/final-publish boundaries.
 */
export const XIAOHONGSHU_PUBLISHING_BROWSER_MCP_TOOLS =
  PUBLISHING_BROWSER_MCP_TOOLS;

const XIAOHONGSHU_PUBLISHING_BROWSER_MCP_TOOL_SET = new Set<string>(
  XIAOHONGSHU_PUBLISHING_BROWSER_MCP_TOOLS,
);

const XIAOHONGSHU_PUBLISHING_ALLOWED_SESSION_TOOLS = new Set([
  "read",
  "mcp",
]);

export const publisherSafetySkillPath = fileURLToPath(
  new URL("../../skills/publisher-safety/SKILL.md", import.meta.url),
);

export const xiaohongshuPublishingSkillPath = fileURLToPath(
  new URL("../../skills/xiaohongshu-publishing/SKILL.md", import.meta.url),
);

export const xiaohongshuPublishingReferencePath = fileURLToPath(
  new URL(
    "../../skills/xiaohongshu-publishing/references/2026-09-22-creator-mode-entry.md",
    import.meta.url,
  ),
);

const systemPrompt = [
  "You are the Publishing Secretary for an Agent Publisher Xiaohongshu task.",
  "Choose browser actions from the page that actually exists now; observe, act once within the granted capability, then observe again.",
  "Use the Xiaohongshu Publishing Skill as platform knowledge, not as a fixed selector workflow.",
  "The Publisher Orchestrator owns Job state, identity handoff, prepared-state acceptance, approval, publish-once authority, and irreversible side effects.",
  "Never bypass login/MFA/device verification, overwrite an unknown draft, or execute final publication.",
  "Ordinary page ambiguity is a reason to re-observe, compare outcomes, and revise the working hypothesis; it is not by itself a reason to hand off.",
  "Stop and report a bounded gap only at a hard boundary, outside the granted browser capability, or when materially different safe exploration no longer produces new evidence.",
].join("\n");

function assertPublishingMcpProfile(mcp: AgentMcpProfile | undefined): void {
  if (!mcp) return;

  for (const server of mcp.servers) {
    for (const toolName of server.includeTools) {
      if (!XIAOHONGSHU_PUBLISHING_BROWSER_MCP_TOOL_SET.has(toolName)) {
        throw new Error(
          `Xiaohongshu Publishing MCP profile must not expose non-browser or overpowered tool "${toolName}"`,
        );
      }
    }
  }
}

export function createXiaohongshuPublishingDefinition(
  mcp?: AgentMcpProfile,
): AgentDefinition {
  assertPublishingMcpProfile(mcp);

  return {
    id: XIAOHONGSHU_PUBLISHING_DEFINITION_ID,
    systemPrompt,
    ...(mcp === undefined ? {} : { mcp }),
  };
}

export const xiaohongshuPublishingDefinition =
  createXiaohongshuPublishingDefinition();

function assertPublishingToolSurface(allowedTools: readonly string[]): void {
  if (!allowedTools.includes("read")) {
    throw new Error(
      "Xiaohongshu Publishing sessions require restricted read access for reviewed Skill references",
    );
  }

  for (const toolName of allowedTools) {
    if (!XIAOHONGSHU_PUBLISHING_ALLOWED_SESSION_TOOLS.has(toolName)) {
      throw new Error(
        `Xiaohongshu Publishing sessions must not inherit unrelated top-level tool "${toolName}"`,
      );
    }
  }
}

/**
 * Resource profile for the Xiaohongshu Publishing Secretary.
 *
 * It owns only reviewed Skill/reference loading and the top-level tool boundary.
 * Browser MCP configuration is supplied separately by #105 and may only add
 * Pi's controlled `mcp` proxy. This keeps platform experience independent from
 * BrowserProvider/MCP implementation details.
 */
export function createXiaohongshuPublishingResourceLoader(
  input: PiResourceLoaderFactoryInput,
) {
  if (input.definition.id !== XIAOHONGSHU_PUBLISHING_DEFINITION_ID) {
    throw new Error(
      `Xiaohongshu Publishing resource profile cannot load definition ${input.definition.id}`,
    );
  }
  if (input.scope.role !== XIAOHONGSHU_PUBLISHING_ROLE) {
    throw new Error(
      `Xiaohongshu Publishing resource profile cannot load role ${input.scope.role}`,
    );
  }

  assertPublishingToolSurface(input.allowedTools);
  assertPublishingMcpProfile(input.definition.mcp);

  return createControlledPiResourceLoader({
    cwd: input.cwd,
    systemPrompt: input.systemPrompt,
    allowedTools: input.allowedTools,
    extensionFactories: input.extensionFactories,
    policy: {
      skillPaths: [
        publisherSafetySkillPath,
        xiaohongshuPublishingSkillPath,
      ],
      mandatorySkillPaths: [
        publisherSafetySkillPath,
        xiaohongshuPublishingSkillPath,
      ],
      readRoots: [],
      executionGuardAllowedTools: input.allowedTools,
    },
  });
}
