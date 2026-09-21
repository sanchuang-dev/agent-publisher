import type { FastifyServerOptions } from "fastify";

import { createJobEventRoutes } from "../api/routes/job-events.js";
import { createJobRoutes } from "../api/routes/jobs.js";
import { SseConnectionRegistry } from "../api/sse.js";
import type { BrowserProvider } from "../browser/provider.js";
import { DockerCdpBrowserProvider } from "../browser/providers/docker-cdp.js";
import { JobControlService } from "../jobs/job-control-service.js";
import { ResumeService } from "../jobs/resume-service.js";
import type { AssetPathResolver } from "../platforms/xiaohongshu/image-text-prepare.js";
import {
  XiaohongshuLoginService,
  type XiaohongshuLoginServiceDependencies,
} from "../platforms/xiaohongshu/login-service.js";
import {
  XiaohongshuPrepareService,
  type XiaohongshuPrepareServiceDependencies,
} from "../platforms/xiaohongshu/prepare-service.js";
import {
  XiaohongshuPublishService,
  type XiaohongshuPublishServiceDependencies,
} from "../platforms/xiaohongshu/publish-service.js";
import { ActionRequestRepository } from "../storage/action-request-repository.js";
import { openDatabase } from "../storage/db.js";
import { EvidenceRepository } from "../storage/evidence-repository.js";
import { ExternalActionRepository } from "../storage/external-action-repository.js";
import { JobRepository } from "../storage/job-repository.js";
import {
  createApplication,
  type AgentPublisherApplication,
} from "./bootstrap.js";
import { JobProjectionEventBus } from "./job-events.js";
import { JobProjectionService } from "./job-projection.js";
import type { PrepublishMaterialSource } from "./prepublish-material-source.js";
import { XiaohongshuPrepublishOrchestrator } from "./xiaohongshu-prepublish-orchestrator.js";

export interface CreateMvpPrepublishApplicationOptions {
  readonly materialSource: PrepublishMaterialSource;
  readonly resolveAssetPath: AssetPathResolver;
  readonly databasePath?: string;
  readonly browserProvider?: BrowserProvider;
  readonly browserLiveViewUrl?: string;
  readonly fastify?: FastifyServerOptions;
  readonly xiaohongshu?: {
    readonly openEntry?: XiaohongshuLoginServiceDependencies["openEntry"];
    readonly inspectEntry?: XiaohongshuLoginServiceDependencies["inspectEntry"];
    readonly preparePage?: XiaohongshuPrepareServiceDependencies["preparePage"];
    readonly verifyPreparedPage?: XiaohongshuPrepareServiceDependencies["verifyPreparedPage"];
    readonly publishPage?: XiaohongshuPublishServiceDependencies["publishPage"];
    readonly verifyPublishResult?: XiaohongshuPublishServiceDependencies["verifyResult"];
  };
}

export interface MvpPrepublishRuntime {
  readonly jobs: JobRepository;
  readonly actionRequests: ActionRequestRepository;
  readonly externalActions: ExternalActionRepository;
  readonly evidence: EvidenceRepository;
  readonly projections: JobProjectionService;
  readonly events: JobProjectionEventBus;
  readonly orchestrator: XiaohongshuPrepublishOrchestrator;
}

export interface MvpPrepublishApplication extends AgentPublisherApplication {
  readonly runtime: MvpPrepublishRuntime;
}

export function createMvpPrepublishApplication(
  options: CreateMvpPrepublishApplicationOptions,
): MvpPrepublishApplication {
  const db = openDatabase(
    options.databasePath === undefined
      ? {}
      : { databasePath: options.databasePath },
  );
  const jobs = new JobRepository(db);
  const actionRequests = new ActionRequestRepository(db);
  const externalActions = new ExternalActionRepository(db);
  const evidence = new EvidenceRepository(db);
  const runInTransaction = <T>(work: () => T): T => db.transaction(work)();
  const jobControl = new JobControlService({
    jobs,
    actionRequests,
    runInTransaction,
  });
  const resume = new ResumeService({ jobs, actionRequests });
  const browserProvider =
    options.browserProvider ?? new DockerCdpBrowserProvider();

  const login = new XiaohongshuLoginService({
    jobs,
    actionRequests,
    control: jobControl,
    resume,
    ...(options.xiaohongshu?.openEntry === undefined
      ? {}
      : { openEntry: options.xiaohongshu.openEntry }),
    ...(options.xiaohongshu?.inspectEntry === undefined
      ? {}
      : { inspectEntry: options.xiaohongshu.inspectEntry }),
  });

  const prepare = new XiaohongshuPrepareService({
    jobs,
    actionRequests,
    jobControl,
    resolveAssetPath: options.resolveAssetPath,
    ...(options.xiaohongshu?.preparePage === undefined
      ? {}
      : { preparePage: options.xiaohongshu.preparePage }),
    ...(options.xiaohongshu?.verifyPreparedPage === undefined
      ? {}
      : { verifyPreparedPage: options.xiaohongshu.verifyPreparedPage }),
  });

  const publish = new XiaohongshuPublishService({
    jobs,
    actionRequests,
    jobControl,
    externalActions,
    evidence,
    ...(options.xiaohongshu?.publishPage === undefined
      ? {}
      : { publishPage: options.xiaohongshu.publishPage }),
    ...(options.xiaohongshu?.verifyPublishResult === undefined
      ? {}
      : { verifyResult: options.xiaohongshu.verifyPublishResult }),
  });

  const events = new JobProjectionEventBus();
  const projections = new JobProjectionService({
    jobs,
    actionRequests,
    evidence,
    ...(options.browserLiveViewUrl === undefined
      ? {}
      : { browserLiveViewUrl: options.browserLiveViewUrl }),
  });
  const orchestrator = new XiaohongshuPrepublishOrchestrator({
    jobs,
    actionRequests,
    browserProvider,
    login,
    prepare,
    publish,
    materialSource: options.materialSource,
    projections,
    events,
  });

  const sseConnections = new SseConnectionRegistry();
  const application = createApplication({
    dependencies: { sseConnections },
    routeModules: {
      jobs: createJobRoutes(orchestrator),
      events: createJobEventRoutes({
        events,
        projections,
        connections: sseConnections,
      }),
    },
    ...(options.fastify === undefined ? {} : { fastify: options.fastify }),
  });

  let stopped = false;

  return {
    server: application.server,
    dependencies: application.dependencies,
    runtime: {
      jobs,
      actionRequests,
      externalActions,
      evidence,
      projections,
      events,
      orchestrator,
    },
    start: application.start,
    stop: async () => {
      if (stopped) return;
      stopped = true;

      try {
        await application.stop();
      } finally {
        db.close();
      }
    },
  };
}
