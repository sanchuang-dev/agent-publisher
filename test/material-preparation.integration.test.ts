import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import {
  CONTENT_SECRETARY_ALLOWED_TOOLS,
  ContentSecretaryService,
  createContentSecretaryResourceLoader,
} from "../src/agent/content-secretary.js";
import { JobAgentSessionService } from "../src/agent/job-session-service.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { LocalAssetStore } from "../src/assets/local-store.js";
import {
  createProviderPipelineMaterialSource,
} from "../src/app/provider-pipeline-material-source.js";
import type { AssetPathResolver } from "../src/platforms/xiaohongshu/image-text-prepare.js";
import {
  fingerprintXiaohongshuImageTextMaterialPack,
} from "../src/platforms/xiaohongshu/image-text-prepare.js";
import {
  MATERIAL_COPY_STEP_KEY,
  MATERIAL_DESIGN_STEP_KEY,
  MATERIAL_IMAGES_STEP_KEY,
  MaterialPreparationProviderError,
  MaterialPreparationService,
  createBuiltinMaterialProviderSlots,
  type ImageTextMaterialPlan,
  type MaterialProviderSlots,
} from "../src/materials/index.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
import { AssetRepository } from "../src/storage/asset-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

async function createFauxRuntime(provider: ReturnType<typeof fauxProvider>) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  return modelRuntime;
}

interface Harness {
  readonly root: string;
  readonly db: ReturnType<typeof openDatabase>;
  readonly jobs: JobRepository;
  readonly assets: AssetRepository;
  readonly store: LocalAssetStore;
  readonly faux: ReturnType<typeof fauxProvider>;
  readonly secretary: ContentSecretaryService;
  readonly calls: {
    text: number;
    image: number;
    design: number;
  };
  readonly providers: MaterialProviderSlots;
  readonly preparation: MaterialPreparationService;
}

const harnesses: Harness[] = [];

async function createHarness(name: string): Promise<Harness> {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-material-prep-"));
  const db = openDatabase({ databasePath: join(root, "app.db") });
  const jobs = new JobRepository(db);
  const assets = new AssetRepository(db);
  const store = new LocalAssetStore(assets, {
    rootDirectory: join(root, "assets"),
  });

  const bindings = new AgentSessionBindingRepository(db);
  const faux = fauxProvider({ provider: name });
  const modelRuntime = await createFauxRuntime(faux);
  const host = new PiAgentHost({
    model: faux.getModel(),
    modelRuntime,
    cwd: root,
    sessionDirectory: join(root, "pi-sessions"),
    defaultRunTimeoutMs: 4_000,
    defaultAbortTimeoutMs: 200,
    defaultDisposeTimeoutMs: 2_000,
    tools: CONTENT_SECRETARY_ALLOWED_TOOLS,
    sessionOptions: { thinkingLevel: "off" },
    createResourceLoader(input) {
      return createContentSecretaryResourceLoader(input);
    },
  });
  const sessions = new JobAgentSessionService({ jobs, bindings, host });
  const secretary = new ContentSecretaryService({
    jobs,
    bindings,
    sessions,
  });

  const builtin = createBuiltinMaterialProviderSlots({ assetStore: store });
  const calls = { text: 0, image: 0, design: 0 };
  const providers: MaterialProviderSlots = {
    text: {
      slot: "text",
      async generate(plan) {
        calls.text += 1;
        return builtin.text.generate(plan);
      },
    },
    image: {
      slot: "image",
      async generate(plan) {
        calls.image += 1;
        return builtin.image.generate(plan);
      },
    },
    design: builtin.design
      ? {
          slot: "design",
          async render(input) {
            calls.design += 1;
            return builtin.design!.render(input);
          },
        }
      : undefined,
  };
  const preparation = new MaterialPreparationService({
    jobs,
    providers,
    assetStore: store,
  });

  const harness = {
    root,
    db,
    jobs,
    assets,
    store,
    faux,
    secretary,
    calls,
    providers,
    preparation,
  };
  harnesses.push(harness);
  return harness;
}

afterEach(() => {
  while (harnesses.length > 0) {
    const harness = harnesses.pop()!;
    harness.db.close();
    rmSync(harness.root, { recursive: true, force: true });
  }
});

