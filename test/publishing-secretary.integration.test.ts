import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, test, vi } from "vitest";
import type { Page } from "playwright";

import { createMvpPrepublishApplication } from "../src/app/mvp-prepublish-application.js";
import { createControlledMaterialSource } from "../src/app/prepublish-material-source.js";
import type {
  AgentDefinition,
  AgentSessionScope,
  AgentTaskInput,
  AgentTaskResult,
  CreatePublisherAgentSessionInput,
  ResumePublisherAgentSessionInput,
} from "../src/agent/definition.js";
import {
  AgentSessionError,
  type AgentHost,
  type PublisherAgentSession,
} from "../src/agent/host.js";
import {
  PublishingSecretaryService,
  authorizeXiaohongshuPrepublishClick,
  createXiaohongshuPublishingBrowserResourceLoader,
} from "../src/agent/publishing-secretary.js";
import type { PublishingSecretaryPort } from "../src/agent/publishing-secretary-contract.js";
import type { AgentSessionRef } from "../src/agent/session-ref.js";
import type {
  BrowserAutomationAttachmentProvider,
  BrowserProviderHealth,
  BrowserSession,
} from "../src/browser/provider.js";
import { createImageTextMaterialPackFixture } from "../src/materials/testing/fake-providers.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
import {
  PUBLISHING_BROWSER_MCP_SERVER,
  PUBLISHING_BROWSER_MCP_TOOLS,
  createPublishingBrowserMcpProfile,
  issuePublishingBrowserCapabilityGrant,
} from "../src/agent/publishing-browser-mcp.js";
import { createXiaohongshuPublishingDefinition } from "../src/agent/xiaohongshu-publishing-skill.js";

function makePage(url = "https://creator.xiaohongshu.com/publish"): Page {
  let page: Page;
  const context = { pages: () => [page] };
  page = {
    url: () => url,
    isClosed: () => false,
    context: () => context,
  } as unknown as Page;
  return page;
}

class FakeAutomationBrowserProvider
  implements BrowserAutomationAttachmentProvider
{
  readonly session: BrowserSession = {
    id: "publishing-secretary-browser",
    profileRef: "xhs-profile",
    page: makePage(),
  };

  acquireCalls = 0;
  releaseCalls = 0;

  async acquire(): Promise<BrowserSession> {
    this.acquireCalls += 1;
    return this.session;
  }

  async release(sessionId: string): Promise<void> {
    expect(sessionId).toBe(this.session.id);
    this.releaseCalls += 1;
  }

  async health(): Promise<BrowserProviderHealth> {
    return { status: "reachable" };
  }

  async resolveAutomationAttachment(sessionId: string) {
    expect(sessionId).toBe(this.session.id);
    return {
      sessionId,
      cdpEndpoint:
        "ws://browser-runtime:9222/devtools/browser/publishing-secretary",
    };
  }
}

class ScriptedSession implements PublisherAgentSession {
  readonly ref: AgentSessionRef;
  readonly definition: AgentDefinition;
  readonly scope: AgentSessionScope;
  readonly prompts: string[] = [];
  disposed = false;

  constructor(
    ref: string,
    definition: AgentDefinition,
    scope: AgentSessionScope,
    private readonly nextResult: () => AgentTaskResult,
  ) {
    this.ref = ref as AgentSessionRef;
    this.definition = definition;
    this.scope = scope;
  }

  async run(input: AgentTaskInput): Promise<AgentTaskResult> {
    this.prompts.push(input.prompt);
    return this.nextResult();
  }

  async dispose(): Promise<void> {
    this.disposed = true;
  }
}

class ScriptedHost implements AgentHost {
  readonly supportsDurableResume = true;
  readonly created: ScriptedSession[] = [];
  readonly resumed: ScriptedSession[] = [];
  readonly results: AgentTaskResult[] = [];

  queue(result: AgentTaskResult): void {
    this.results.push(result);
  }

