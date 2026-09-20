import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { expect, test } from "vitest";

import {
  CONTENT_SECRETARY_ALLOWED_TOOLS,
  CONTENT_SECRETARY_ROLE,
  ContentSecretaryService,
  contentSecretaryDefinition,
  createContentSecretaryResourceLoader,
} from "../src/agent/content-secretary.js";
import { JobAgentSessionService } from "../src/agent/job-session-service.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
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

async function createHarness(
  providerName: string,
  options: {
    readonly runTimeoutMs?: number;
    readonly abortTimeoutMs?: number;
  } = {},
) {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-content-secretary-"));
  const db = openDatabase({ databasePath: join(root, "app.db") });
  const jobs = new JobRepository(db);
  const bindings = new AgentSessionBindingRepository(db);
  const faux = fauxProvider({ provider: providerName });
  const modelRuntime = await createFauxRuntime(faux);
  const host = new PiAgentHost({
    model: faux.getModel(),
    modelRuntime,
    cwd: root,
    sessionDirectory: join(root, "pi-sessions"),
    defaultRunTimeoutMs: options.runTimeoutMs ?? 2_000,
    defaultAbortTimeoutMs: options.abortTimeoutMs ?? 200,
    tools: CONTENT_SECRETARY_ALLOWED_TOOLS,
    sessionOptions: { thinkingLevel: "off" },
    createResourceLoader: createContentSecretaryResourceLoader,
  });
  const sessions = new JobAgentSessionService({ jobs, bindings, host });
  const secretary = new ContentSecretaryService({
    jobs,
    bindings,
    sessions,
  });

  return { root, db, jobs, bindings, faux, secretary };
}

function disposeHarness(
  harness: Awaited<ReturnType<typeof createHarness>>,
): void {
  harness.db.close();
  rmSync(harness.root, { recursive: true, force: true });
}

function imageTextPlan(id: string, brief: string) {
  return {
    id,
    mode: "image_text",
    brief: {
      id: `${id}-brief`,
      brief,
      platform: "xiaohongshu",
      mode: "image_text",
    },
    imageCount: 6,
    coverRequired: true,
    design: "optional",
  } as const;
}

function videoPlan(id: string, brief: string) {
  return {
    id,
    mode: "video",
    brief: {
      id: `${id}-brief`,
      brief,
      platform: "xiaohongshu",
      mode: "video",
    },
    coverRequired: true,
    supportingImageCount: 2,
    onVideoUnavailable: "allow_without_video",
  } as const;
}

test("Content Secretary runs through Job-scoped Pi session and commits a MaterialPlan checkpoint", async () => {
  const harness = await createHarness("publisher-content-secretary-happy");

  try {
    harness.jobs.create({
      id: "job-content-plan",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({
        topic: "Agent Publisher launch",
        audience: "product builders",
      }),
    });

    const expectedPlan = imageTextPlan(
      "plan-content-a",
      "Launch notes for product builders",
    );
    let observedSystemPrompt = "";
    let observedTools: string[] = [];

    harness.faux.setResponses([
      (context) => {
        observedSystemPrompt = context.systemPrompt ?? "";
        observedTools = (context.tools ?? []).map((tool) => tool.name);
        return fauxAssistantMessage(
          fauxText(JSON.stringify(expectedPlan)),
        );
      },
    ]);

    const result = await harness.secretary.createMaterialPlan(
      "job-content-plan",
    );

    expect(result.plan).toEqual(expectedPlan);
    expect(result.job).toMatchObject({
      id: "job-content-plan",
      status: "preparing_materials",
      currentStep: "material_plan",
      checkpoint: {
        phase: "material_plan_ready",
        materialPlanId: "plan-content-a",
      },
    });

    const steps = harness.jobs.getStepsForJob("job-content-plan");
    expect(steps).toHaveLength(1);
    expect(steps[0]).toMatchObject({
      stepKey: "material_plan",
      status: "succeeded",
      attempt: 1,
      outputJson: JSON.stringify(expectedPlan),
    });

    expect(observedSystemPrompt).toContain('"jobId":"job-content-plan"');
    expect(observedSystemPrompt).toContain('"publishMode":"image_text"');
    expect(observedSystemPrompt).toContain("Agent Publisher launch");
    expect(observedSystemPrompt).toContain("<name>publisher-safety</name>");
    expect(observedSystemPrompt).toContain(
      "External irreversible publication",
    );
    expect(observedTools).toEqual([]);

    expect(
      harness.bindings.getForScope({
        jobId: "job-content-plan",
        role: CONTENT_SECRETARY_ROLE,
      }),
    ).toMatchObject({
      definitionId: contentSecretaryDefinition.id,
    });
  } finally {
    disposeHarness(harness);
  }
});

