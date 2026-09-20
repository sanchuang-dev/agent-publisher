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
  if (normalized.length === 0) {
    throw new Error(`${label} must not be empty`);
  }
  return normalized;
}

function normalizeToolPatterns(
  values: readonly string[],
  label: string,
): string[] {
  const normalized = values.map((value, index) =>
    assertNonEmpty(value, `${label}[${index}]`),
  );
  return [...new Set(normalized)];
}

function resolveProcessEnv(name: string, label: string): string {
  const envName = assertNonEmpty(name, label);
  const value = process.env[envName];
  if (value === undefined) {
    throw new Error(
      `${label} references missing Publisher environment variable "${envName}"`,
    );
  }
  return value;
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

  const excludeTools = normalizeToolPatterns(
    server.excludeTools ?? [],
    `MCP server "${server.name}" excludeTools`,
  );
  const excluded = new Set(excludeTools);
  const overlap = includeTools.filter((tool) => excluded.has(tool));
  if (overlap.length > 0) {
    throw new Error(
      `MCP server "${server.name}" includes and excludes the same tool pattern: ${overlap.join(", ")}`,
    );
  }

  const common: ServerEntry = {
    lifecycle: server.lifecycle ?? "lazy",
    includeTools,
    excludeTools,
    directTools: false,
    debug: false,
    trace: false,
  };

  if (server.transport.kind === "stdio") {
    const envNames = [
      ...new Set(
        (server.transport.envFromProcess ?? []).map((name, index) =>
          assertNonEmpty(
            name,
            `MCP server "${server.name}" envFromProcess[${index}]`,
          ),
        ),
      ),
    ];
    const env =
      envNames.length === 0
        ? undefined
        : Object.fromEntries(
            envNames.map((name) => [
              name,
              resolveProcessEnv(
                name,
                `MCP server "${server.name}" envFromProcess`,
              ),
            ]),
          );

    return {
      ...common,
      command: assertNonEmpty(
        server.transport.command,
        `MCP server "${server.name}" command`,
      ),
      args: server.transport.args ? [...server.transport.args] : undefined,
      cwd: server.transport.cwd,
      env,
      inheritEnv: server.transport.inheritEnv ?? false,
    };
  }

  const urlText = assertNonEmpty(
    server.transport.url,
    `MCP server "${server.name}" url`,
  );
  let parsed: URL;
  try {
    parsed = new URL(urlText);
  } catch (error) {
    throw new Error(`MCP server "${server.name}" has an invalid URL`, {
      cause: error,
    });
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(
      `MCP server "${server.name}" URL must use http or https`,
    );
  }

  const headerEntries = Object.entries(
    server.transport.headersFromEnvironment ?? {},
  ).map(([headerName, envName]) => [
    assertNonEmpty(
      headerName,
      `MCP server "${server.name}" HTTP header name`,
    ),
    resolveProcessEnv(
      envName,
      `MCP server "${server.name}" HTTP header "${headerName}"`,
    ),
  ]);
  const headers =
    headerEntries.length === 0
      ? undefined
      : Object.fromEntries(headerEntries);

  return {
    ...common,
    url: parsed.toString(),
    httpTransport: "streamable-http",
    headers,
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
      namespaceProxyTools: false,
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
    extensionFactories: [
      createMcpAdapter({ config }) as unknown as InlineExtension,
    ],
    toolNames: ["mcp"],
  };
}
