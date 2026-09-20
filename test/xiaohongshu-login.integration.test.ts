import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import type { BrowserSession } from "../src/browser/provider.js";
import { JobControlService } from "../src/jobs/job-control-service.js";
import { ResumeService } from "../src/jobs/resume-service.js";
import {
  classifyXiaohongshuEntrySignals,
  type XiaohongshuEntryState,
} from "../src/platforms/xiaohongshu/login-entry.js";
import {
  XiaohongshuLoginFlowInvariantError,
  XiaohongshuLoginService,
  XiaohongshuUnexpectedEntryStateError,
} from "../src/platforms/xiaohongshu/login-service.js";
import { ActionRequestRepository } from "../src/storage/action-request-repository.js";
import { openDatabase } from "../src/storage/db.js";
import { JobRepository } from "../src/storage/job-repository.js";

function makeTempDb() {
  const root = mkdtempSync(join(tmpdir(), "agent-publisher-xhs-login-"));
  return { root, databasePath: join(root, "app.db") };
}

function createPreparingPublishJob(jobs: JobRepository, jobId: string): void {
  jobs.create({
    id: jobId,
    platform: "xiaohongshu",
    publishMode: "image_text",
    briefJson: "{}",
  });
  jobs.commitCheckpoint(jobId, {
    status: "preparing_materials",
    checkpoint: { phase: "materials" },
    step: {
      id: jobId + "-materials",
      stepKey: "generate_copy",
      status: "succeeded",
    },
  });
  jobs.commitCheckpoint(jobId, {
    status: "preparing_publish",
    checkpoint: { phase: "browser" },
    step: {
      id: jobId + "-browser",
      stepKey: "open_platform",
      status: "succeeded",
    },
  });
}

function fakeSession(profileRef = "profile-xhs"): BrowserSession {
  return {
    id: "session-xhs",
    profileRef,
    page: {} as BrowserSession["page"],
  };
}

function makeService(
  db: ReturnType<typeof openDatabase>,
  jobs: JobRepository,
  actions: ActionRequestRepository,
  options: {
    readonly openEntry: () => Promise<XiaohongshuEntryState>;
    readonly inspectEntry: () => Promise<XiaohongshuEntryState>;
  },
) {
  let sequence = 0;
  const control = new JobControlService({
    jobs,
    actionRequests: actions,
    runInTransaction: (work) => db.transaction(work)(),
  });
  const resume = new ResumeService({ jobs, actionRequests: actions });

  return new XiaohongshuLoginService({
    jobs,
    actionRequests: actions,
    control,
    resume,
    openEntry: async () => await options.openEntry(),
    inspectEntry: async () => await options.inspectEntry(),
    createId: () => "xhs-test-" + String(++sequence),
    now: () => new Date("2026-09-20T06:00:00.000Z"),
  });
}

describe("Xiaohongshu entry-state classifier", () => {
  test("requires a usable publish marker before treating the creator page as authenticated", () => {
    expect(
      classifyXiaohongshuEntrySignals({
        url: "https://creator.xiaohongshu.com/publish/publish?source=official",
        usablePublishMarker: true,
        loginMarker: false,
        challengeMarker: false,
      }),
    ).toEqual({ kind: "authenticated" });

    expect(
      classifyXiaohongshuEntrySignals({
        url: "https://creator.xiaohongshu.com/publish/publish?source=official",
        usablePublishMarker: false,
        loginMarker: false,
        challengeMarker: false,
      }),
    ).toEqual({ kind: "unexpected" });
  });

  test("challenge wins over login markers and login URLs fail closed as login_required", () => {
    expect(
      classifyXiaohongshuEntrySignals({
        url: "https://creator.xiaohongshu.com/login",
        usablePublishMarker: false,
        loginMarker: true,
        challengeMarker: true,
      }),
    ).toEqual({ kind: "challenge" });

    expect(
      classifyXiaohongshuEntrySignals({
        url: "https://creator.xiaohongshu.com/login",
        usablePublishMarker: false,
        loginMarker: false,
        challengeMarker: false,
      }),
    ).toEqual({ kind: "login_required" });
  });

  test("foreign or ambiguous pages are never mistaken for authenticated success", () => {
    expect(
      classifyXiaohongshuEntrySignals({
        url: "https://example.test/publish",
        usablePublishMarker: true,
        loginMarker: false,
        challengeMarker: false,
      }),
    ).toEqual({ kind: "unexpected" });
  });
});

