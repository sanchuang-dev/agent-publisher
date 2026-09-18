import { expect, test } from "vitest";
import {
  fixtureStates,
  getTaskFixture,
  getWorkSurfaceKind,
  taskRepository,
} from "../src/model.js";

test("all six MVP fixture states are independently addressable", () => {
  expect(fixtureStates).toEqual([
    "preparing_materials",
    "preparing_publish",
    "waiting_for_login",
    "waiting_for_approval",
    "succeeded",
    "failed",
  ]);

  for (const state of fixtureStates) {
    expect(getTaskFixture(state).state).toBe(state);
  }
});

test("work surface mapping follows the approved product states", () => {
  expect(fixtureStates.map(getWorkSurfaceKind)).toEqual([
    "material",
    "browser",
    "takeover",
    "approval",
    "evidence",
    "failure",
  ]);
});

test("login, approval and success fixtures expose required payloads", () => {
  const login = getTaskFixture("waiting_for_login");
  const approval = getTaskFixture("waiting_for_approval");
  const succeeded = getTaskFixture("succeeded");

  expect(login.browserLiveViewUrl).toBe("/browser-live-view-placeholder.html");
  expect(login.browserLiveViewMode).toBe("placeholder");
  expect(login.controlOwner).toBe("human");
  expect(login.needsHuman).toBe(true);
  expect(getTaskFixture("preparing_publish").controlOwner).toBe("agent");
  expect(approval.approval?.warnings.length).toBeTruthy();
  expect((succeeded.evidence?.length ?? 0) >= 3).toBe(true);
});


test("runtime config overrides the fixture placeholder only for browser states", () => {
  const runtimeConfig = {
    liveViewUrl: "http://127.0.0.1:6080/vnc.html",
  };

  expect(
    getTaskFixture("preparing_publish", undefined, runtimeConfig)
      .browserLiveViewUrl,
  ).toBe(runtimeConfig.liveViewUrl);
  const runtimeLogin = getTaskFixture(
    "waiting_for_login",
    undefined,
    runtimeConfig,
  );
  expect(runtimeLogin.controlOwner).toBe("human");
  expect(runtimeLogin.browserLiveViewMode).toBe("runtime");
  expect(
    getTaskFixture("preparing_materials", undefined, runtimeConfig)
      .browserLiveViewUrl,
  ).toBeUndefined();
});

test("non-browser fixtures do not expose browser runtime state", () => {
  for (const state of [
    "preparing_materials",
    "waiting_for_approval",
    "succeeded",
    "failed",
  ] as const) {
    const task = getTaskFixture(state);
    expect(task.browserLiveViewUrl).toBeUndefined();
    expect(task.browserLiveViewMode).toBeUndefined();
    expect(task.controlOwner).toBeUndefined();
  }
});

test("blocked runtime config remains distinguishable from fixture fallback", () => {
  const task = getTaskFixture("waiting_for_login", undefined, {
    liveViewUrl: "http://browser-runtime:9222",
  });

  expect(task.browserLiveViewUrl).toBe("/browser-live-view-placeholder.html");
  expect(task.browserLiveViewMode).toBe("blocked");
});

test("assigned brief and publish mode survive the handoff into task detail", async () => {
  taskRepository.assign({
    brief: "用自定义 brief 发布一条视频任务",
    publishMode: "video",
  });

  const assigned = await taskRepository.get("preparing_materials");

  expect(assigned.brief).toBe("用自定义 brief 发布一条视频任务");
  expect(assigned.publishMode).toBe("video");
  expect(assigned.material.mode).toBe("video");
  expect(assigned.material.media).toEqual(["视频成片", "视频封面"]);
});
