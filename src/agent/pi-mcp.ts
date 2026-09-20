import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import {
  createMcpAdapter,
  type McpAdapterOptions,
  type ServerEntry,
} from "pi-mcp-adapter";

import type {
  AgentMcpHttpAuth,
  AgentMcpProfile,
  AgentMcpServerDefinition,
} from "./definition.js";

export interface CompiledPublisherMcpProfile {
  readonly extensionFactories: readonly InlineExtension[];
  readonly toolNames: readonly string[];
}

function assertNonEmpty(value: string, label: string): string {
  const normalized = value.trim();
  if (!normalized) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeToolPatterns(
  values: readonly string[],
  label: string,
): string[] {
  return [
    ...new Set(
      values.map((value, index) =>
        assertNonEmpty(value, `${label}[${index}]`),
      ),
    ),
  ];
}

function compileHttpAuth(
  auth: AgentMcpHttpAuth | undefined,
): Partial<Pick<ServerEntry, "auth" | "oauth" | "bearerTokenEnv">> {
  if (!auth || auth.kind === "none") {
    return { auth: false, oauth: false };
  }
  if (auth.kind === "oauth") {
    return { auth: "oauth" };
  }
  return {
    auth: "bearer",
    bearerTokenEnv: assertNonEmpty(auth.env, "MCP bearer token env"),
  };
}

function compileServer(server: AgentMcpServerDefinition): ServerEntry {
  const includeTools = normalizeToolPatterns(
    server.includeTools,
    `MCP server "${server.name}" includeTools`,
  );
  if (includeTools.length === 0) {
    throw new Error(
      `MCP server "${server.name}" must declare at least one includeTools entry`,
    );
  }

  const common: ServerEntry = {
    lifecycle: server.lifecycle ?? "lazy",
    includeTools,
    excludeTools: normalizeToolPatterns(
      server.excludeTools ?? [],
      `MCP server "${server.name}" excludeTools`,
    ),
    directTools: false,
    debug: false,
    trace: false,
  };

  if (server.transport.kind === "stdio") {
    return {
      ...common,
      command: assertNonEmpty(
        server.transport.command,
        `MCP server "${server.name}" command`,
      ),
      ...(server.transport.args ? { args: [...server.transport.args] } : {}),
      ...(server.transport.cwd ? { cwd: server.transport.cwd } : {}),
      // Do not expose Publisher credentials to local MCP children by default.
      inheritEnv: false,
    };
  }

  const rawUrl = assertNonEmpty(
    server.transport.url,
    `MCP server "${server.name}" url`,
  );
  let url: URL;
  try {
    url = new URL(rawUrl);
  } catch (error) {
    throw new Error(`MCP server "${server.name}" has an invalid URL`, {
      cause: error,
    });
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error(
      `MCP server "${server.name}" URL must use http or https`,
    );
  }

  return {
    ...common,
    url: url.toString(),
    httpTransport: "streamable-http",
    ...compileHttpAuth(server.transport.auth),
  };
}

export function compilePublisherMcpProfile(
  profile: AgentMcpProfile | undefined,
): CompiledPublisherMcpProfile {
  if (!profile || profile.servers.length === 0) {
    return { extensionFactories: [], toolNames: [] };
  }

  const mcpServers: Record<string, ServerEntry> = {};
  for (const server of profile.servers) {
    const name = assertNonEmpty(server.name, "MCP server name");
    if (Object.hasOwn(mcpServers, name)) {
      throw new Error(`Duplicate MCP server name "${name}"`);
    }
    mcpServers[name] = compileServer({ ...server, name });
  }

  const config: NonNullable<McpAdapterOptions["config"]> = {
    mcpServers,
    settings: {
      directTools: false,
      scriptMode: false,
      hostConfigDiscovery: "off",
      notifyOnStartupConnect: false,
      mcpFooterStatus: "off",
      autoAuth: false,
      authRequiredMessage:
        'MCP server "${server}" requires authentication through Publisher-controlled setup.',
    },
  };

  return {
    extensionFactories: [createMcpAdapter({ config })],
    toolNames: ["mcp"],
  };
}
