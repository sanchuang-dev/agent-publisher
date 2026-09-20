import type { ServerResponse } from "node:http";

export interface SseEvent {
  readonly event?: string;
  readonly id?: string;
  readonly data: string | Readonly<Record<string, unknown>>;
}

export interface SseConnection {
  readonly closed: Promise<void>;
  send(event: SseEvent): void;
  close(): void;
}

interface ActiveSseConnection {
  readonly response: ServerResponse;
  readonly closed: Promise<void>;
  finalize(): void;
}

function encodeSingleLine(value: string): string {
  return value.replace(/[\r\n]+/g, " ");
}

export function serializeSseEvent(event: SseEvent): string {
  const lines: string[] = [];

  if (event.id !== undefined) {
    lines.push(`id: ${encodeSingleLine(event.id)}`);
  }

  if (event.event !== undefined) {
    lines.push(`event: ${encodeSingleLine(event.event)}`);
  }

  const payload = typeof event.data === "string" ? event.data : JSON.stringify(event.data);
  for (const line of payload.split(/\r\n|\r|\n/)) {
    lines.push(`data: ${line}`);
  }

  return `${lines.join("\n")}\n\n`;
}

export class SseConnectionRegistry {
  readonly #connections = new Set<ActiveSseConnection>();

  get activeCount(): number {
    return this.#connections.size;
  }

  open(response: ServerResponse): SseConnection {
    if (response.headersSent) {
      throw new Error("Cannot open SSE after response headers have been sent");
    }

    let resolveClosed: (() => void) | undefined;
    const closed = new Promise<void>((resolve) => {
      resolveClosed = resolve;
    });

    let active: ActiveSseConnection;

    const finalize = (): void => {
      if (!this.#connections.delete(active)) {
        return;
      }

      response.off("close", finalize);
      response.off("finish", finalize);
      resolveClosed?.();
    };

    active = {
      response,
      closed,
      finalize,
    };

    this.#connections.add(active);
    response.once("close", finalize);
    response.once("finish", finalize);

    response.writeHead(200, {
      "cache-control": "no-cache",
      connection: "keep-alive",
      "content-type": "text/event-stream; charset=utf-8",
      "x-accel-buffering": "no",
    });

    return {
      closed,
      send: (event) => {
        if (response.destroyed || response.writableEnded) {
          return;
        }

        response.write(serializeSseEvent(event));
      },
      close: () => {
        if (!response.destroyed && !response.writableEnded) {
          response.end();
        }
      },
    };
  }

  async closeAll(): Promise<void> {
    const activeConnections = [...this.#connections];

    for (const connection of activeConnections) {
      if (connection.response.destroyed || connection.response.writableEnded) {
        connection.finalize();
      } else {
        connection.response.end();
      }
    }

    await Promise.all(activeConnections.map((connection) => connection.closed));
  }
}
