import { readFile, stat } from "node:fs/promises";
import { extname, resolve, sep } from "node:path";
import { connect, type Socket } from "node:net";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";

import type {
  FastifyInstance,
  FastifyReply,
  FastifyRequest,
} from "fastify";

export const BROWSER_LIVE_VIEW_PATH_PREFIX = "/browser-live-view/" as const;

export interface ProductSurfaceOptions {
  readonly webRoot?: string;
  readonly browserLiveViewUpstream?: string;
}

const STATIC_CONTENT_TYPES: Readonly<Record<string, string>> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

function parseLiveViewUpstream(raw: string): URL {
  let upstream: URL;
  try {
    upstream = new URL(raw);
  } catch {
    throw new Error("APP_BROWSER_LIVE_VIEW_UPSTREAM must be a valid internal HTTP URL");
  }

  if (upstream.protocol !== "http:") {
    throw new Error("APP_BROWSER_LIVE_VIEW_UPSTREAM must use internal HTTP");
  }

  if (
    upstream.username ||
    upstream.password ||
    upstream.search ||
    upstream.hash ||
    upstream.port === "9222"
  ) {
    throw new Error(
      "APP_BROWSER_LIVE_VIEW_UPSTREAM must target the bounded browser Live View HTTP surface, not credentials, query state, or raw CDP",
    );
  }

  return upstream;
}

function buildUpstreamUrl(
  upstream: URL,
  requestUrl: string,
): URL {
  const requested = new URL(requestUrl, "http://publisher.invalid");
  const suffix = requested.pathname.slice(BROWSER_LIVE_VIEW_PATH_PREFIX.length);
  const basePath = upstream.pathname.endsWith("/")
    ? upstream.pathname
    : upstream.pathname + "/";

  const target = new URL(upstream);
  target.pathname = basePath + suffix;
  target.search = requested.search;
  return target;
}

function staticCandidate(webRoot: string, pathname: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }

  if (
    decoded.includes("\\") ||
    decoded.includes("\u0000") ||
    decoded.split("/").some((segment) => segment === "..")
  ) {
    return null;
  }

  const relativePath = decoded.replace(/^\/+/, "") || "index.html";
  const candidate = resolve(webRoot, relativePath);
  const rootPrefix = webRoot.endsWith(sep) ? webRoot : webRoot + sep;

  return candidate === webRoot || candidate.startsWith(rootPrefix)
    ? candidate
    : null;
}

async function isRegularFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function sendStaticFile(
  reply: FastifyReply,
  path: string,
  immutable: boolean,
): Promise<FastifyReply> {
  const content = await readFile(path);
  const contentType =
    STATIC_CONTENT_TYPES[extname(path).toLowerCase()] ??
    "application/octet-stream";

  reply.type(contentType);
  reply.header(
    "cache-control",
    immutable ? "public, max-age=31536000, immutable" : "no-cache",
  );
  return reply.send(content);
}

function isReservedProductPath(pathname: string): boolean {
  return (
    pathname === "/api" ||
    pathname.startsWith("/api/") ||
    pathname === "/health" ||
    pathname.startsWith("/health/") ||
    pathname === BROWSER_LIVE_VIEW_PATH_PREFIX.slice(0, -1) ||
    pathname.startsWith(BROWSER_LIVE_VIEW_PATH_PREFIX)
  );
}

function forwardBrowserHeaders(request: FastifyRequest): Headers {
  const headers = new Headers();

  for (const name of ["accept", "accept-language", "range", "user-agent"] as const) {
    const value = request.headers[name];
    if (typeof value === "string") headers.set(name, value);
  }

  return headers;
}

async function proxyBrowserHttp(
  request: FastifyRequest,
  reply: FastifyReply,
  upstream: URL,
): Promise<FastifyReply> {
  const target = buildUpstreamUrl(upstream, request.raw.url ?? request.url);
  let response: Response;

  try {
    response = await fetch(target, {
      method: request.method === "HEAD" ? "HEAD" : "GET",
      headers: forwardBrowserHeaders(request),
      redirect: "manual",
    });
  } catch {
    return reply
      .code(502)
      .type("text/plain; charset=utf-8")
      .send("Browser Live View is unavailable.");
  }

  reply.code(response.status);

  for (const headerName of [
    "cache-control",
    "content-type",
    "etag",
    "last-modified",
  ]) {
    const value = response.headers.get(headerName);
    if (value) reply.header(headerName, value);
  }

  if (request.method === "HEAD") {
    return reply.send();
  }

  return reply.send(Buffer.from(await response.arrayBuffer()));
}