function planFixture(
  id: string,
  design: ImageTextMaterialPlan["design"] = "optional",
): ImageTextMaterialPlan {
  return {
    id,
    mode: "image_text",
    brief: {
      id: `${id}-brief`,
      brief:
        "介绍 Agent Publisher：从内容准备、内建物料生成到人工审批，整个流程可见、可恢复、可接管。",
      platform: "xiaohongshu",
      mode: "image_text",
    },
    imageCount: 2,
    coverRequired: true,
    design,
  };
}

function seedPlanCheckpoint(
  jobs: JobRepository,
  jobId: string,
  plan: ImageTextMaterialPlan,
): void {
  jobs.commitCheckpoint(jobId, {
    status: "preparing_materials",
    checkpoint: {
      phase: "material_plan_ready",
      materialPlanId: plan.id,
    },
    step: {
      id: `${jobId}:material-plan:1`,
      stepKey: "material_plan",
      status: "succeeded",
      attempt: 1,
      outputJson: JSON.stringify(plan),
    },
  });
}

describe("MaterialPreparationService integration", () => {
  test("brief -> Content Secretary -> builtin providers -> AssetStore -> XHS-compatible MaterialPack", async () => {
    const harness = await createHarness("mat-05-e2e");
    const brief =
      "介绍 Agent Publisher：从内容准备、内建物料生成到人工审批，整个流程可见、可恢复、可接管。";

    harness.jobs.create({
      id: "job-mat-e2e",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief }),
    });

    const expectedPlan = planFixture("plan-mat-e2e", "optional");
    harness.faux.setResponses([
      fauxAssistantMessage(fauxText(JSON.stringify(expectedPlan))),
    ]);

    const source = createProviderPipelineMaterialSource({
      jobs: harness.jobs,
      contentSecretary: harness.secretary,
      preparation: harness.preparation,
    });

    const resolution = await source.resolve({
      jobId: "job-mat-e2e",
      brief,
    });

    expect(resolution).toMatchObject({
      source: "provider_pipeline",
      generatedFromBrief: true,
      pack: {
        mode: "image_text",
        status: "ready",
        planId: expectedPlan.id,
        design: null,
      },
    });
    expect(resolution.pack.images).toHaveLength(expectedPlan.imageCount);
    expect(harness.calls).toEqual({ text: 1, image: 1, design: 1 });

    const resolver: AssetPathResolver = (asset) =>
      harness.store.resolveLocalPath(asset);
    for (const asset of [
      resolution.pack.cover,
      ...resolution.pack.images,
    ]) {
      expect(asset.uri).toBe(`asset://${asset.assetId}`);
      expect(harness.assets.getById(asset.assetId)).not.toBeNull();
      const path = await resolver(asset);
      expect(existsSync(path)).toBe(true);
      await expect(harness.store.read(asset.assetId)).resolves.toSatisfy(
        (bytes: Buffer) => bytes.byteLength > 10_000,
      );
    }

    expect(
      fingerprintXiaohongshuImageTextMaterialPack(resolution.pack),
    ).toMatch(/^[a-f0-9]{64}$/);

    expect(
      harness.jobs.getStepsForJob("job-mat-e2e").map((step) => step.stepKey),
    ).toEqual([
      "material_plan",
      MATERIAL_COPY_STEP_KEY,
      MATERIAL_IMAGES_STEP_KEY,
      MATERIAL_DESIGN_STEP_KEY,
    ]);
  }, 30_000);

  test("restart before final material_pack commit reuses accepted plan/copy/images/design without regeneration", async () => {
    const harness = await createHarness("mat-05-restart");
    const brief = "重启恢复不应该重新生成已经接受的图文物料。";

    harness.jobs.create({
      id: "job-mat-restart",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief }),
    });

    const plan = {
      ...planFixture("plan-mat-restart", "optional"),
      brief: {
        ...planFixture("plan-mat-restart", "optional").brief,
        brief,
      },
    };
    harness.faux.setResponses([
      fauxAssistantMessage(fauxText(JSON.stringify(plan))),
    ]);

    const firstSource = createProviderPipelineMaterialSource({
      jobs: harness.jobs,
      contentSecretary: harness.secretary,
      preparation: harness.preparation,
    });
    const first = await firstSource.resolve({
      jobId: "job-mat-restart",
      brief,
    });
    expect(harness.calls).toEqual({ text: 1, image: 1, design: 1 });

    const restartedPreparation = new MaterialPreparationService({
      jobs: harness.jobs,
      providers: harness.providers,
      assetStore: harness.store,
    });
    const restartedSource = createProviderPipelineMaterialSource({
      jobs: harness.jobs,
      contentSecretary: harness.secretary,
      preparation: restartedPreparation,
    });
    const second = await restartedSource.resolve({
      jobId: "job-mat-restart",
      brief,
    });

    expect(second.pack).toEqual(first.pack);
    expect(harness.calls).toEqual({ text: 1, image: 1, design: 1 });

    const materialSteps = harness.jobs
      .getStepsForJob("job-mat-restart")
      .filter((step) => step.stepKey.startsWith("material_"));
    expect(
      materialSteps.map((step) => [step.stepKey, step.attempt, step.status]),
    ).toEqual([
      ["material_plan", 1, "succeeded"],
      [MATERIAL_COPY_STEP_KEY, 1, "succeeded"],
      [MATERIAL_IMAGES_STEP_KEY, 1, "succeeded"],
      [MATERIAL_DESIGN_STEP_KEY, 1, "succeeded"],
    ]);
  }, 30_000);

  test("required design failure retries only design and preserves accepted copy/images", async () => {
    const harness = await createHarness("mat-05-partial-retry");
    const plan = planFixture("plan-required-design", "required");

    harness.jobs.create({
      id: "job-required-design",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief: plan.brief.brief }),
    });
    seedPlanCheckpoint(harness.jobs, "job-required-design", plan);

    const builtinDesign = harness.providers.design!;
    let designAttempt = 0;
    const providers: MaterialProviderSlots = {
      text: harness.providers.text,
      image: harness.providers.image,
      design: {
        slot: "design",
        async render(input) {
          designAttempt += 1;
          harness.calls.design += 1;
          if (designAttempt === 1) {
            return {
              ok: false,
              error: {
                slot: "design",
                code: "MATERIAL_PROVIDER_UNAVAILABLE",
                message: "design temporarily unavailable",
                retryable: true,
              },
            };
          }
          return builtinDesign.render(input);
        },
      },
    };
    // The harness design wrapper is not used in this test; reset its counter.
    harness.calls.design = 0;
    const service = new MaterialPreparationService({
      jobs: harness.jobs,
      providers,
      assetStore: harness.store,
    });

    await expect(
      service.prepareImageText("job-required-design", plan),
    ).rejects.toBeInstanceOf(MaterialPreparationProviderError);

    expect(harness.calls.text).toBe(1);
    expect(harness.calls.image).toBe(1);
    expect(harness.calls.design).toBe(1);

    const result = await service.prepareImageText(
      "job-required-design",
      plan,
    );

    expect(result.pack.status).toBe("ready");
    expect(result.reusedSteps).toEqual([
      MATERIAL_COPY_STEP_KEY,
      MATERIAL_IMAGES_STEP_KEY,
    ]);
    expect(harness.calls.text).toBe(1);
    expect(harness.calls.image).toBe(1);
    expect(harness.calls.design).toBe(3);

    const designSteps = harness.jobs
      .getStepsForJob("job-required-design")
      .filter((step) => step.stepKey === MATERIAL_DESIGN_STEP_KEY);
    expect(
      designSteps.map((step) => [step.attempt, step.status]),
    ).toEqual([
      [1, "failed"],
      [2, "succeeded"],
    ]);
  }, 30_000);

  test("optional missing design provider degrades visibly without changing image_text mode", async () => {
    const harness = await createHarness("mat-05-degradation");
    const plan = planFixture("plan-optional-design", "optional");

    harness.jobs.create({
      id: "job-optional-design",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief: plan.brief.brief }),
    });
    seedPlanCheckpoint(harness.jobs, "job-optional-design", plan);

    const service = new MaterialPreparationService({
      jobs: harness.jobs,
      providers: {
        text: harness.providers.text,
        image: harness.providers.image,
      },
      assetStore: harness.store,
    });

    const result = await service.prepareImageText(
      "job-optional-design",
      plan,
    );

    expect(result.pack.mode).toBe("image_text");
    expect(result.pack.status).toBe("ready_with_degradation");
    expect(result.pack.design).toBeNull();
    expect(result.pack.warnings).toEqual([
      expect.objectContaining({
        code: "DESIGN_PROVIDER_UNAVAILABLE",
        userVisible: true,
      }),
    ]);
    expect(result.pack.degradations).toEqual([
      expect.objectContaining({
        code: "DESIGN_PROVIDER_UNAVAILABLE",
        originalMode: "image_text",
        resultingMode: "image_text",
      }),
    ]);
  }, 30_000);
});
