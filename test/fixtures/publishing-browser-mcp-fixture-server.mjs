import { createInterface } from "node:readline";

function tools() {
  return [
    {
      name: "browser_navigate",
      description: "Controlled browser navigation fixture.",
      inputSchema: {
        type: "object",
        properties: { url: { type: "string" } },
        required: ["url"],
        additionalProperties: false,
      },
    },
    {
      name: "browser_file_upload",
      description: "Controlled browser upload fixture.",
      inputSchema: {
        type: "object",
        properties: {
          paths: { type: "array", items: { type: "string" } },
        },
        additionalProperties: false,
      },
    },
    {
      name: "browser_click",
      description: "Controlled browser click fixture.",
      inputSchema: {
        type: "object",
        properties: {
          element: { type: "string" },
          target: { type: "string" },
        },
        required: ["target"],
        additionalProperties: false,
      },
    },
  ];
}

function responseFor(message) {
  if (!message || typeof message !== "object" || message.id === undefined) {
    return null;
  }

  const base = { jsonrpc: "2.0", id: message.id };
  if (message.method === "initialize") {
    return {
      ...base,
      result: {
        protocolVersion: message.params?.protocolVersion ?? "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "publisher-browser-fixture", version: "1.0.0" },
      },
    };
  }
  if (message.method === "ping") return { ...base, result: {} };
  if (message.method === "tools/list") {
    return { ...base, result: { tools: tools() } };
  }
  if (message.method === "tools/call") {
    const name = message.params?.name;
    const args = message.params?.arguments ?? {};
    if (name === "browser_navigate") {
      return {
        ...base,
        result: {
          content: [{
            type: "text",
            text:
              `BROWSER_NAVIGATE_EXECUTED:${String(args.url ?? "")}\n` +
              '- button "Safe next" [ref=e2]\n' +
              '- button "发布" [ref=e99]\n' +
              '- textbox "Title" [ref=e3]',
          }],
        },
      };
    }
    if (name === "browser_file_upload") {
      return {
        ...base,
        result: {
          content: [{
            type: "text",
            text: `BROWSER_UPLOAD_EXECUTED:${JSON.stringify(args.paths ?? [])}`,
          }],
        },
      };
    }
    if (name === "browser_click") {
      return {
        ...base,
        result: {
          content: [{
            type: "text",
            text: `BROWSER_CLICK_EXECUTED:${String(args.element ?? "")}`,
          }],
        },
      };
    }
    return {
      ...base,
      error: { code: -32602, message: `Unknown fixture tool: ${String(name)}` },
    };
  }
  return {
    ...base,
    error: { code: -32601, message: `Method not found: ${String(message.method)}` },
  };
}

const lines = createInterface({ input: process.stdin });
lines.on("line", (line) => {
  if (!line.trim()) return;
  let message;
  try {
    message = JSON.parse(line);
  } catch (error) {
    console.error("invalid browser MCP fixture JSON", error);
    return;
  }
  const response = responseFor(message);
  if (response) process.stdout.write(`${JSON.stringify(response)}\n`);
});