function writeUpgradeRequest(
  request: IncomingMessage,
  upstreamSocket: Socket,
  target: URL,
): void {
  upstreamSocket.write(
    `${request.method ?? "GET"} ${target.pathname}${target.search} HTTP/${request.httpVersion}\r\n`,
  );
  upstreamSocket.write(`Host: ${target.host}\r\n`);

  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    const name = request.rawHeaders[index] ?? "";
    const value = request.rawHeaders[index + 1] ?? "";

    if (name.toLowerCase() === "host") continue;
    upstreamSocket.write(`${name}: ${value}\r\n`);
  }

  upstreamSocket.write("\r\n");
}

export function registerProductSurface(
  server: FastifyInstance,
  options: ProductSurfaceOptions,
): void {
  const webRoot = options.webRoot ? resolve(options.webRoot) : undefined;
  const liveViewUpstream = options.browserLiveViewUpstream
    ? parseLiveViewUpstream(options.browserLiveViewUpstream)
    : undefined;
  const activeSockets = new Set<Duplex>();

  if (liveViewUpstream) {
    server.get(
      BROWSER_LIVE_VIEW_PATH_PREFIX + "*",
      async (request, reply) =>
        proxyBrowserHttp(request, reply, liveViewUpstream),
    );

    const upgradeHandler = (
      request: IncomingMessage,
      clientSocket: Duplex,
      head: Buffer,
    ): void => {
      const requestUrl = request.url ?? "";
      if (!requestUrl.startsWith(BROWSER_LIVE_VIEW_PATH_PREFIX)) return;

      const target = buildUpstreamUrl(liveViewUpstream, requestUrl);
      const upstreamSocket = connect({
        host: liveViewUpstream.hostname,
        port: Number(liveViewUpstream.port || "80"),
      });

      activeSockets.add(clientSocket);
      activeSockets.add(upstreamSocket);
      clientSocket.pause();

      const release = (): void => {
        activeSockets.delete(clientSocket);
        activeSockets.delete(upstreamSocket);
      };

      upstreamSocket.once("connect", () => {
        writeUpgradeRequest(request, upstreamSocket, target);
        if (head.length > 0) upstreamSocket.write(head);

        clientSocket.pipe(upstreamSocket);
        upstreamSocket.pipe(clientSocket);
        clientSocket.resume();
      });

      upstreamSocket.once("error", () => {
        if (!clientSocket.destroyed) {
          clientSocket.write(
            "HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n",
          );
          clientSocket.destroy();
        }
      });

      clientSocket.once("error", () => upstreamSocket.destroy());
      clientSocket.once("close", release);
      upstreamSocket.once("close", release);
    };

    server.server.on("upgrade", upgradeHandler);
    server.addHook("preClose", async () => {
      server.server.off("upgrade", upgradeHandler);
      for (const socket of activeSockets) socket.destroy();
      activeSockets.clear();
    });
  }

  if (webRoot) {
    server.get("/*", async (request, reply) => {
      const requested = new URL(
        request.raw.url ?? request.url,
        "http://publisher.invalid",
      );

      if (isReservedProductPath(requested.pathname)) {
        return reply.callNotFound();
      }

      const candidate = staticCandidate(webRoot, requested.pathname);
      if (!candidate) {
        return reply.callNotFound();
      }

      if (await isRegularFile(candidate)) {
        return sendStaticFile(
          reply,
          candidate,
          requested.pathname.startsWith("/assets/"),
        );
      }

      if (extname(requested.pathname)) {
        return reply.callNotFound();
      }

      const indexPath = resolve(webRoot, "index.html");
      if (!(await isRegularFile(indexPath))) {
        return reply.callNotFound();
      }

      return sendStaticFile(reply, indexPath, false);
    });
  }
}
