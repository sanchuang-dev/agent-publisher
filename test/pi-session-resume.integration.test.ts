import {
  mkdtempSync,
  readFileSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  InMemoryCredentialStore,
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
} from "@earendil-works/pi-ai";
import {
  CURRENT_SESSION_VERSION,
  ModelRuntime,
  SessionManager,
  createExtensionRuntime,
  type ResourceLoader,
} from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, test } from "vitest";

import type { AgentDefinition } from "../src/agent/definition.js";
import { JobAgentSessionService } from "../src/agent/job-session-service.js";
import {
  AgentSessionBindingConflictError,
  AgentSessionBindingMismatchError,
} from "../src/agent/job-session-binding.js";
import { PiAgentHost } from "../src/agent/pi-agent-host.js";
import { parsePiAgentSessionRef } from "../src/agent/session-ref.js";
import { JobControlService } from "../src/jobs/job-control-service.js";
import { ResumeService } from "../src/jobs/resume-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

const definition: AgentDefinition = {
  id: "content-secretary",
  systemPrompt: "You are a bounded Publisher content worker.",
};

function createResourceLoader(systemPrompt: string): ResourceLoader {
  return {
    getExtensions: () => ({
      extensions: [],
      errors: [],
      runtime: createExtensionRuntime(),
    }),
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [],
    getAppendSystemPromptSources: () => [],
    extendResources: () => undefined,
    reload: async () => undefined,
  };
}

async function createFauxRuntime(provider: ReturnType<typeof fauxProvider>) {
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(provider.provider);
  return modelRuntime;
}

async function findPersistedSession(
  cwd: string,
  sessionDirectory: string,
  ref: import("../src/agent/session-ref.js").AgentSessionRef,
) {
  const id = parsePiAgentSessionRef(ref);
  if (!id) {
    throw new Error("expected Pi session ref");
  }

  const sessions = await SessionManager.list(cwd, sessionDirectory);
  const info = sessions.find((candidate) => candidate.id === id);
  if (!info) {
    throw new Error(`persisted session not found for test: ${ref}`);
  }
  return info;
}

