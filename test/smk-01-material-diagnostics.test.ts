import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";

import { createMvpPrepublishApplication } from "../src/app/mvp-prepublish-application.js";
import {
  ProviderPipelineMaterialStageError,
  createProviderPipelineMaterialSource,
} from "../src/app/provider-pipeline-material-source.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "agent-publisher-smk-01-"));
}

describe("SMK-01 bounded material diagnostics", () => {
  test("classifies Content Secretary planning failure without exposing the upstream message", async () => {
    const root = makeTempRoot();
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);

    try {
      jobs.create({
        id: "smk-01-plan-failure",
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: JSON.stringify({ brief: "受控诊断 brief" }),
      });

      const source = createProviderPipelineMaterialSource({
        jobs,
        contentSecretary: {
          async createMaterialPlan() {
            throw new Error("upstream-secret-like-detail-must-not-leak");
          },
        },
        preparation: {
          async prepareImageText() {
            throw new Error("preparation must not be reached");
          },
        },
      });

      let observed: unknown;
      try {
        await source.resolve({
          jobId: "smk-01-plan-failure",
          brief: "受控诊断 brief",
        });
      } catch (error) {
        observed = error;
      }

      expect(observed).toBeInstanceOf(ProviderPipelineMaterialStageError);
      expect(observed).toMatchObject({
        stage: "material_plan",
        code: "MATERIAL_GENERATION_FAILED",
        retryable: false,
        message: "Provider pipeline could not produce a valid MaterialPlan.",
      });
      expect(String(observed)).not.toContain(
        "upstream-secret-like-detail-must-not-leak",
      );
    } finally {
      db.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("terminal material failure remains queryable and the HTTP server stays alive", async () => {
    const root = makeTempRoot();
    const databasePath = join(root, "app.db");
    const application = createMvpPrepublishApplication({
      databasePath,
      materialSource: {
        async resolve() {
          throw new ProviderPipelineMaterialStageError(
            "material_plan",
            "MATERIAL_GENERATION_FAILED",
            false,
            "Provider pipeline could not produce a valid MaterialPlan.",
            {
              cause: new Error(
                "upstream-secret-like-detail-must-not-leak",
              ),
            },
          );
        },
      },
      resolveAssetPath: () => "/unused",
    });
    const origin = await application.start({ host: "127.0.0.1", port: 0 });

    try {
      const createResponse = await fetch(origin + "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: "受控 SMK-01 Web 链诊断",
          platform: "xiaohongshu",
          publishMode: "image_text",
        }),
      });
      expect(createResponse.status).toBe(201);
      const created = (await createResponse.json()) as {
        job: { id: string };
      };
      const jobId = created.job.id;

      const continueResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId) + "/continue",
        { method: "POST" },
      );
      expect(continueResponse.status).toBe(200);
      const continued = (await continueResponse.json()) as {
        job: {
          status: string;
          failure: {
            step: string;
            code: string | null;
            message: string;
          } | null;
          timeline: Array<{
            stepKey: string;
            status: string;
            errorCode: string | null;
            errorMessage: string | null;
          }>;
        };
        run: {
          blocked: boolean;
          error: { code: string; message: string } | null;
        };
      };

      expect(continued).toMatchObject({
        job: {
          status: "failed",
          failure: {
            step: "material_pack",
            code: "MATERIAL_SOURCE_UNAVAILABLE",
            message:
              "Material source failed at material_plan (MATERIAL_GENERATION_FAILED).",
          },
        },
        run: {
          blocked: true,
          error: {
            code: "MATERIAL_SOURCE_UNAVAILABLE",
          },
        },
      });
      expect(continued.job.timeline).toContainEqual(
        expect.objectContaining({
          stepKey: "material_pack",
          status: "failed",
          errorCode: "MATERIAL_SOURCE_UNAVAILABLE",
          errorMessage:
            "Material source failed at material_plan (MATERIAL_GENERATION_FAILED).",
        }),
      );

      expect(application.runtime.jobs.getById(jobId)?.checkpoint).toEqual(
        expect.objectContaining({
          phase: "material_source_failed",
          materialFailureStage: "material_plan",
          materialFailureCode: "MATERIAL_GENERATION_FAILED",
        }),
      );

      const rereadResponse = await fetch(
        origin + "/api/jobs/" + encodeURIComponent(jobId),
      );
      expect(rereadResponse.status).toBe(200);
      const rereadText = await rereadResponse.text();
      expect(rereadText).toContain(
        "Material source failed at material_plan (MATERIAL_GENERATION_FAILED).",
      );
      expect(rereadText).not.toContain(
        "upstream-secret-like-detail-must-not-leak",
      );

      const secondCreateResponse = await fetch(origin + "/api/jobs", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          brief: "业务失败后 API 仍应可用",
          platform: "xiaohongshu",
          publishMode: "image_text",
        }),
      });
      expect(secondCreateResponse.status).toBe(201);
    } finally {
      await application.stop();
      rmSync(root, { recursive: true, force: true });
    }
  });
});
