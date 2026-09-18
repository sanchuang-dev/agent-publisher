import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

import { App } from "../src/App.js";

afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
  window.location.hash = "#/";
});

test("placeholder takeover does not claim interactive human control", async () => {
  window.location.hash = "#/task/waiting_for_login";
  render(<App />);

  await screen.findByText("等待 Browser Live View");
  await screen.findByText("Live View 未连接");
  expect(screen.queryByText("控制权已让给你")).toBeNull();

  const frame = await screen.findByTitle("Browser Live View");
  expect(frame.classList.contains("live-view-view-only")).toBe(true);
  expect((frame as HTMLIFrameElement).tabIndex).toBe(-1);
});

test("Browser surface uses injected trusted Live View URL in agent view-only mode", async () => {
  const fakeUrl = "/fake-novnc/vnc.html";
  vi.stubEnv("VITE_LIVE_VIEW_URL", fakeUrl);
  window.location.hash = "#/task/preparing_publish";

  render(<App />);

  const frame = await screen.findByTitle("Browser Live View");
  expect(frame.getAttribute("src")).toBe(fakeUrl);
  expect(frame.classList.contains("live-view-view-only")).toBe(true);
  expect((frame as HTMLIFrameElement).tabIndex).toBe(-1);
  await screen.findByText("执行秘书控制");
});

test("trusted runtime takeover is interactive", async () => {
  vi.stubEnv("VITE_LIVE_VIEW_URL", "/fake-novnc/vnc.html");
  window.location.hash = "#/task/waiting_for_login";

  render(<App />);

  await screen.findByText("请接管登录");
  await screen.findByText("控制权已让给你");

  const frame = await screen.findByTitle("Browser Live View");
  expect(frame.classList.contains("live-view-interactive")).toBe(true);
  expect((frame as HTMLIFrameElement).tabIndex).toBe(0);
});

test("blocked runtime config is surfaced as unavailable", async () => {
  vi.stubEnv("VITE_LIVE_VIEW_URL", "http://browser-runtime:9222");
  window.location.hash = "#/task/waiting_for_login";

  render(<App />);

  await screen.findByText("Live View 不可用");
  expect(screen.queryByText("控制权已让给你")).toBeNull();

  const frame = await screen.findByTitle("Browser Live View");
  expect(frame.getAttribute("src")).toBe("/browser-live-view-placeholder.html");
  expect(frame.classList.contains("live-view-view-only")).toBe(true);
});
