import { constants } from "node:fs";
import { access, readFile, realpath, stat } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";

import {
  DefaultResourceLoader,
  SettingsManager,
  createReadTool,
  type InlineExtension,
  type ResourceLoader,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";

const FORBIDDEN_PUBLISHER_BUILTINS = new Set([
  "bash",
  "powershell",
  "write",
  "edit",
]);

interface CanonicalResourcePath {
  readonly path: string;
  readonly kind: "file" | "directory";
}

export interface ControlledPiResourcePolicy {
  readonly skillPaths: readonly string[];
  readonly mandatorySkillPaths?: readonly string[];
  readonly readRoots: readonly string[];
  /**
   * Optional execution-time allowlist. It may only narrow allowedTools.
   * This exists as defense in depth if the visible tool profile is misconfigured.
   */
  readonly executionGuardAllowedTools?: readonly string[];
}

export interface CreateControlledPiResourceLoaderInput {
  readonly cwd: string;
  readonly agentDir?: string;
  readonly systemPrompt: string;
  readonly allowedTools: readonly string[];
  readonly policy: ControlledPiResourcePolicy;
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)];
}

function isWithinPath(target: string, root: string): boolean {
  return target === root || target.startsWith(`${root}${sep}`);
}

async function canonicalResourcePath(path: string): Promise<CanonicalResourcePath> {
  const canonical = await realpath(path);
  const metadata = await stat(canonical);
  if (metadata.isFile()) {
    return { path: canonical, kind: "file" };
  }
  if (metadata.isDirectory()) {
    return { path: canonical, kind: "directory" };
  }
  throw new Error(`Publisher resource path must be a file or directory: ${path}`);
}

function resourceContains(
  resource: CanonicalResourcePath,
  target: string,
): boolean {
  return resource.kind === "file"
    ? target === resource.path
    : isWithinPath(target, resource.path);
}

function assertToolPolicy(
  allowedTools: readonly string[],
  executionGuardAllowedTools: readonly string[],
): void {
  for (const toolName of allowedTools) {
    if (FORBIDDEN_PUBLISHER_BUILTINS.has(toolName)) {
      throw new Error(
        `Publisher controlled sessions must not enable unrestricted built-in tool "${toolName}"`,
      );
    }
  }

  const visible = new Set(allowedTools);
  for (const toolName of executionGuardAllowedTools) {
    if (!visible.has(toolName)) {
      throw new Error(
        `Execution guard tool "${toolName}" is not present in the visible Publisher tool allowlist`,
      );
    }
  }
}

function createExecutionGuardExtension(
  cwd: string,
  readRoots: readonly string[],
  executionGuardAllowedTools: readonly string[],
): InlineExtension {
  const canonicalRoots = unique(readRoots);
  const executionAllowlist = new Set(executionGuardAllowedTools);

  const resolveApprovedReadTarget = async (requestedPath: string): Promise<string> => {
    const canonicalTarget = await realpath(requestedPath);
    if (!canonicalRoots.some((root) => isWithinPath(canonicalTarget, root))) {
      throw new Error(
        `Read path is outside approved Publisher roots: ${requestedPath}`,
      );
    }
    return canonicalTarget;
  };

  const restrictedRead = createReadTool(cwd, {
    operations: {
      async access(path) {
        const approvedPath = await resolveApprovedReadTarget(path);
        await access(approvedPath, constants.R_OK);
      },
      async readFile(path) {
        const approvedPath = await resolveApprovedReadTarget(path);
        return readFile(approvedPath);
      },
    },
  });

  return {
    name: "publisher-resource-policy",
    hidden: true,
    factory(pi) {
      // Re-register Pi's read tool with host-controlled filesystem operations.
      // Pi's own schema/rendering/behavior remains the implementation baseline.
      pi.registerTool(restrictedRead as unknown as ToolDefinition);

      pi.on("tool_call", (event) => {
        if (executionAllowlist.has(event.toolName)) {
          return undefined;
        }

        return {
          block: true,
          reason: `Publisher execution guard blocked tool "${event.toolName}" before execution`,
          terminate: true,
        };
      });
    },
  };
}

export async function createControlledPiResourceLoader(
  input: CreateControlledPiResourceLoaderInput,
): Promise<ResourceLoader> {
  const allowedTools = unique(input.allowedTools);
  const executionGuardAllowedTools = unique(
    input.policy.executionGuardAllowedTools ?? allowedTools,
  );
  assertToolPolicy(allowedTools, executionGuardAllowedTools);

  const skillResources = await Promise.all(
    unique(input.policy.skillPaths).map(canonicalResourcePath),
  );
  const mandatoryResources = await Promise.all(
    unique(input.policy.mandatorySkillPaths ?? []).map(canonicalResourcePath),
  );

  for (const resource of mandatoryResources) {
    if (resource.kind !== "file") {
      throw new Error(
        `Mandatory Publisher skill must be a file: ${resource.path}`,
      );
    }
    if (!skillResources.some((skillResource) => resourceContains(skillResource, resource.path))) {
      throw new Error(
        `Mandatory Publisher skill is not included in explicit skillPaths: ${resource.path}`,
      );
    }
  }

  const configuredReadRoots = await Promise.all(
    unique(input.policy.readRoots).map(async (path) => (await canonicalResourcePath(path)).path),
  );
  const skillReadRoots = skillResources.map((resource) =>
    resource.kind === "file" ? dirname(resource.path) : resource.path,
  );
  const readRoots = unique([...configuredReadRoots, ...skillReadRoots]);

  const loader = new DefaultResourceLoader({
    cwd: input.cwd,
    // This directory is intentionally not the real Pi user directory.
    // In-memory settings plus no* flags prevent ambient machine configuration
    // from becoming part of a Publisher session.
    agentDir: input.agentDir ?? resolve(input.cwd, ".publisher-pi"),
    settingsManager: SettingsManager.inMemory(),
    additionalSkillPaths: skillResources.map((resource) => resource.path),
    extensionFactories: [
      createExecutionGuardExtension(
        input.cwd,
        readRoots,
        executionGuardAllowedTools,
      ),
    ],
    noExtensions: true,
    noSkills: true,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => input.systemPrompt,
    // Supplying [] is deliberate: it prevents append-prompt discovery.
    // Mandatory safety/workflow skills are host-injected here so their critical
    // rules do not depend on progressive model discovery.
    appendSystemPrompt: mandatoryResources.map((resource) => resource.path),
  });

  await loader.reload();

  const loadedSkills = loader.getSkills();
  if (loadedSkills.diagnostics.length > 0) {
    const details = loadedSkills.diagnostics
      .map((diagnostic) => `${diagnostic.type}: ${diagnostic.message} (${diagnostic.path ?? "unknown"})`)
      .join("; ");
    throw new Error(`Publisher skill loading produced diagnostics: ${details}`);
  }

  for (const skill of loadedSkills.skills) {
    const skillPath = await realpath(skill.filePath);
    if (!skillResources.some((resource) => resourceContains(resource, skillPath))) {
      throw new Error(
        `Publisher ResourceLoader loaded a skill outside explicit resources: ${skillPath}`,
      );
    }
  }

  return loader;
}
