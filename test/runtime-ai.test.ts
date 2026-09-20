import { once } from "node:events";
import {
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
} from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
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
  CONTENT_SECRETARY_ROLE,
  ContentSecretaryService,
} from "../src/agent/content-secretary.js";
import { JobAgentSessionService } from "../src/agent/job-session-service.js";
import {
  PUBLISHER_AI_API_KEY_ENV,
  PUBLISHER_AI_BASE_URL_ENV,
  PUBLISHER_AI_MODEL_ENV,
  PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
  PublisherAiConfigError,
  createPublisherAiRuntime,
  createPublisherContentSecretaryHost,
  readPublisherAiConfig,
  redactPublisherAiSecret,
} from "../src/agent/runtime-ai.js";
import { AgentSessionBindingRepository } from "../src/storage/agent-session-binding-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

const cleanupRoots: string[] = [];

afterEach(() => {
  while (cleanupRoots.length > 0) {
    const root = cleanupRoots.pop();
    if (root) rmSync(root, { recursive: true, force: true });
  }
});

function makeRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  cleanupRoots.push(root);
  return root;
}

function readAllFiles(root: string): string {
  const chunks: string[] = [];
  const visit = (path: string): void => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const name of readdirSync(path)) visit(join(path, name));
      return;
    }
    chunks.push(readFileSync(path).toString("utf8"));
  };
  visit(root);
  return chunks.join("\n");
}

async function createFauxRuntime(providerName: string) {
  const faux = fauxProvider({ provider: providerName });
  const modelRuntime = await ModelRuntime.create({
    credentials: new InMemoryCredentialStore(),
    modelsPath: null,
    refreshOnCreate: false,
  });
  modelRuntime.registerNativeProvider(faux.provider);
  return { faux, modelRuntime };
}

describe("Publisher runtime AI configuration", () => {
  test("requires all three explicit Publisher AI environment values", () => {
    const base = {
      [PUBLISHER_AI_BASE_URL_ENV]: "https://gateway.example.test/v1",
      [PUBLISHER_AI_API_KEY_ENV]: "secret-key",
      [PUBLISHER_AI_MODEL_ENV]: "model-a",
    };

    for (const missing of [
      PUBLISHER_AI_BASE_URL_ENV,
      PUBLISHER_AI_API_KEY_ENV,
      PUBLISHER_AI_MODEL_ENV,
    ]) {
      const env: NodeJS.ProcessEnv = { ...base };
      delete env[missing];

      expect(() => readPublisherAiConfig(env)).toThrowError(
        PublisherAiConfigError,
      );
      try {
        readPublisherAiConfig(env);
      } catch (error) {
        expect(String(error)).not.toContain(base[PUBLISHER_AI_API_KEY_ENV]);
      }
    }
  });

  test("allows HTTPS or explicit loopback HTTP and rejects unsafe endpoint forms", () => {
    expect(
      readPublisherAiConfig({
        [PUBLISHER_AI_BASE_URL_ENV]: "https://gateway.example.test/v1/",
        [PUBLISHER_AI_API_KEY_ENV]: "secret-key",
        [PUBLISHER_AI_MODEL_ENV]: "model-a",
      }),
    ).toEqual({
      baseUrl: "https://gateway.example.test/v1",
      apiKey: "secret-key",
      model: "model-a",
    });

    for (const baseUrl of [
      "http://127.0.0.1:8080/v1",
      "http://127.42.0.1:8080/v1",
      "http://localhost:8080/v1",
      "http://publisher.localhost:8080/v1",
      "http://[::1]:8080/v1",
    ]) {
      expect(
        readPublisherAiConfig({
          [PUBLISHER_AI_BASE_URL_ENV]: baseUrl,
          [PUBLISHER_AI_API_KEY_ENV]: "secret-key",
          [PUBLISHER_AI_MODEL_ENV]: "model-a",
        }).baseUrl,
      ).toBe(baseUrl);
    }

    for (const baseUrl of [
      "http://gateway.example.test/v1",
      "http://127.example.com/v1",
      "http://127.0.0.1.example.com/v1",
      "https://user:password@gateway.example.test/v1",
      "https://gateway.example.test/v1?key=secret",
      "ftp://gateway.example.test/v1",
    ]) {
      expect(() =>
        readPublisherAiConfig({
          [PUBLISHER_AI_BASE_URL_ENV]: baseUrl,
          [PUBLISHER_AI_API_KEY_ENV]: "secret-key",
          [PUBLISHER_AI_MODEL_ENV]: "model-a",
        }),
      ).toThrowError(PublisherAiConfigError);
    }
  });

  test("constructs a custom OpenAI-compatible Pi runtime without model discovery", async () => {
    const runtime = await createPublisherAiRuntime({
      baseUrl: "http://127.0.0.1:65530/v1",
      apiKey: "runtime-only-secret",
      model: "publisher-test-model",
    });

    expect(runtime.providerId).toBe(PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID);
    expect(runtime.model).toMatchObject({
      provider: PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
      id: "publisher-test-model",
      api: "openai-completions",
      baseUrl: "http://127.0.0.1:65530/v1",
    });
    expect(
      runtime.modelRuntime.getProviderAuthStatus(
        PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
      ),
    ).toMatchObject({
      configured: true,
      source: "runtime",
    });
  });

  test("redacts the runtime key from bounded smoke failures", () => {
    expect(
      redactPublisherAiSecret(
        "request rejected for api-key-value",
        "api-key-value",
      ),
    ).toBe("request rejected for [REDACTED]");
  });
});

