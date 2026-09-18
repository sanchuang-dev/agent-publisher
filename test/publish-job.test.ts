import assert from "node:assert/strict";
import test from "node:test";

import {
  isPublishPlatform,
  publishPlatforms,
} from "../src/contracts/publish-job.js";

test("the POC exposes the agreed initial publishing targets", () => {
  assert.deepEqual(publishPlatforms, [
    "xiaohongshu",
    "douyin",
    "wechat-official-account",
  ]);

  assert.equal(isPublishPlatform("xiaohongshu"), true);
  assert.equal(isPublishPlatform("generic-browser-agent"), false);
});