test("invalid JSON and wrong-mode MaterialPlans are rejected without Job mutation", async () => {
  const harness = await createHarness("publisher-content-secretary-invalid");

  try {
    harness.jobs.create({
      id: "job-invalid-json",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "invalid output" }),
    });
    harness.jobs.create({
      id: "job-wrong-mode",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "wrong mode" }),
    });

    const invalidBefore = harness.jobs.getById("job-invalid-json");
    const wrongModeBefore = harness.jobs.getById("job-wrong-mode");

    harness.faux.setResponses([
      fauxAssistantMessage(fauxText("not-json")),
      fauxAssistantMessage(
        fauxText(
          JSON.stringify(
            videoPlan("plan-wrong-mode", "Must not switch the selected mode"),
          ),
        ),
      ),
    ]);

    await expect(
      harness.secretary.createMaterialPlan("job-invalid-json"),
    ).rejects.toMatchObject({
      name: "MaterialPlanValidationError",
      code: "MATERIAL_PLAN_INVALID_JSON",
    });
    await expect(
      harness.secretary.createMaterialPlan("job-wrong-mode"),
    ).rejects.toMatchObject({
      name: "MaterialPlanValidationError",
      code: "MATERIAL_PLAN_MODE_MISMATCH",
    });

    expect(harness.jobs.getById("job-invalid-json")).toEqual(invalidBefore);
    expect(harness.jobs.getById("job-wrong-mode")).toEqual(wrongModeBefore);
    expect(harness.jobs.getStepsForJob("job-invalid-json")).toEqual([]);
    expect(harness.jobs.getStepsForJob("job-wrong-mode")).toEqual([]);
  } finally {
    disposeHarness(harness);
  }
});

test("Agent failure remains visible and preserves an already committed Job checkpoint", async () => {
  const harness = await createHarness("publisher-content-secretary-failure", {
    runTimeoutMs: 30,
    abortTimeoutMs: 30,
  });

  try {
    harness.jobs.create({
      id: "job-agent-failure",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "failure injection" }),
    });
    harness.jobs.commitCheckpoint("job-agent-failure", {
      status: "preparing_materials",
      checkpoint: {
        phase: "preexisting_material_state",
        materialPlanId: "prior-plan",
      },
      step: {
        id: "job-agent-failure:preexisting:1",
        stepKey: "preexisting_material_step",
        status: "succeeded",
        outputJson: JSON.stringify({ preserved: true }),
      },
    });

    const before = harness.jobs.getById("job-agent-failure");
    const beforeSteps = harness.jobs.getStepsForJob("job-agent-failure");

    harness.faux.setResponses([
      async () => await new Promise<never>(() => undefined),
    ]);

    await expect(
      harness.secretary.createMaterialPlan("job-agent-failure"),
    ).rejects.toMatchObject({
      name: "AgentSessionError",
      code: "AGENT_SESSION_ABORT_UNCONFIRMED",
    });

    expect(harness.jobs.getById("job-agent-failure")).toEqual(before);
    expect(harness.jobs.getStepsForJob("job-agent-failure")).toEqual(
      beforeSteps,
    );
  } finally {
    disposeHarness(harness);
  }
});

test("two Publish Jobs receive isolated Content Secretary sessions and contexts", async () => {
  const harness = await createHarness("publisher-content-secretary-isolation");

  try {
    harness.jobs.create({
      id: "job-isolated-alpha",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "ALPHA_ONLY_CONTEXT" }),
    });
    harness.jobs.create({
      id: "job-isolated-beta",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "BETA_ONLY_CONTEXT" }),
    });

    const prompts: string[] = [];
    harness.faux.setResponses([
      (context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage(
          fauxText(
            JSON.stringify(
              imageTextPlan("plan-alpha", "Plan for alpha"),
            ),
          ),
        );
      },
      (context) => {
        prompts.push(context.systemPrompt ?? "");
        return fauxAssistantMessage(
          fauxText(
            JSON.stringify(
              imageTextPlan("plan-beta", "Plan for beta"),
            ),
          ),
        );
      },
    ]);

    await harness.secretary.createMaterialPlan("job-isolated-alpha");
    await harness.secretary.createMaterialPlan("job-isolated-beta");

    expect(prompts).toHaveLength(2);
    expect(prompts[0]).toContain("ALPHA_ONLY_CONTEXT");
    expect(prompts[0]).not.toContain("BETA_ONLY_CONTEXT");
    expect(prompts[1]).toContain("BETA_ONLY_CONTEXT");
    expect(prompts[1]).not.toContain("ALPHA_ONLY_CONTEXT");

    const alphaBinding = harness.bindings.getForScope({
      jobId: "job-isolated-alpha",
      role: CONTENT_SECRETARY_ROLE,
    });
    const betaBinding = harness.bindings.getForScope({
      jobId: "job-isolated-beta",
      role: CONTENT_SECRETARY_ROLE,
    });

    expect(alphaBinding).not.toBeNull();
    expect(betaBinding).not.toBeNull();
    expect(alphaBinding?.sessionRef).not.toBe(betaBinding?.sessionRef);
  } finally {
    disposeHarness(harness);
  }
});
