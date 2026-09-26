import { expect, test, vi } from "vitest";

import type { TaskFixture } from "../src/model.js";

import {
  ApiTaskError,
  ApiTaskRepository,
  shouldAutoContinueTask,
  type ApiJobProjection,
} from "../src/task-api.js";

function projection(
  overrides: Partial<ApiJobProjection> = {},
): ApiJobProjection {
  return {
    id: "job-real-1",
    platform: "xiaohongshu",
    publishMode: "image_text",
    status: "created",
    currentStep: null,
    currentWorker: "content_secretary",
    phase: "created",
    needsHuman: false,
    updatedAt: "2026-09-20T12:00:00.000Z",
    material: null,
    timeline: [],
    humanAction: null,
    liveView: null,
    approval: null,
    failure: null,
    ...overrides,
  };
}

function response(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => {
      values.set(key, value);
    },
    removeItem: (key: string) => {
      values.delete(key);
    },
  };
}

test("real assignment uses APP-02 and preserves the brief for route refresh", async () => {
  const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body))).toMatchObject({
      brief: "真实 brief",
      platform: "xiaohongshu",
      publishMode: "image_text",
    });
    return response({ job: projection() }, 201);
  });
  const storage = memoryStorage();
  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const assigned = await repository.assign({
    brief: "真实 brief",
    publishMode: "image_text",
  });

  expect(assigned.id).toBe("job-real-1");
  expect(assigned.brief).toBe("真实 brief");
  expect(assigned.runtimeSource).toBe("api");
  expect(assigned.state).toBe("preparing_materials");
  expect(storage.getItem("agent-publisher:job-brief:job-real-1")).toBe(
    "真实 brief",
  );
});

test("video assignment fails closed before calling APP-02", async () => {
  const fetchImpl = vi.fn();
  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  await expect(
    repository.assign({ brief: "video", publishMode: "video" }),
  ).rejects.toBeInstanceOf(ApiTaskError);
  expect(fetchImpl).not.toHaveBeenCalled();
});

test("waiting_for_login trusts only the backend Live View descriptor", async () => {
  const fetchImpl = vi.fn(async () =>
    response({
      job: projection({
        status: "waiting_for_login",
        currentWorker: "publishing_secretary",
        phase: "human_takeover",
        needsHuman: true,
        humanAction: {
          id: "action-login",
          type: "login_required",
          reason: "login_required",
          instruction: "请完成登录",
        },
        liveView: {
          mode: "runtime",
          url: "http://127.0.0.1:6080/vnc.html",
          controlOwner: "human",
        },
      }),
    }),
  );
  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const task = await repository.get("job-real-1");

  expect(task.state).toBe("waiting_for_login");
  expect(task.browserLiveViewMode).toBe("runtime");
  expect(task.browserLiveViewUrl).toBe("http://127.0.0.1:6080/vnc.html");
  expect(task.controlOwner).toBe("human");
  expect(task.needsHuman).toBe(true);
});

test("preparing_publish renders the backend Live View as Agent-owned and exposes semantic progress", async () => {
  const fetchImpl = vi.fn(async () =>
    response({
      job: projection({
        status: "preparing_publish",
        currentWorker: "publishing_secretary",
        currentStep: "publishing_progress_observing",
        phase: "publishing_secretary_progress",
        liveView: {
          mode: "runtime",
          url: "/browser-live-view/vnc.html?path=browser-live-view/websockify",
          controlOwner: "agent",
        },
        timeline: [
          {
            stepKey: "publishing_progress_observing",
            status: "running",
            attempt: 1,
            errorCode: null,
            errorMessage: null,
          },
        ],
      }),
    }),
  );
  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const task = await repository.get("job-real-1");

  expect(task.browserLiveViewMode).toBe("runtime");
  expect(task.browserLiveViewUrl).toBe(
    "/browser-live-view/vnc.html?path=browser-live-view/websockify",
  );
  expect(task.controlOwner).toBe("agent");
  expect(task.currentStep).toBe("观察当前页面");
  expect(task.timeline).toContainEqual(
    expect.objectContaining({
      label: "观察当前页面",
      detail: "读取当前发布页面状态",
      status: "active",
    }),
  );
});

test("SSE projection renders actual controlled material and real approval summary", () => {
  let listener: ((event: MessageEvent<string>) => void) | undefined;
  const close = vi.fn();
  const repository = new ApiTaskRepository({
    fetchImpl: vi.fn() as unknown as typeof fetch,
    storage: null,
    eventSourceFactory: () => ({
      addEventListener: (_type, next) => {
        listener = next;
      },
      close,
    }),
  });

  let received: TaskFixture | undefined;
  const unsubscribe = repository.subscribe("job-real-1", (task) => {
    received = task;
  });

  listener?.({
    data: JSON.stringify({
      job: projection({
        status: "waiting_for_approval",
        currentWorker: "publishing_secretary",
        phase: "prepared_for_approval",
        needsHuman: true,
        material: {
          source: "controlled_smoke",
          generatedFromBrief: false,
          title: "实际受控标题",
          body: "实际受控正文",
          tags: ["真实投影"],
          imageCount: 3,
        },
        humanAction: {
          id: "action-approval",
          type: "approval_required",
          reason: null,
          instruction: null,
        },
        approval: {
          title: "实际受控标题",
          bodyLength: 6,
          tags: ["真实投影"],
          imageCount: 3,
          warningCodes: [],
        },
      }),
    }),
  } as MessageEvent<string>);

  expect(received).toMatchObject({
    state: "waiting_for_approval",
    material: {
      title: "实际受控标题",
      body: "实际受控正文",
    },
    materialProvenance: {
      source: "controlled_smoke",
      generatedFromBrief: false,
    },
    approval: {
      mediaSummary: "3 张图片 · 已就绪",
    },
  });

  unsubscribe();
  expect(close).toHaveBeenCalledOnce();
});


