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
import type { AgentHost, PublisherAgentSession } from "../src/agent/host.js";
import {
  PublishingSecretaryService,
  authorizeXiaohongshuPrepublishClick,
  createXiaohongshuPublishingBrowserResourceLoader,
  type PublishingSecretaryPort,
} from "../src/agent/publishing-secretary.js";
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
      "observe the page, choose the next bounded safe action",
    );
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
          summary: "login verification is visible",
          semanticMilestone: "identity_required",
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
      browserToolCalls: 1,
    });

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
      '- button "删除" [ref=g1:e4]',
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
    } finally {
      await application.stop();
    }
  });
});