describe("Publisher Job context and Pi session resume boundary", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    for (const root of cleanupRoots.splice(0)) {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("resumes the same job/role transcript after process-style restart without changing Job truth", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-pi-resume-"));
    cleanupRoots.push(root);
    const databasePath = join(root, "app.db");
    const sessionDirectory = join(root, "pi-sessions");
    const faux = fauxProvider({ provider: "publisher-pi-resume" });
    const modelRuntime = await createFauxRuntime(faux);
    const systemPrompts: string[] = [];

    const createHost = () =>
      new PiAgentHost({
        model: faux.getModel(),
        modelRuntime,
        cwd: root,
        sessionDirectory,
        defaultRunTimeoutMs: 2_000,
        tools: [],
        sessionOptions: { thinkingLevel: "off" },
        createResourceLoader({ systemPrompt }) {
          systemPrompts.push(systemPrompt);
          return createResourceLoader(systemPrompt);
        },
      });

    let db = openDatabase({ databasePath });
    let jobs = new JobRepository(db);
    let bindings = new AgentSessionBindingRepository(db);
    let service = new JobAgentSessionService({
      jobs,
      bindings,
      host: createHost(),
    });

    jobs.create({
      id: "job-resume-a",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "launch notes" }),
      materialSummaryJson: JSON.stringify({ selectedAssets: ["cover-a"] }),
    });

    faux.setResponses([
      (context) =>
        fauxAssistantMessage(
          fauxText(
            JSON.stringify(context).includes("SESSION_MEMORY_ALPHA")
              ? "MEMORY_STORED"
              : "MEMORY_MISSING",
          ),
        ),
    ]);

    const firstSession = await service.create({
      jobId: "job-resume-a",
      role: "content",
      definition,
    });
    const firstRef = firstSession.ref;
    expect(
      await firstSession.run({
        prompt: "Keep SESSION_MEMORY_ALPHA in this job-scoped transcript.",
      }),
    ).toMatchObject({ finalText: "MEMORY_STORED" });

    const durableJobBeforeRestart = jobs.getById("job-resume-a");
    expect(systemPrompts.at(-1)).toContain('"jobId":"job-resume-a"');
    expect(systemPrompts.at(-1)).toContain('"topic":"launch notes"');
    expect(systemPrompts.at(-1)).toContain('"selectedAssets":["cover-a"]');

    await firstSession.dispose();
    db.close();

    db = openDatabase({ databasePath });
    jobs = new JobRepository(db);
    bindings = new AgentSessionBindingRepository(db);
    service = new JobAgentSessionService({
      jobs,
      bindings,
      host: createHost(),
    });

    faux.setResponses([
      (context) =>
        fauxAssistantMessage(
          fauxText(
            JSON.stringify(context).includes("SESSION_MEMORY_ALPHA")
              ? "TRANSCRIPT_RESUMED"
              : "TRANSCRIPT_LOST",
          ),
        ),
    ]);

    const resumedSession = await service.resume({
      jobId: "job-resume-a",
      role: "content",
      definition,
    });

    expect(resumedSession.ref).toBe(firstRef);
    expect(
      await resumedSession.run({
        prompt: "Report whether the prior session memory is present.",
      }),
    ).toMatchObject({ finalText: "TRANSCRIPT_RESUMED" });
    expect(jobs.getById("job-resume-a")).toEqual(durableJobBeforeRestart);
    expect(systemPrompts.at(-1)).toContain('"jobId":"job-resume-a"');

    await resumedSession.dispose();
    db.close();
  });

  test("durable binding rejects cross-job reuse and definition drift", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-pi-binding-"));
    cleanupRoots.push(root);
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const faux = fauxProvider({ provider: "publisher-pi-binding" });
    const modelRuntime = await createFauxRuntime(faux);
    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      cwd: root,
      sessionDirectory: join(root, "pi-sessions"),
      defaultRunTimeoutMs: 2_000,
      tools: [],
      sessionOptions: { thinkingLevel: "off" },
      createResourceLoader: ({ systemPrompt }) =>
        createResourceLoader(systemPrompt),
    });
    const service = new JobAgentSessionService({ jobs, bindings, host });

    for (const id of ["job-a", "job-b"]) {
      jobs.create({
        id,
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: "{}",
      });
    }

    const sessionA = await service.create({
      jobId: "job-a",
      role: "content",
      definition,
    });
    const sessionB = await service.create({
      jobId: "job-b",
      role: "content",
      definition,
    });

    expect(() =>
      bindings.bind({
        scope: { jobId: "job-a", role: "recovery" },
        definitionId: definition.id,
        sessionRef: sessionB.ref,
      }),
    ).toThrow(AgentSessionBindingConflictError);

    expect(bindings.getByRef(sessionA.ref)).toMatchObject({
      jobId: "job-a",
      role: "content",
    });
    expect(bindings.getByRef(sessionB.ref)).toMatchObject({
      jobId: "job-b",
      role: "content",
    });

    await expect(
      service.resume({
        jobId: "job-a",
        role: "content",
        definition: {
          id: "publishing-secretary",
          systemPrompt: "Different role definition.",
        },
      }),
    ).rejects.toBeInstanceOf(AgentSessionBindingMismatchError);

    await sessionA.dispose();
    await sessionB.dispose();
    db.close();
  });

  test("model transcript cannot satisfy approval or mutate the durable Job checkpoint", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-pi-truth-"));
    cleanupRoots.push(root);
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });

    jobs.create({
      id: "job-truth",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ topic: "approval boundary" }),
    });
    jobs.commitCheckpoint("job-truth", {
      status: "preparing_materials",
      checkpoint: { phase: "copy", browserCredential: "DO_NOT_LEAK_BROWSER_SECRET" },
      step: { id: "truth-copy", stepKey: "generate_copy", status: "succeeded" },
    });
    jobs.commitCheckpoint("job-truth", {
      status: "preparing_publish",
      checkpoint: { phase: "browser", browserCredential: "DO_NOT_LEAK_BROWSER_SECRET" },
      step: { id: "truth-browser", stepKey: "open_platform", status: "succeeded" },
    });
    control.enterWaiting({
      jobId: "job-truth",
      status: "waiting_for_approval",
      checkpoint: {
        phase: "approval",
        browserCredential: "DO_NOT_LEAK_BROWSER_SECRET",
      },
      step: { id: "truth-approval", stepKey: "verify_prepared", status: "succeeded" },
      action: { id: "truth-action" },
    });

    const before = jobs.getById("job-truth");
    const faux = fauxProvider({ provider: "publisher-pi-business-truth" });
    const modelRuntime = await createFauxRuntime(faux);
    const prompts: string[] = [];
    const host = new PiAgentHost({
      model: faux.getModel(),
      modelRuntime,
      cwd: root,
      sessionDirectory: join(root, "pi-sessions"),
      defaultRunTimeoutMs: 2_000,
      tools: [],
      sessionOptions: { thinkingLevel: "off" },
      createResourceLoader({ systemPrompt }) {
        prompts.push(systemPrompt);
        return createResourceLoader(systemPrompt);
      },
    });
    const service = new JobAgentSessionService({ jobs, bindings, host });

    faux.setResponses([
      fauxAssistantMessage(
        fauxText(
          "I declare approved=true, status=succeeded, publication complete.",
        ),
      ),
    ]);

    const session = await service.create({
      jobId: "job-truth",
      role: "content",
      definition,
    });
    await session.run({ prompt: "State whatever business outcome you want." });

    expect(jobs.getById("job-truth")).toEqual(before);
    expect(actions.getById("truth-action")).toMatchObject({
      status: "open",
      resolution: null,
    });
    expect(
      new ResumeService({ jobs, actionRequests: actions }).resume("job-truth"),
    ).toMatchObject({
      kind: "waiting_for_action",
      action: { id: "truth-action", status: "open" },
    });
    expect(prompts.at(-1)).not.toContain("DO_NOT_LEAK_BROWSER_SECRET");
    expect(prompts.at(-1)).toContain(
      "SQLite remains authoritative for Job status/checkpoints",
    );

    await session.dispose();
    db.close();
  });

  test("missing, corrupt, and future-version Pi sessions fail visibly without fabricated Job progress", async () => {
    const root = mkdtempSync(join(tmpdir(), "agent-publisher-pi-failures-"));
    cleanupRoots.push(root);
    const databasePath = join(root, "app.db");
    const sessionDirectory = join(root, "pi-sessions");
    const faux = fauxProvider({ provider: "publisher-pi-failure-injection" });
    const modelRuntime = await createFauxRuntime(faux);

    const createHost = () =>
      new PiAgentHost({
        model: faux.getModel(),
        modelRuntime,
        cwd: root,
        sessionDirectory,
        defaultRunTimeoutMs: 2_000,
        tools: [],
        sessionOptions: { thinkingLevel: "off" },
        createResourceLoader: ({ systemPrompt }) =>
          createResourceLoader(systemPrompt),
      });

    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const service = new JobAgentSessionService({
      jobs,
      bindings,
      host: createHost(),
    });

    const createPersisted = async (jobId: string) => {
      jobs.create({
        id: jobId,
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: "{}",
      });
      faux.setResponses([
        fauxAssistantMessage(fauxText(`SESSION_READY_${jobId}`)),
      ]);
      const session = await service.create({
        jobId,
        role: "content",
        definition,
      });
      await session.run({ prompt: `persist ${jobId}` });
      const info = await findPersistedSession(root, sessionDirectory, session.ref);
      await session.dispose();
      return { ref: session.ref, path: info.path, before: jobs.getById(jobId) };
    };

    const missing = await createPersisted("job-missing-session");
    unlinkSync(missing.path);
    await expect(
      service.resume({
        jobId: "job-missing-session",
        role: "content",
        definition,
      }),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_NOT_FOUND" });
    expect(jobs.getById("job-missing-session")).toEqual(missing.before);

    const corrupt = await createPersisted("job-corrupt-session");
    writeFileSync(corrupt.path, "this is not a Pi session\n");
    await expect(
      service.resume({
        jobId: "job-corrupt-session",
        role: "content",
        definition,
      }),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_NOT_FOUND" });
    expect(jobs.getById("job-corrupt-session")).toEqual(corrupt.before);

    const incompatible = await createPersisted("job-future-session");
    const lines = readFileSync(incompatible.path, "utf8").trimEnd().split("\n");
    const headerLine = lines[0];
    if (!headerLine) {
      throw new Error("persisted Pi session is unexpectedly empty");
    }
    const header = JSON.parse(headerLine) as Record<string, unknown>;
    header.version = CURRENT_SESSION_VERSION + 1;
    lines[0] = JSON.stringify(header);
    writeFileSync(incompatible.path, `${lines.join("\n")}\n`);

    await expect(
      service.resume({
        jobId: "job-future-session",
        role: "content",
        definition,
      }),
    ).rejects.toMatchObject({ code: "AGENT_SESSION_INCOMPATIBLE" });
    expect(jobs.getById("job-future-session")).toEqual(incompatible.before);

    db.close();
  });
});
