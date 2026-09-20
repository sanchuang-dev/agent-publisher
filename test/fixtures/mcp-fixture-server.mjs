import { createServer } from "node:http";
import { createInterface } from "node:readline";

function tools() {
  return [
    {
      name: "allowed_echo",
      description: "Echoes a controlled test value.",
      inputSchema: {
        type: "object",
        properties: { value: { type: "string" } },
        required: ["value"],
        additionalProperties: false,
      },
    },
    {
      name: "denied_secret",
      description: "Must be filtered by the Publisher allowlist.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
    {
      name: "fixture_pid",
      description: "Returns the fixture process id for lifecycle verification.",
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    },
  ];
}

function responseFor(message) {
  if (!message || typeof message !== "object") return null;
  if (message.id === undefined) return null;

  const base = { jsonrpc: "2.0", id: message.id };
  switch (message.method) {
    case "initialize":
      return {
        ...base,
        result: {
          protocolVersion:
            message.params?.protocolVersion ?? "2025-06-18",
          capabilities: { tools: {} },
          serverInfo: { name: "publisher-mcp-fixture", version: "1.0.0" },
        },
      };
    case "ping":
      return { ...base, result: {} };
    case "tools/list":
      return { ...base, result: { tools: tools() } };
    case "tools/call": {
      const name = message.params?.name;
      const args = message.params?.arguments ?? {};
      if (name === "allowed_echo") {
        return {
          ...base,
          result: {
            content: [{ type: "text", text: `echo:${String(args.value ?? "")}` }],
          },
        };
      }
      if (name === "fixture_pid") {
        return {
          ...base,
          result: {
            content: [{ type: "text", text: `PID:${process.pid}` }],
          },
        };
      }
      if (name === "denied_secret") {
        return {
          ...base,
          result: {
            content: [{ type: "text", text: "DENIED_TOOL_EXECUTED" }],
          },
        };
      }
      return {
        ...base,
        error: { code: -32602, message: `Unknown fixture tool: ${String(name)}` },
      };
    }
    default:
      return {
        ...base,
        error: { code: -32601, message: `Method not found: ${String(message.method)}` },
      };
  }
}

function runStdio() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch (error) {
      console.error("invalid MCP fixture JSON", error);
      return;
    }
    const response = responseFor(message);
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
  });
}

function runHttp(port) {
  const server = createServer(async (request, response) => {
    if (request.url !== "/mcp") {
      response.statusCode = 404;
      response.end();
      return;
    }
    if (request.method !== "POST") {
      response.statusCode = 405;
      response.end();
      return;
    }

    let body = "";
    for await (const chunk of request) body += chunk;
    let message;
    try {
      message = JSON.parse(body);
    } catch {
      response.statusCode = 400;
      response.end();
      return;
    }

    const result = responseFor(message);
    if (!result) {
      response.statusCode = 202;
      response.end();
      return;
    }

    response.statusCode = 200;
    response.setHeader("content-type", "application/json");
    response.end(JSON.stringify(result));
  });

  server.listen(port, "127.0.0.1", () => {
    const address = server.address();
    if (!address || typeof address === "string") {
      throw new Error("HTTP MCP fixture failed to bind");
    }
    process.stdout.write(`HTTP_PORT=${address.port}\n`);
  });

  const stop = () => server.close(() => process.exit(0));
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
}

const [mode, portText] = process.argv.slice(2);
if (mode === "--http") {
  runHttp(Number.parseInt(portText ?? "0", 10) || 0);
} else {
  runStdio();
}
