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
  expect(login.needsHuman).toBe(true);
  expect(approval.approval?.warnings.length).toBeTruthy();
  expect((succeeded.evidence?.length ?? 0) >= 3).toBe(true);
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
