import assert from "node:assert/strict";
import test from "node:test";

import {
  fixtureStates,
  getTaskFixture,
  getWorkSurfaceKind,
  taskRepository,
} from "../src/model.js";

test("all six MVP fixture states are independently addressable", () => {
  assert.deepEqual(fixtureStates, [
    "preparing_materials",
    "preparing_publish",
    "waiting_for_login",
    "waiting_for_approval",
    "succeeded",
    "failed",
  ]);

  for (const state of fixtureStates) {
    assert.equal(getTaskFixture(state).state, state);
  }
});

test("work surface mapping follows the approved product states", () => {
  assert.deepEqual(fixtureStates.map(getWorkSurfaceKind), [
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

  assert.equal(
    login.browserLiveViewUrl,
    "/browser-live-view-placeholder.html",
  );
  assert.equal(login.needsHuman, true);
  assert.ok(approval.approval?.warnings.length);
  assert.ok((succeeded.evidence?.length ?? 0) >= 3);
});


test("assigned brief and publish mode survive the handoff into task detail", async () => {
  taskRepository.assign({
    brief: "用自定义 brief 发布一条视频任务",
    publishMode: "video",
  });

  const assigned = await taskRepository.get("preparing_materials");

  assert.equal(assigned.brief, "用自定义 brief 发布一条视频任务");
  assert.equal(assigned.publishMode, "video");
  assert.equal(assigned.material.mode, "video");
  assert.deepEqual(assigned.material.media, ["视频成片", "视频封面"]);
});
