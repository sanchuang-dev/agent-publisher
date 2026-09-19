/**
 * Browser Live View runtime adapter.
 *
 * This module is the frontend boundary for selecting a trusted Live View URL
 * and mapping browser-surface task state to control ownership.
 *
 * Local demo mode accepts the browser-runtime loopback noVNC endpoint on 6080.
 * Remote deployments must expose Live View through a same-origin app/reverse-
 * proxy path, represented here as a root-relative URL.
 */

export const PLACEHOLDER_URL = "/browser-live-view-placeholder.html";

const BLOCKED_PORTS = new Set(["5900", "9222"]);
const BLOCKED_CDP_PATHS = [
  /^\/json(?:\/|$)/i,
  /^\/devtools(?:\/|$)/i,
];
const LOCAL_LIVE_VIEW_HOSTS = new Set([
  "localhost",
  "127.0.0.1",
  "[::1]",
  "::1",
]);
const RELATIVE_LIVE_VIEW_ORIGIN = "http://live-view.invalid";
const UNSAFE_RELATIVE_CHARS = /[\\\u0000-\u001f\u007f]/;

const SENSITIVE_QUERY_KEYS = new Set([
  "token",
  "access_token",
  "password",
  "passwd",
  "secret",
  "auth",
  "authorization",
  "api_key",
  "apikey",
]);

export type BrowserLiveViewState =
  | "preparing_publish"
  | "waiting_for_login"
  | "publishing";
export type ControlOwner = "agent" | "human";
export type LiveViewMode = "runtime" | "placeholder" | "blocked";

export interface LiveViewRuntimeConfig {
  liveViewUrl?: string;
}

export interface LiveViewDescriptor {
  url: string;
  controlOwner: ControlOwner;
  mode: LiveViewMode;
}

/**
 * Reads the build/runtime configuration boundary without leaking environment
 * checks into React components.
 */
export function readLiveViewRuntimeConfig(
  env: Record<string, unknown>,
): LiveViewRuntimeConfig {
  const candidate = env.VITE_LIVE_VIEW_URL;
  if (typeof candidate !== "string" || !candidate.trim()) {
    return {};
  }

  return { liveViewUrl: candidate.trim() };
}

function decodedPathname(url: URL): string | undefined {
  let pathname = url.pathname;

  for (let attempt = 0; attempt < 8; attempt += 1) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(pathname);
    } catch {
      return undefined;
    }

    if (decoded === pathname) {
      return decoded;
    }

    pathname = decoded;
  }

  return undefined;
}

function hasSensitiveParams(url: URL): boolean {
  const queryKeys = [...url.searchParams.keys()];
  const hashParams = new URLSearchParams(
    url.hash.startsWith("#") ? url.hash.slice(1) : url.hash,
  );

  return [...queryKeys, ...hashParams.keys()].some((key) =>
    SENSITIVE_QUERY_KEYS.has(key.toLowerCase()),
  );
}

function hasBlockedControlEndpoint(url: URL): boolean {
  if (BLOCKED_PORTS.has(url.port)) {
    return true;
  }

  const pathname = decodedPathname(url);
  if (!pathname || UNSAFE_RELATIVE_CHARS.test(pathname)) {
    return true;
  }

  return BLOCKED_CDP_PATHS.some((pattern) => pattern.test(pathname));
}

/**
 * Returns true when a configured URL is outside the supported trust boundary.
 *
 * Allowed:
 * - root-relative same-origin reverse-proxy paths, e.g. /browser/live/vnc.html
 * - local demo noVNC on http://localhost|127.0.0.1|::1:6080
 *
 * Rejected:
 * - raw CDP / VNC endpoints;
 * - credentials in the URL;
 * - protocol-relative or arbitrary external origins;
 * - non-http(s) schemes.
 */
export function isBlockedLiveViewUrl(rawUrl: string): boolean {
  const candidate = rawUrl.trim();
  if (!candidate) return false;

  try {
    if (candidate.startsWith("/") && !candidate.startsWith("//")) {
      if (UNSAFE_RELATIVE_CHARS.test(candidate)) {
        return true;
      }

      const relativeUrl = new URL(candidate, RELATIVE_LIVE_VIEW_ORIGIN);
      if (relativeUrl.origin !== RELATIVE_LIVE_VIEW_ORIGIN) {
        return true;
      }

      return (
        hasSensitiveParams(relativeUrl) ||
        hasBlockedControlEndpoint(relativeUrl)
      );
    }

    const url = new URL(candidate);

    if (url.protocol !== "http:" && url.protocol !== "https:") {
      return true;
    }

    if (
      url.username ||
      url.password ||
      hasSensitiveParams(url) ||
      hasBlockedControlEndpoint(url)
    ) {
      return true;
    }

    return !(
      url.protocol === "http:" &&
      LOCAL_LIVE_VIEW_HOSTS.has(url.hostname) &&
      url.port === "6080"
    );
  } catch {
    return true;
  }
}

export function getLiveViewMode(runtimeUrl?: string): LiveViewMode {
  const candidate = runtimeUrl?.trim();
  if (!candidate) {
    return "placeholder";
  }

  return isBlockedLiveViewUrl(candidate) ? "blocked" : "runtime";
}

export function resolveLiveViewUrl(runtimeUrl?: string): string {
  return getLiveViewMode(runtimeUrl) === "runtime"
    ? runtimeUrl!.trim()
    : PLACEHOLDER_URL;
}

export function getControlOwner(
  state: BrowserLiveViewState,
): ControlOwner {
  return state === "waiting_for_login" ? "human" : "agent";
}

export function getLiveViewDescriptor(
  state: BrowserLiveViewState,
  runtimeUrl?: string,
): LiveViewDescriptor {
  return {
    url: resolveLiveViewUrl(runtimeUrl),
    controlOwner: getControlOwner(state),
    mode: getLiveViewMode(runtimeUrl),
  };
}
