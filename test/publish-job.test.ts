import { expect, test } from "vitest";

import {
  isPublishPlatform,
  publishPlatforms,
} from "../src/contracts/publish-job.js";

test("the POC exposes the agreed initial publishing targets", () => {
  expect(publishPlatforms).toEqual([
    "xiaohongshu",
    "douyin",
    "wechat-official-account",
  ]);

  expect(isPublishPlatform("xiaohongshu")).toBe(true);
  expect(isPublishPlatform("generic-browser-agent")).toBe(false);
});