test("committed Job creation survives unavailable browser storage", async () => {
  const fetchImpl = vi.fn(async () => response({ job: projection() }, 201));
  const throwingStorage = {
    getItem: () => {
      throw new DOMException("storage unavailable", "SecurityError");
    },
    setItem: () => {
      throw new DOMException("quota exceeded", "QuotaExceededError");
    },
    removeItem: () => undefined,
  };

  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage: throwingStorage,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  await expect(
    repository.assign({
      brief: "缓存坏了也不能重复建 Job",
      publishMode: "image_text",
    }),
  ).resolves.toMatchObject({
    id: "job-real-1",
    brief: "缓存坏了也不能重复建 Job",
    runtimeSource: "api",
  });

  expect(fetchImpl).toHaveBeenCalledOnce();
});



test("Publishing Secretary runtime failure is specific, durable-looking, and stops auto-continue", async () => {
  const repository = new ApiTaskRepository({
    fetchImpl: vi.fn(async () =>
      response({
        job: projection({
          status: "preparing_publish",
          currentWorker: "publishing_secretary",
          currentStep: "publishing_secretary_runtime",
          phase: "publishing_secretary_runtime_failed",
          failure: {
            step: "publishing_secretary_runtime",
            code: "PUBLISHER_AI_REQUEST_REJECTED",
            message:
              "The configured AI runtime rejected the Publishing Secretary model/tool request.",
          },
        }),
      }),
    ) as unknown as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const task = await repository.get("job-real-1");
  expect(task).toMatchObject({
    currentStep: "执行秘书运行失败",
    failure: {
      step: "执行秘书运行失败",
      reason: "AI 服务拒绝了执行秘书的模型 / 工具请求。",
      recovery:
        "已停止自动重试。请根据错误类别检查执行秘书运行时后再重试。",
    },
  });
  expect(shouldAutoContinueTask(task)).toBe(false);
});

test("continue preserves bounded run.error when durable failure projection is unavailable", async () => {
  const fetchImpl = vi.fn(async () =>
    response({
      job: projection({
        status: "preparing_publish",
        currentWorker: "publishing_secretary",
        currentStep: "publishing_progress_starting",
        phase: "publishing_secretary_progress",
      }),
      run: {
        blocked: true,
        error: {
          code: "PUBLISHER_AI_REQUEST_REJECTED",
          message: "bounded backend message",
        },
      },
    }),
  );
  const repository = new ApiTaskRepository({
    fetchImpl: fetchImpl as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const task = await repository.continue("job-real-1");
  expect(task.failure).toMatchObject({
    reason: "AI 服务拒绝了执行秘书的模型 / 工具请求。",
    recovery:
      "本次执行已停止自动重试。请根据错误类别检查当前运行时后再继续。",
  });
  expect(shouldAutoContinueTask(task)).toBe(false);
});

test("auto-continue stops on durable failures and clarification boundaries", async () => {
  const failureRepository = new ApiTaskRepository({
    fetchImpl: vi.fn(async () =>
      response({
        job: projection({
          status: "preparing_publish",
          currentWorker: "publishing_secretary",
          currentStep: "acquire_browser",
          phase: "browser_session_unavailable",
          failure: {
            step: "acquire_browser",
            code: "BROWSER_UNAVAILABLE",
            message: "browser unavailable",
          },
        }),
      }),
    ) as unknown as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const failedTask = await failureRepository.get("job-real-1");
  expect(failedTask.failure).toBeDefined();
  expect(shouldAutoContinueTask(failedTask)).toBe(false);

  const clarificationRepository = new ApiTaskRepository({
    fetchImpl: vi.fn(async () =>
      response({
        job: projection({
          status: "preparing_publish",
          currentWorker: "publishing_secretary",
          phase: "xhs_prepare_recovery_required",
          needsHuman: true,
          humanAction: {
            id: "action-clarification",
            type: "clarification_required",
            reason: "prepare_recovery_required",
            instruction: "请先确认当前编辑器状态",
          },
        }),
      }),
    ) as unknown as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const clarificationTask = await clarificationRepository.get("job-real-1");
  expect(clarificationTask).toMatchObject({
    state: "failed",
    statusLabel: "需要处理",
    needsHuman: true,
    currentStep: "等待你确认当前状态",
    failure: {
      reason: "当前编辑器状态需要人工确认后才能继续。",
      recovery: "请先确认当前编辑器状态",
    },
  });
  expect(shouldAutoContinueTask(clarificationTask)).toBe(false);
});

test("waiting_for_login remains the one human-action state that is polled for resume", async () => {
  const repository = new ApiTaskRepository({
    fetchImpl: vi.fn(async () =>
      response({
        job: projection({
          status: "waiting_for_login",
          currentWorker: "publishing_secretary",
          phase: "human_takeover",
          needsHuman: true,
          humanAction: {
            id: "action-login",
            type: "login_required",
            reason: "login_required",
            instruction: "请完成登录",
          },
          liveView: {
            mode: "runtime",
            url: "http://127.0.0.1:6080/vnc.html",
            controlOwner: "human",
          },
        }),
      }),
    ) as unknown as typeof fetch,
    storage: null,
    eventSourceFactory: () => {
      throw new Error("SSE not used in this test");
    },
  });

  const task = await repository.get("job-real-1");
  expect(shouldAutoContinueTask(task)).toBe(true);
});