  async createSession(
    input: CreatePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession> {
    const session = new ScriptedSession(
      "pi:created-" + (this.created.length + 1),
      input.definition,
      input.scope,
      () => {
        const result = this.results.shift();
        if (!result) throw new Error("missing scripted result");
        return result;
      },
    );
    this.created.push(session);
    return session;
  }

  async resumeSession(
    input: ResumePublisherAgentSessionInput,
  ): Promise<PublisherAgentSession> {
    const session = new ScriptedSession(
      input.ref,
      input.definition,
      input.scope,
      () => {
        const result = this.results.shift();
        if (!result) throw new Error("missing scripted result");
        return result;
      },
    );
    this.resumed.push(session);
    return session;
  }
}

function agentResult(
  payload: Record<string, unknown>,
  toolNames: readonly string[] = ["mcp", "mcp", "mcp"],
): AgentTaskResult {
  return {
    finalText:
      "PUBLISHING_SECRETARY_RESULT=" + JSON.stringify(payload),
    eventTypes: [],
    toolExecutions: toolNames.map((toolName, index) => ({
      toolCallId: "tool-" + index,
      toolName,
      args:
        toolName === "mcp"
          ? {
              server: PUBLISHING_BROWSER_MCP_SERVER,
              tool:
                index === 0
                  ? "browser_snapshot"
                  : index === 1
                    ? "browser_click"
                    : "browser_snapshot",
            }
          : {},
      completed: true,
      isError: false,
    })),
  };
}

describe("AGT-07 Publishing Secretary browser execution", () => {
  const roots: string[] = [];

  afterEach(() => {
    while (roots.length > 0) {
      rmSync(roots.pop()!, { recursive: true, force: true });
    }
  });

  test("combines #105 browser guard with #106 Skill and preserves the bounded tool surface", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-agt07-loader-"));
    roots.push(root);
    const browser = new FakeAutomationBrowserProvider();
    const grant = await issuePublishingBrowserCapabilityGrant({
      jobId: "job-loader",
      browserProvider: browser,
      browserSession: browser.session,
      allowedOrigins: ["https://creator.xiaohongshu.com"],
      uploadRoot: root,
      authorizeClick: authorizeXiaohongshuPrepublishClick,
    });
    const definition = createXiaohongshuPublishingDefinition(
      createPublishingBrowserMcpProfile(grant),
    );

    const loader = await createXiaohongshuPublishingBrowserResourceLoader(
      {
        definition,
        scope: { jobId: "job-loader", role: "publishing" },
        systemPrompt: definition.systemPrompt,
        cwd: root,
        allowedTools: ["read", "mcp"],
        extensionFactories: [],
      },
      grant,
    );

    expect(
      loader.getSkills().skills.map((skill) => skill.name).sort(),
    ).toEqual(["publisher-safety", "xiaohongshu-publishing"]);
    expect(definition.mcp?.servers[0]?.includeTools).toEqual(
      PUBLISHING_BROWSER_MCP_TOOLS,
    );
    expect(definition.mcp?.servers[0]?.includeTools).not.toContain(
      "final_publish",
    );
  });

  test("creates one job-scoped session, returns a bounded prepared candidate, and resumes it on the next run", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-agt07-session-"));
    roots.push(root);
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const pack = createImageTextMaterialPackFixture();
    const browser = new FakeAutomationBrowserProvider();
    jobs.create({
      id: "job-a",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief: "测试图文" }),
    });
    for (const asset of [pack.cover, ...pack.images]) {
      writeFileSync(join(root, asset.assetId + ".png"), "asset");
    }

    const host = new ScriptedHost();
    host.queue(
      agentResult({
        kind: "prepared_candidate",
        summary: "composer appears prepared",
        semanticMilestone: "image_text_composer_ready",
      }),
    );
    host.queue(
      agentResult({
        kind: "progress",
        summary: "re-observed the existing candidate",
        semanticMilestone: "candidate_reobserved",
      }),
    );

    const service = new PublishingSecretaryService({
      jobs,
      bindings,
      createHost: () => host,
      uploadRoot: root,
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
    });

    const first = await service.execute({
      jobId: "job-a",
      browserProvider: browser,
      browserSession: browser.session,
      materialPack: pack,
    });
    expect(first).toEqual({
      kind: "prepared_candidate",
      summary: "composer appears prepared",
      semanticMilestone: "image_text_composer_ready",
      identitySurface: null,
      browserToolCalls: 3,
    });
    expect(host.created).toHaveLength(1);
    expect(host.resumed).toHaveLength(0);
    expect(host.created[0]!.scope).toEqual({
      jobId: "job-a",
      role: "publishing",
    });
    expect(host.created[0]!.prompts[0]).toContain(pack.copy.title);
    expect(host.created[0]!.prompts[0]).toContain(
      "Observe the page, choose the next bounded safe action",
    );
    expect(host.created[0]!.prompts[0]).toContain(
      "https://creator.xiaohongshu.com",
    );
    expect(host.created[0]!.prompts[0]).toContain(
      "choose a browser_navigate action",
    );
    expect(host.created[0]!.prompts[0]).toContain(
      "A login page or login button is not itself a human-action boundary",
    );
    expect(host.created[0]!.prompts[0]).toContain("identitySurface=qr_ready");
    expect(host.created[0]!.definition.mcp?.servers[0]?.includeTools).toEqual(
      PUBLISHING_BROWSER_MCP_TOOLS,
    );

