import { expect, test } from "vitest";
import {
  getControlOwner,
  getLiveViewDescriptor,
  getLiveViewMode,
  isBlockedLiveViewUrl,
  PLACEHOLDER_URL,
  readLiveViewRuntimeConfig,
  resolveLiveViewUrl,
} from "../src/live-view-adapter.js";

test("runtime config selects and normalizes the configured Live View URL", () => {
  expect(readLiveViewRuntimeConfig({})).toEqual({});
  expect(readLiveViewRuntimeConfig({ VITE_LIVE_VIEW_URL: "   " })).toEqual({});
  expect(
    readLiveViewRuntimeConfig({
      VITE_LIVE_VIEW_URL: "  http://127.0.0.1:6080/vnc.html  ",
    }),
  ).toEqual({ liveViewUrl: "http://127.0.0.1:6080/vnc.html" });
});

test("Live View guard blocks raw CDP port 9222 regardless of path or query", () => {
  for (const url of [
    "http://localhost:9222",
    "http://localhost:9222/json/version",
    "http://browser-runtime:9222?target=page",
    "http://127.0.0.1:9222/devtools/browser/abc",
  ]) {
    expect(isBlockedLiveViewUrl(url)).toBe(true);
    expect(resolveLiveViewUrl(url)).toBe(PLACEHOLDER_URL);
    expect(getLiveViewMode(url)).toBe("blocked");
  }
});

test("Live View guard blocks raw VNC and arbitrary external origins", () => {
  expect(isBlockedLiveViewUrl("http://127.0.0.1:5900")).toBe(true);
  expect(isBlockedLiveViewUrl("//browser-runtime:6080/")).toBe(true);
  expect(isBlockedLiveViewUrl("https://browser.example/live/vnc.html")).toBe(
    true,
  );
});

test("root-relative Live View paths cannot escape the same-origin boundary", () => {
  const backslashEscape = "/" + "\\" + "evil.com";
  const controlEscape = "/\n//evil.com";

  expect(isBlockedLiveViewUrl(backslashEscape)).toBe(true);
  expect(getLiveViewMode(backslashEscape)).toBe("blocked");
  expect(isBlockedLiveViewUrl(controlEscape)).toBe(true);
  expect(getLiveViewMode(controlEscape)).toBe("blocked");
});

test("Live View guard blocks canonicalized CDP paths behind an allowed boundary", () => {
  expect(isBlockedLiveViewUrl("/json/version")).toBe(true);
  expect(isBlockedLiveViewUrl("/JSON/version")).toBe(true);
  expect(isBlockedLiveViewUrl("/%6a%73%6f%6e/version")).toBe(true);
  expect(isBlockedLiveViewUrl("/%25256a%252573%25256f%25256e/version")).toBe(
    true,
  );
  expect(isBlockedLiveViewUrl("/%5c%5cevil.com/vnc.html")).toBe(true);
  expect(isBlockedLiveViewUrl("http://localhost:6080/devtools/browser/abc")).toBe(
    true,
  );
});

test("Live View guard blocks credentials, sensitive URL params, and non-web schemes", () => {
  expect(isBlockedLiveViewUrl("http://user:pass@localhost:6080/vnc.html")).toBe(
    true,
  );
  expect(isBlockedLiveViewUrl("/browser/live/vnc.html?token=secret")).toBe(true);
  expect(
    isBlockedLiveViewUrl("/browser/live/vnc.html#access_token=secret"),
  ).toBe(true);
  expect(isBlockedLiveViewUrl("vnc://localhost:6080")).toBe(true);
  expect(isBlockedLiveViewUrl("javascript:alert(1)")).toBe(true);
});

test("Live View guard permits the local noVNC contract and same-origin proxy paths", () => {
  expect(isBlockedLiveViewUrl("http://localhost:6080/vnc.html")).toBe(false);
  expect(isBlockedLiveViewUrl("http://127.0.0.1:6080/vnc.html")).toBe(false);
  expect(isBlockedLiveViewUrl("/browser/live/vnc.html")).toBe(false);
});

test("unconfigured Live View uses an explicit placeholder mode", () => {
  expect(getLiveViewMode()).toBe("placeholder");
  expect(resolveLiveViewUrl()).toBe(PLACEHOLDER_URL);
  expect(getLiveViewDescriptor("waiting_for_login")).toEqual({
    url: PLACEHOLDER_URL,
    controlOwner: "human",
    mode: "placeholder",
  });
});

test("allowed injected runtime URL is marked as runtime", () => {
  const url = "http://localhost:6080/vnc.html";
  expect(getLiveViewMode(url)).toBe("runtime");
  expect(resolveLiveViewUrl(url)).toBe(url);
});

test("control owner maps browser automation states to agent and login takeover to human", () => {
  expect(getControlOwner("preparing_publish")).toBe("agent");
  expect(getControlOwner("publishing")).toBe("agent");
  expect(getControlOwner("waiting_for_login")).toBe("human");
});

test("descriptor preserves blocked-vs-runtime distinction", () => {
  expect(
    getLiveViewDescriptor(
      "waiting_for_login",
      "http://localhost:6080/vnc.html",
    ),
  ).toEqual({
    url: "http://localhost:6080/vnc.html",
    controlOwner: "human",
    mode: "runtime",
  });

  expect(
    getLiveViewDescriptor("preparing_publish", "http://localhost:9222"),
  ).toEqual({
    url: PLACEHOLDER_URL,
    controlOwner: "agent",
    mode: "blocked",
  });
});