describe("Publisher Content Secretary runtime composition", () => {
  test("runs the configured OpenAI-compatible provider path through Content Secretary", async () => {
    const root = makeRoot("agent-publisher-runtime-ai-http-");
    const databasePath = join(root, "app.db");
    const sessionDirectory = join(root, "pi-sessions");
    const requests: Array<{
      readonly url: string | undefined;
      readonly authorization: string | undefined;
      readonly body: {
        readonly model?: string;
        readonly stream?: boolean;
      };
    }> = [];

    const expectedPlan = {
      id: "plan-runtime-ai-http",
      mode: "image_text",
      brief: {
        id: "brief-runtime-ai-http",
        brief: "real provider seam",
        platform: "xiaohongshu",
        mode: "image_text",
      },
      imageCount: 2,
      coverRequired: true,
      design: "optional",
    };

    const server = http.createServer(async (req, res) => {
      if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
        res.writeHead(404).end();
        return;
      }

      let body = "";
      for await (const chunk of req) {
        body += chunk.toString();
      }
      requests.push({
        url: req.url,
        authorization: req.headers.authorization,
        body: JSON.parse(body) as {
          readonly model?: string;
          readonly stream?: boolean;
        },
      });

      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-runtime-ai-http",
          object: "chat.completion.chunk",
          created: 0,
          model: "publisher-http-model",
          choices: [
            {
              index: 0,
              delta: {
                role: "assistant",
                content: JSON.stringify(expectedPlan),
              },
              finish_reason: null,
            },
          ],
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({
          id: "chatcmpl-runtime-ai-http",
          object: "chat.completion.chunk",
          created: 0,
          model: "publisher-http-model",
          choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          usage: {
            prompt_tokens: 10,
            completion_tokens: 10,
            total_tokens: 20,
          },
        })}\n\n`,
      );
      res.end("data: [DONE]\n\n");
    });

    server.listen(0, "127.0.0.1");
    await once(server, "listening");

    let db: ReturnType<typeof openDatabase> | null = null;
    try {
      const { port } = server.address() as AddressInfo;
      const runtime = await createPublisherAiRuntime({
        baseUrl: `http://127.0.0.1:${port}/v1`,
        apiKey: "local-test-key",
        model: "publisher-http-model",
      });
      const host = createPublisherContentSecretaryHost(runtime, {
        cwd: root,
        sessionDirectory,
        defaultRunTimeoutMs: 2_000,
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
        id: "job-runtime-ai-http",
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: JSON.stringify({ topic: "real provider seam" }),
      });

      await expect(
        secretary.createMaterialPlan("job-runtime-ai-http"),
      ).resolves.toMatchObject({
        plan: expectedPlan,
        job: {
          status: "preparing_materials",
          checkpoint: {
            phase: "material_plan_ready",
            materialPlanId: expectedPlan.id,
          },
        },
      });

      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({
        url: "/v1/chat/completions",
        authorization: "Bearer local-test-key",
        body: {
          model: "publisher-http-model",
          stream: true,
        },
      });

      db.close();
      db = null;

      const verificationDb = openDatabase({ databasePath });
      try {
        expect(
          new JobRepository(verificationDb).getById("job-runtime-ai-http"),
        ).toMatchObject({
          status: "preparing_materials",
          currentStep: "material_plan",
          checkpoint: {
            phase: "material_plan_ready",
            materialPlanId: expectedPlan.id,
          },
        });
      } finally {
        verificationDb.close();
      }
    } finally {
      if (db?.open) db.close();
      server.close();
      await once(server, "close");
    }
  });

  test("reuses the production host seam with a controlled Pi provider", async () => {
    const root = makeRoot("agent-publisher-runtime-ai-faux-");
    const db = openDatabase({ databasePath: join(root, "app.db") });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const { faux, modelRuntime } = await createFauxRuntime(
      "publisher-runtime-ai-faux",
    );
    const host = createPublisherContentSecretaryHost(
      {
        providerId: faux.provider.id,
        model: faux.getModel(),
        modelRuntime,
      },
      {
        cwd: root,
        sessionDirectory: join(root, "pi-sessions"),
        defaultRunTimeoutMs: 2_000,
      },
    );
    const sessions = new JobAgentSessionService({ jobs, bindings, host });
    const secretary = new ContentSecretaryService({ jobs, bindings, sessions });

    try {
      jobs.create({
        id: "job-runtime-ai-faux",
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: JSON.stringify({ topic: "runtime composition" }),
      });

      const expectedPlan = {
        id: "plan-runtime-ai-faux",
        mode: "image_text",
        brief: {
          id: "brief-runtime-ai-faux",
          brief: "runtime composition",
          platform: "xiaohongshu",
          mode: "image_text",
        },
        imageCount: 2,
        coverRequired: true,
        design: "optional",
      };

      faux.setResponses([
        fauxAssistantMessage(fauxText(JSON.stringify(expectedPlan))),
      ]);

      await expect(
        secretary.createMaterialPlan("job-runtime-ai-faux"),
      ).resolves.toMatchObject({
        plan: expectedPlan,
        job: {
          status: "preparing_materials",
          checkpoint: {
            phase: "material_plan_ready",
            materialPlanId: expectedPlan.id,
          },
        },
      });
    } finally {
      db.close();
    }
  });

  test("does not persist a configured runtime API key in Job, binding, or Pi session files", async () => {
    const root = makeRoot("agent-publisher-runtime-ai-secret-");
    const databasePath = join(root, "app.db");
    const db = openDatabase({ databasePath });
    const jobs = new JobRepository(db);
    const bindings = new AgentSessionBindingRepository(db);
    const secret = "publisher-secret-must-not-persist";
    const runtime = await createPublisherAiRuntime({
      baseUrl: "http://127.0.0.1:65530/v1",
      apiKey: secret,
      model: "publisher-test-model",
    });
    const host = createPublisherContentSecretaryHost(runtime, {
      cwd: root,
      sessionDirectory: join(root, "pi-sessions"),
      defaultRunTimeoutMs: 2_000,
    });
    const sessions = new JobAgentSessionService({ jobs, bindings, host });

    try {
      jobs.create({
        id: "job-runtime-ai-secret",
        platform: "xiaohongshu",
        publishMode: "image_text",
        briefJson: JSON.stringify({ topic: "secret persistence check" }),
      });

      const session = await sessions.create({
        jobId: "job-runtime-ai-secret",
        role: CONTENT_SECRETARY_ROLE,
        definition: {
          id: "content-secretary",
          systemPrompt: "Secret persistence check only.",
        },
      });
      await session.dispose();

      expect(
        JSON.stringify(jobs.getById("job-runtime-ai-secret")),
      ).not.toContain(secret);
      expect(
        JSON.stringify(
          bindings.getForScope({
            jobId: "job-runtime-ai-secret",
            role: CONTENT_SECRETARY_ROLE,
          }),
        ),
      ).not.toContain(secret);
    } finally {
      db.close();
    }

    expect(readAllFiles(root)).not.toContain(secret);
  });
});