    const second = await service.execute({
      jobId: "job-a",
      browserProvider: browser,
      browserSession: browser.session,
      materialPack: pack,
    });
    expect(second.kind).toBe("progress");
    expect(host.created).toHaveLength(1);
    expect(host.resumed).toHaveLength(1);
    expect(host.resumed[0]!.ref).toBe(host.created[0]!.ref);

    db.close();
  });

  test("rejects needs_identity before a bounded human-action surface is named", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-xhs05-invalid-identity-"));
    roots.push(root);
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const pack = createImageTextMaterialPackFixture();
    const browser = new FakeAutomationBrowserProvider();
    jobs.create({
      id: "job-invalid-identity",
      platform: "xiaohongshu",
      publishMode: "image_text",
      briefJson: JSON.stringify({ brief: "身份边界" }),
    });
    for (const asset of [pack.cover, ...pack.images]) {
      writeFileSync(join(root, asset.assetId + ".png"), "asset");
    }

    const host = new ScriptedHost();
    host.queue(
      agentResult({
        kind: "needs_identity",
        summary: "login page exists",
        semanticMilestone: "login_page_seen",
      }),
    );
    const service = new PublishingSecretaryService({
      jobs,
      bindings,
      createHost: () => host,
      uploadRoot: root,
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
    });

    try {
      await expect(
        service.execute({
          jobId: "job-invalid-identity",
          browserProvider: browser,
          browserSession: browser.session,
          materialPack: pack,
        }),
      ).rejects.toThrow(
        "needs_identity result must name a safe identitySurface",
      );
    } finally {
      db.close();
    }
  });

  test("keeps another Job isolated and returns identity handoff without a publish capability", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-agt07-isolation-"));
    roots.push(root);
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const pack = createImageTextMaterialPackFixture();
    const browser = new FakeAutomationBrowserProvider();
    for (const jobId of ["job-a", "job-b"]) {
      jobs.create({
        id: jobId,
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: JSON.stringify({ brief: jobId }),
      });
    }
    for (const asset of [pack.cover, ...pack.images]) {
      writeFileSync(join(root, asset.assetId + ".png"), "asset");
    }

    const host = new ScriptedHost();
    host.queue(
      agentResult(
        {
          kind: "needs_identity",
          summary: "do not persist QR payload: secret-example",
          semanticMilestone: "untrusted identity detail",
          identitySurface: "qr_ready",
          qrPayload: "secret-example",
        },
        ["mcp"],
      ),
    );
    host.queue(
      agentResult({
        kind: "progress",
        summary: "job b has its own browser context",
        semanticMilestone: "creator_observed",
      }),
    );

    const service = new PublishingSecretaryService({
      jobs,
      bindings,
      createHost: () => host,
      uploadRoot: root,
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
    });

    const identity = await service.execute({
      jobId: "job-a",
      browserProvider: browser,
      browserSession: browser.session,
      materialPack: pack,
    });
    expect(identity).toMatchObject({
      kind: "needs_identity",
      summary: "QR login is ready for authorized human action.",
      semanticMilestone: "qr_ready",
      identitySurface: "qr_ready",
      browserToolCalls: 1,
    });
    expect(JSON.stringify(identity)).not.toContain("secret-example");

    await service.execute({
      jobId: "job-b",
      browserProvider: browser,
      browserSession: browser.session,
      materialPack: pack,
    });
    expect(host.created).toHaveLength(2);
    expect(host.created[0]!.scope.jobId).toBe("job-a");
    expect(host.created[1]!.scope.jobId).toBe("job-b");
    expect(host.created[0]!.definition.mcp?.servers[0]?.includeTools).not.toContain(
      "final_publish",
    );

    db.close();
  });

  test("Publisher click policy allows ordinary route choice but blocks observed final publish/delete controls", () => {
    expect(
      authorizeXiaohongshuPrepublishClick({
        jobId: "job",
        browserSessionId: "browser",
        pageUrl: "https://creator.xiaohongshu.com/publish",
        targetRef: "g1:e1",
        observedTarget: '- button "上传图文" [ref=g1:e1]',
      }),
    ).toEqual({ allowed: true });

    for (const observedTarget of [
      '- button "发布" [ref=g1:e2]',
      '- button "立即发布" [ref=g1:e3]',
      '- button "Publish" [ref=g1:e4]',
      '- button "提交" [ref=g1:e5]',
      '- button "删除" [ref=g1:e6]',
    ]) {
      expect(
        authorizeXiaohongshuPrepublishClick({
          jobId: "job",
          browserSessionId: "browser",
          pageUrl: "https://creator.xiaohongshu.com/publish",
          targetRef: "g1:e9",
          observedTarget,
        }).allowed,
      ).toBe(false);
    }
  });


  test("persists bounded pre-tool runtime failure and never logs secret-bearing upstream detail", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-agt08-runtime-failure-"));
    roots.push(root);
    const browser = new FakeAutomationBrowserProvider();
    const pack = createImageTextMaterialPackFixture();
    const secret = "sk-never-persist-this";
    const upstream = Object.assign(
      new Error("Authorization: Bearer " + secret),
      { status: 400 },
    );
    const execute = vi.fn(async () => {
      throw new AgentSessionError(
        "AGENT_SESSION_RUN_FAILED",
        "Agent session run failed: Authorization: Bearer " + secret,
        { cause: upstream, runStopped: true },
      );
    });
    const warning = vi
      .spyOn(process, "emitWarning")
      .mockImplementation(() => undefined as never);
    const application = createMvpPrepublishApplication({
      databasePath: join(root, "app.db"),
      browserProvider: browser,
      publishingSecretary: { execute },
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "运行时失败必须可诊断",
      });
      const result = await application.runtime.orchestrator.continueJob(
        created.id,
      );

      expect(result).toMatchObject({
        blocked: true,
        error: {
          code: "PUBLISHING_UPSTREAM_REQUEST_REJECTED",
          message:
            "An upstream Publishing Secretary request was rejected.",
        },
        projection: {
          status: "preparing_publish",
          currentStep: "publishing_secretary_runtime",
          failure: {
            step: "publishing_secretary_runtime",
            code: "PUBLISHING_UPSTREAM_REQUEST_REJECTED",
            message:
              "An upstream Publishing Secretary request was rejected.",
          },
        },
      });
      expect(
        application.runtime.jobs.getById(created.id)?.checkpoint,
      ).toMatchObject({
        phase: "publishing_secretary_runtime_failed",
        publishingSecretaryRuntimeStage: "session_run",
        publishingSecretaryRuntimeCode: "PUBLISHING_UPSTREAM_REQUEST_REJECTED",
        publishingSecretaryRuntimeUpstreamStatus: 400,
      });

      const serializedSteps = JSON.stringify(
        application.runtime.jobs.getStepsForJob(created.id),
      );
      expect(serializedSteps).not.toContain(secret);
      expect(serializedSteps).not.toContain("Authorization");
      expect(JSON.stringify(warning.mock.calls)).not.toContain(secret);
      expect(warning).toHaveBeenCalledWith(
        expect.stringContaining(
          "code=PUBLISHING_UPSTREAM_REQUEST_REJECTED",
        ),
        { code: "APP_PUBLISHING_RUNTIME_FAILED" },
      );

      const reread = application.runtime.orchestrator.getJob(created.id);
      expect(reread.failure).toMatchObject({
        step: "publishing_secretary_runtime",
        code: "PUBLISHING_UPSTREAM_REQUEST_REJECTED",
      });
    } finally {
      warning.mockRestore();
      await application.stop();
    }
  });

  test("turns an Agent-prepared QR surface into one durable login handoff and freezes Agent mutation", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-xhs05-identity-stop-"));
    roots.push(root);
    const browser = new FakeAutomationBrowserProvider();
    const pack = createImageTextMaterialPackFixture();
    const execute = vi.fn(async () => ({
      kind: "needs_identity" as const,
      summary: "model output is replaced with safe bounded text",
      semanticMilestone: "model-milestone",
      identitySurface: "qr_ready" as const,
      browserToolCalls: 4,
    }));
    let inspectCalls = 0;
    const application = createMvpPrepublishApplication({
      databasePath: join(root, "app.db"),
      browserProvider: browser,
      publishingSecretary: { execute },
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
      xiaohongshu: {
        inspectEntry: async () => {
          inspectCalls += 1;
          return { kind: "login_required" as const };
        },
      },
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "执行秘书自己找到二维码再叫我",
      });
      const first = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(first.error).toBeNull();
      expect(first.projection.status).toBe("waiting_for_login");
      expect(first.projection.humanAction).toMatchObject({
        type: "login_required",
        reason: "qr_ready",
        instruction: "Scan the QR code in the live browser to continue.",
      });
      expect(
        application.runtime.jobs.getById(created.id)?.checkpoint,
      ).toMatchObject({
        phase: "ensure_login",
        entryState: "login_required",
        identitySurface: "qr_ready",
      });
      expect(execute).toHaveBeenCalledTimes(1);

      const second = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(second.error).toBeNull();
      expect(second.projection.status).toBe("waiting_for_login");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(inspectCalls).toBe(1);
      expect(
        application.runtime.actionRequests.getCurrentOpenForJob(created.id),
      ).toMatchObject({
        type: "login_required",
        status: "open",
      });
    } finally {
      await application.stop();
    }
  });

  test("same-profile login detection returns to Publishing Secretary instead of legacy deterministic prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-xhs05-resume-"));
    roots.push(root);
    const browser = new FakeAutomationBrowserProvider();
    const pack = createImageTextMaterialPackFixture();
    const preparePage = vi.fn();
    const execute = vi
      .fn()
      .mockResolvedValueOnce({
        kind: "needs_identity" as const,
        summary: "QR is ready",
        semanticMilestone: "qr_ready",
        identitySurface: "qr_ready" as const,
        browserToolCalls: 3,
      })
      .mockResolvedValueOnce({
        kind: "progress" as const,
        summary: "resumed after authentication",
        semanticMilestone: "authenticated_creator_observed",
        identitySurface: null,
        browserToolCalls: 2,
      });

    let authenticated = false;
    const application = createMvpPrepublishApplication({
      databasePath: join(root, "app.db"),
      browserProvider: browser,
      publishingSecretary: { execute },
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
      xiaohongshu: {
        inspectEntry: async () =>
          authenticated
            ? { kind: "authenticated" as const }
            : { kind: "login_required" as const },
        preparePage,
      },
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "扫码后继续让执行秘书工作",
      });

      const waiting = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(waiting.projection.status).toBe("waiting_for_login");
      expect(execute).toHaveBeenCalledTimes(1);

      authenticated = true;
      const loginResolved = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(loginResolved.projection.status).toBe("preparing_publish");
      expect(loginResolved.blocked).toBe(false);
      expect(execute).toHaveBeenCalledTimes(1);
      expect(preparePage).not.toHaveBeenCalled();
      expect(
        application.runtime.actionRequests.getCurrentOpenForJob(created.id),
      ).toBeNull();

      const resumed = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(resumed.projection.status).toBe("preparing_publish");
      expect(execute).toHaveBeenCalledTimes(2);
      expect(preparePage).not.toHaveBeenCalled();
    } finally {
      await application.stop();
    }
  });

  test("orchestrator delegates normal browser preparation to Publishing Secretary and does not replay legacy prepare", async () => {
    const root = mkdtempSync(join(tmpdir(), "publisher-agt07-orchestrator-"));
    roots.push(root);
    const browser = new FakeAutomationBrowserProvider();
    const pack = createImageTextMaterialPackFixture();
    const execute = vi.fn(async () => ({
      kind: "prepared_candidate" as const,
      summary: "agent prepared candidate",
      semanticMilestone: "composer_ready",
      browserToolCalls: 5,
    }));
    const publishingSecretary: PublishingSecretaryPort = { execute };
    const openEntry = vi.fn(async () => ({ kind: "authenticated" as const }));
    const preparePage = vi.fn();

    const application = createMvpPrepublishApplication({
      databasePath: join(root, "app.db"),
      browserProvider: browser,
      publishingSecretary,
      materialSource: createControlledMaterialSource(async () => pack),
      resolveAssetPath: (asset) => join(root, asset.assetId + ".png"),
      xiaohongshu: {
        openEntry,
        inspectEntry: openEntry,
        preparePage,
      },
    });

    try {
      const created = await application.runtime.orchestrator.createJob({
        brief: "让执行秘书自己看网页",
      });
      const run = await application.runtime.orchestrator.continueJob(created.id);

      expect(run.error).toBeNull();
      expect(run.projection.status).toBe("preparing_publish");
      expect(
        application.runtime.jobs.getById(created.id)?.checkpoint,
      ).toMatchObject({
        phase: "publishing_secretary_prepared_candidate",
        publishingSecretaryKind: "prepared_candidate",
        publishingSecretaryMilestone: "composer_ready",
      });
      expect(execute).toHaveBeenCalledTimes(1);
      expect(openEntry).not.toHaveBeenCalled();
      expect(preparePage).not.toHaveBeenCalled();
      expect(browser.releaseCalls).toBe(1);

      const repeated = await application.runtime.orchestrator.continueJob(
        created.id,
      );
      expect(repeated.error).toBeNull();
      expect(repeated.projection.status).toBe("preparing_publish");
      expect(execute).toHaveBeenCalledTimes(1);
      expect(browser.acquireCalls).toBe(1);
      expect(browser.releaseCalls).toBe(1);
    } finally {
      await application.stop();
    }
  });
});
