import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ContentSecretaryService } from "../src/agent/content-secretary.js";
import { JobAgentSessionService } from "../src/agent/job-session-service.js";
import {
  PUBLISHER_AI_API_KEY_ENV,
  createPublisherAiRuntime,
  createPublisherContentSecretaryHost,
  readPublisherAiConfig,
  redactPublisherAiSecret,
} from "../src/agent/runtime-ai.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

const LIVE_SMOKE_ENV = "PUBLISHER_LIVE_MODEL_SMOKE";

function safeErrorMessage(error: unknown, apiKey: string | undefined): string {
  const message =
    error instanceof Error ? error.message : "Unknown live-model smoke failure.";
  return redactPublisherAiSecret(message, apiKey);
}

function safeErrorCode(error: unknown): string | undefined {
  if (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    typeof (error as { code?: unknown }).code === "string"
  ) {
    return (error as { code: string }).code;
  }
  return undefined;
}

async function main(): Promise<void> {
  if (process.env[LIVE_SMOKE_ENV] !== "1") {
    throw new Error(
      "Live model smoke is disabled. Set " +
        LIVE_SMOKE_ENV +
        "=1 explicitly to run it.",
    );
  }

  const config = readPublisherAiConfig();
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-live-model-"));
  const databasePath = join(root, "publisher.db");
  const sessionDirectory = join(root, "pi-sessions");
  const jobId = "live-model-smoke-" + Date.now().toString(36);
  let db: ReturnType<typeof openDatabase> | null = null;

  try {
    const runtime = await createPublisherAiRuntime(config);
    const host = createPublisherContentSecretaryHost(runtime, {
      cwd: root,
      sessionDirectory,
    });

    db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const sessions = new JobAgentSessionService({ jobs, bindings, host });
    const secretary = new ContentSecretaryService({
      jobs,
      bindings,
      sessions,
    });

    jobs.create({
      id: jobId,
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({
        topic: "Agent Publisher live-model smoke",
        audience: "product builders",
        intent:
          "Produce a small, practical image-text material plan for an internal smoke check.",
      }),
    });

    const result = await secretary.createMaterialPlan(jobId);

    db.close();
    db = null;

    const verificationDb = openDatabase({ databasePath });
    try {
      const verificationJobs = new JobRepository(verificationDb);
      const durableJob = verificationJobs.getById(jobId);
      const materialSteps = verificationJobs
        .getStepsForJob(jobId)
        .filter((step) => step.stepKey === "material_plan");

      if (
        !durableJob ||
        durableJob.status !== "preparing_materials" ||
        durableJob.currentStep !== "material_plan" ||
        durableJob.checkpoint?.phase !== "material_plan_ready" ||
        materialSteps.length !== 1 ||
        materialSteps[0]?.status !== "succeeded"
      ) {
        throw new Error(
          "Live model smoke returned a plan but durable MaterialPlan checkpoint verification failed.",
        );
      }

      console.log(
        JSON.stringify({
          ok: true,
          provider: runtime.providerId,
          model: config.model,
          jobId,
          planId: result.plan.id,
          mode: result.plan.mode,
          checkpointPhase: durableJob.checkpoint.phase,
          stepStatus: materialSteps[0].status,
        }),
      );
    } finally {
      verificationDb.close();
    }
  } finally {
    if (db?.open) {
      db.close();
    }
    rmSync(root, { recursive: true, force: true });
  }
}

void main().catch((error: unknown) => {
  const apiKey = process.env[PUBLISHER_AI_API_KEY_ENV];
  const code = safeErrorCode(error);
  const payload = {
    ok: false,
    error: {
      name: error instanceof Error ? error.name : "Error",
      ...(code === undefined ? {} : { code }),
      message: safeErrorMessage(error, apiKey),
    },
  };
  console.error(JSON.stringify(payload));
  process.exitCode = 1;
});