describe("XiaohongshuLoginService", () => {
  const cleanupRoots: string[] = [];

  afterEach(() => {
    while (cleanupRoots.length > 0) {
      rmSync(cleanupRoots.pop()!, { recursive: true, force: true });
    }
  });

  test("already-authenticated profile reaches a durable deterministic ready state", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-authenticated");

    const service = makeService(db, jobs, actions, {
      openEntry: async () => ({ kind: "authenticated" }),
      inspectEntry: async () => ({ kind: "unexpected" }),
    });

    try {
      await expect(
        service.ensureLogin({
          jobId: "job-authenticated",
          session: fakeSession(),
        }),
      ).resolves.toMatchObject({
        kind: "ready",
        job: {
          status: "preparing_publish",
          currentStep: "ensure_login",
          checkpoint: {
            platform: "xiaohongshu",
            phase: "ensure_login",
            entryState: "authenticated",
          },
        },
        state: { kind: "authenticated" },
      });

      expect(actions.getCurrentOpenForJob("job-authenticated")).toBeNull();
      expect(
        jobs
          .getStepsForJob("job-authenticated")
          .filter((step) => step.stepKey === "ensure_login"),
      ).toMatchObject([
        {
          attempt: 1,
          status: "succeeded",
          errorCode: null,
        },
      ]);
    } finally {
      db.close();
    }
  });

  test("logged-out takeover reuses exactly one durable login action and never renavigates while human control is active", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-login-wait");

    let openCalls = 0;
    let inspectCalls = 0;
    const service = makeService(db, jobs, actions, {
      openEntry: async () => {
        openCalls += 1;
        return { kind: "login_required" };
      },
      inspectEntry: async () => {
        inspectCalls += 1;
        return { kind: "login_required" };
      },
    });

    try {
      const first = await service.ensureLogin({
        jobId: "job-login-wait",
        session: fakeSession(),
      });
      const replay = await service.ensureLogin({
        jobId: "job-login-wait",
        session: fakeSession(),
      });

      expect(first).toMatchObject({
        kind: "human_takeover",
        job: { status: "waiting_for_login" },
        state: { kind: "login_required" },
        action: { type: "login_required", status: "open" },
      });
      expect(replay).toMatchObject({
        kind: "human_takeover",
        action: { id: first.kind === "human_takeover" ? first.action.id : "" },
      });
      expect(openCalls).toBe(1);
      expect(inspectCalls).toBe(1);
      expect(
        db
          .prepare(
            "SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ? AND type = 'login_required'",
          )
          .get("job-login-wait"),
      ).toEqual({ count: 1 });
      expect(
        jobs
          .getStepsForJob("job-login-wait")
          .filter((step) => step.stepKey === "ensure_login"),
      ).toHaveLength(1);
    } finally {
      db.close();
    }
  });

  test("restart resumes the checkpoint-bound login action without creating a duplicate", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    let db = openDatabase({ databasePath: temp.databasePath });
    let jobs = new JobRepository(db);
    let actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-login-restart");

    const firstService = makeService(db, jobs, actions, {
      openEntry: async () => ({ kind: "login_required" }),
      inspectEntry: async () => ({ kind: "login_required" }),
    });
    const first = await firstService.ensureLogin({
      jobId: "job-login-restart",
      session: fakeSession(),
    });
    if (first.kind !== "human_takeover") {
      throw new Error("expected human takeover");
    }
    const firstActionId = first.action.id;
    db.close();

    db = openDatabase({ databasePath: temp.databasePath });
    jobs = new JobRepository(db);
    actions = new ActionRequestRepository(db);
    let openCalls = 0;
    let inspectCalls = 0;
    const resumedService = makeService(db, jobs, actions, {
      openEntry: async () => {
        openCalls += 1;
        return { kind: "unexpected" };
      },
      inspectEntry: async () => {
        inspectCalls += 1;
        return { kind: "login_required" };
      },
    });

    try {
      const resumed = await resumedService.ensureLogin({
        jobId: "job-login-restart",
        session: fakeSession(),
      });

      expect(resumed).toMatchObject({
        kind: "human_takeover",
        action: {
          id: firstActionId,
          type: "login_required",
          status: "open",
        },
      });
      expect(openCalls).toBe(0);
      expect(inspectCalls).toBe(1);
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ?")
          .get("job-login-restart"),
      ).toEqual({ count: 1 });
    } finally {
      db.close();
    }
  });

  test("an existing human action blocks navigation before any browser mutation", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-human-action-block");

    const control = new JobControlService({
      jobs,
      actionRequests: actions,
      runInTransaction: (work) => db.transaction(work)(),
    });
    control.requestClarification({
      jobId: "job-human-action-block",
      checkpoint: {
        phase: "pre-login-clarification",
      },
      step: {
        id: "clarification-step",
        stepKey: "open_platform",
        status: "running",
        attempt: 2,
      },
      action: {
        id: "clarification-action",
        payload: { field: "account" },
      },
    });

    let openCalls = 0;
    const service = makeService(db, jobs, actions, {
      openEntry: async () => {
        openCalls += 1;
        return { kind: "authenticated" };
      },
      inspectEntry: async () => ({ kind: "unexpected" }),
    });

    try {
      await expect(
        service.ensureLogin({
          jobId: "job-human-action-block",
          session: fakeSession(),
        }),
      ).rejects.toBeInstanceOf(XiaohongshuLoginFlowInvariantError);

      expect(openCalls).toBe(0);
      expect(actions.getCurrentOpenForJob("job-human-action-block")).toMatchObject({
        id: "clarification-action",
        type: "clarification_required",
        status: "open",
      });
      expect(jobs.getById("job-human-action-block")).toMatchObject({
        status: "preparing_publish",
        checkpoint: {
          phase: "pre-login-clarification",
          actionRequestId: "clarification-action",
        },
      });
    } finally {
      db.close();
    }
  });

  test("human takeover refuses to resume on a different persistent browser profile", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-profile-mismatch");

    let inspectCalls = 0;
    const service = makeService(db, jobs, actions, {
      openEntry: async () => ({ kind: "login_required" }),
      inspectEntry: async () => {
        inspectCalls += 1;
        return { kind: "authenticated" };
      },
    });

    try {
      const waiting = await service.ensureLogin({
        jobId: "job-profile-mismatch",
        session: fakeSession("profile-original"),
      });
      if (waiting.kind !== "human_takeover") {
        throw new Error("expected human takeover");
      }

      await expect(
        service.ensureLogin({
          jobId: "job-profile-mismatch",
          session: fakeSession("profile-other"),
        }),
      ).rejects.toBeInstanceOf(XiaohongshuLoginFlowInvariantError);

      expect(inspectCalls).toBe(0);
      expect(actions.getById(waiting.action.id)).toMatchObject({
        id: waiting.action.id,
        type: "login_required",
        status: "open",
      });
      expect(jobs.getById("job-profile-mismatch")).toMatchObject({
        status: "waiting_for_login",
        checkpoint: {
          actionRequestId: waiting.action.id,
        },
      });
    } finally {
      db.close();
    }
  });

  test("successful human login resolves the existing action and returns to deterministic publishing without a second request", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-login-complete");

    let inspectedState: XiaohongshuEntryState = { kind: "login_required" };
    let openCalls = 0;
    const service = makeService(db, jobs, actions, {
      openEntry: async () => {
        openCalls += 1;
        return { kind: "login_required" };
      },
      inspectEntry: async () => inspectedState,
    });

    try {
      const waiting = await service.ensureLogin({
        jobId: "job-login-complete",
        session: fakeSession(),
      });
      if (waiting.kind !== "human_takeover") {
        throw new Error("expected human takeover");
      }

      inspectedState = { kind: "authenticated" };
      const ready = await service.ensureLogin({
        jobId: "job-login-complete",
        session: fakeSession(),
      });

      expect(ready).toMatchObject({
        kind: "ready",
        job: {
          status: "preparing_publish",
          currentStep: "ensure_login",
          checkpoint: {
            platform: "xiaohongshu",
            phase: "ensure_login",
            entryState: "authenticated",
          },
        },
      });
      expect(ready.kind === "ready" ? ready.job.checkpoint : null).not.toHaveProperty(
        "actionRequestId",
      );
      expect(actions.getById(waiting.action.id)).toMatchObject({
        id: waiting.action.id,
        type: "login_required",
        status: "resolved",
        resolution: {
          loginDetected: true,
          platform: "xiaohongshu",
        },
      });
      expect(actions.getCurrentOpenForJob("job-login-complete")).toBeNull();
      expect(
        db
          .prepare("SELECT COUNT(*) AS count FROM action_requests WHERE job_id = ?")
          .get("job-login-complete"),
      ).toEqual({ count: 1 });
      expect(openCalls).toBe(1);
      expect(
        jobs
          .getStepsForJob("job-login-complete")
          .filter((step) => step.stepKey === "ensure_login"),
      ).toMatchObject([{ attempt: 1, status: "succeeded" }]);
    } finally {
      db.close();
    }
  });

  test("challenge state becomes the same bounded login_required takeover without persisting session material", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-challenge");

    const service = makeService(db, jobs, actions, {
      openEntry: async () => ({ kind: "challenge" }),
      inspectEntry: async () => ({ kind: "challenge" }),
    });

    try {
      const waiting = await service.ensureLogin({
        jobId: "job-challenge",
        session: fakeSession(),
      });

      expect(waiting).toMatchObject({
        kind: "human_takeover",
        state: { kind: "challenge" },
        action: {
          type: "login_required",
          status: "open",
          payload: {
            platform: "xiaohongshu",
            reason: "challenge",
            humanControl: "live_browser",
          },
        },
      });

      const durable = db
        .prepare(
          "SELECT j.checkpoint_json, a.payload_json FROM jobs j JOIN action_requests a ON a.job_id = j.id WHERE j.id = ?",
        )
        .get("job-challenge") as {
        checkpoint_json: string;
        payload_json: string;
      };
      const serialized = JSON.stringify(durable).toLowerCase();
      for (const forbidden of [
        "cookie",
        "storage_state",
        "storagestate",
        "password",
        "access_token",
        "refresh_token",
        "qr_artifact",
        "qrcode_data",
        "profile-xhs",
      ]) {
        expect(serialized).not.toContain(forbidden);
      }
    } finally {
      db.close();
    }
  });

  test("unexpected page state fails visibly and never creates a login action", async () => {
    const temp = makeTempDb();
    cleanupRoots.push(temp.root);
    const db = openDatabase({ databasePath: temp.databasePath });
    const jobs = new JobRepository(db);
    const actions = new ActionRequestRepository(db);
    createPreparingPublishJob(jobs, "job-unexpected");

    const service = makeService(db, jobs, actions, {
      openEntry: async () => ({ kind: "unexpected" }),
      inspectEntry: async () => ({ kind: "unexpected" }),
    });

    try {
      await expect(
        service.ensureLogin({
          jobId: "job-unexpected",
          session: fakeSession(),
        }),
      ).rejects.toBeInstanceOf(XiaohongshuUnexpectedEntryStateError);

      expect(actions.getCurrentOpenForJob("job-unexpected")).toBeNull();
      expect(jobs.getById("job-unexpected")).toMatchObject({
        status: "preparing_publish",
        currentStep: "ensure_login",
        checkpoint: {
          platform: "xiaohongshu",
          phase: "ensure_login",
          entryState: "unexpected",
        },
      });
      expect(
        jobs
          .getStepsForJob("job-unexpected")
          .filter((step) => step.stepKey === "ensure_login"),
      ).toMatchObject([
        {
          attempt: 1,
          status: "failed",
          errorCode: "PLATFORM_UI_CHANGED",
        },
      ]);
    } finally {
      db.close();
    }
  });
});
