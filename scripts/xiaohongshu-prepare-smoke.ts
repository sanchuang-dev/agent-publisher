import {
  runXiaohongshuPrepareSmoke,
  XiaohongshuPrepareSmokeError,
} from "../src/smoke/xiaohongshu-prepare-smoke.js";

try {
  await runXiaohongshuPrepareSmoke({
    onEvidence: (evidence) => {
      process.stdout.write(JSON.stringify(evidence) + "\n");
    },
  });
} catch (error) {
  const payload =
    error instanceof XiaohongshuPrepareSmokeError
      ? {
          smoke: "xiaohongshu-prepare",
          status: "blocked",
          code: error.code,
          ...(error.detailCode === undefined
            ? {}
            : { detailCode: error.detailCode }),
          message: error.message,
        }
      : {
          smoke: "xiaohongshu-prepare",
          status: "blocked",
          code: "SMOKE_FAILED",
          message: "Xiaohongshu prepare smoke failed before producing bounded acceptance evidence.",
        };

  process.stderr.write(JSON.stringify(payload) + "\n");
  process.exitCode = 1;
}
