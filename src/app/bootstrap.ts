import type {
  FastifyInstance,
  FastifyListenOptions,
  FastifyServerOptions,
} from "fastify";

import {
  createApiServer,
  type ApiRouteModules,
} from "../api/server.js";
import { SseConnectionRegistry } from "../api/sse.js";

export interface ApplicationDependencies {
  readonly sseConnections: SseConnectionRegistry;
}

export interface CreateApplicationOptions {
  readonly dependencies?: ApplicationDependencies;
  readonly routeModules?: ApiRouteModules;
  readonly fastify?: FastifyServerOptions;
}

export interface AgentPublisherApplication {
  readonly server: FastifyInstance;
  readonly dependencies: ApplicationDependencies;
  start(options?: FastifyListenOptions): Promise<string>;
  stop(): Promise<void>;
}

export function createApplication(
  options: CreateApplicationOptions = {},
): AgentPublisherApplication {
  const dependencies =
    options.dependencies ??
    ({
      sseConnections: new SseConnectionRegistry(),
    } satisfies ApplicationDependencies);

  const server = createApiServer({
    sseConnections: dependencies.sseConnections,
    ...(options.routeModules === undefined
      ? {}
      : { routeModules: options.routeModules }),
    ...(options.fastify === undefined ? {} : { fastify: options.fastify }),
  });

  return {
    server,
    dependencies,
    start: async (listenOptions = { host: "127.0.0.1", port: 3000 }) =>
      server.listen(listenOptions),
    stop: async () => {
      await server.close();
    },
  };
}
