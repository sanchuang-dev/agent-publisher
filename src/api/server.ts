import Fastify, {
  type FastifyInstance,
  type FastifyPluginAsync,
  type FastifyServerOptions,
} from "fastify";

import { createSseFixtureRoutes } from "./routes/events-fixture.js";
import { healthRoutes } from "./routes/health.js";
import type { SseConnectionRegistry } from "./sse.js";

export interface ApiRouteModules {
  readonly jobs?: FastifyPluginAsync;
  readonly actions?: FastifyPluginAsync;
  readonly profiles?: FastifyPluginAsync;
  readonly events?: FastifyPluginAsync;
}

export interface CreateApiServerOptions {
  readonly sseConnections: SseConnectionRegistry;
  readonly routeModules?: ApiRouteModules;
  readonly fastify?: FastifyServerOptions;
}

function registerOptionalApiModules(
  server: FastifyInstance,
  modules: ApiRouteModules,
): void {
  const plugins = [
    modules.jobs,
    modules.actions,
    modules.profiles,
    modules.events,
  ];

  for (const plugin of plugins) {
    if (plugin !== undefined) {
      server.register(plugin, { prefix: "/api" });
    }
  }
}

export function createApiServer(options: CreateApiServerOptions): FastifyInstance {
  const server = Fastify(options.fastify);

  server.addHook("preClose", async () => {
    await options.sseConnections.closeAll();
  });

  server.register(healthRoutes);
  server.register(createSseFixtureRoutes(options.sseConnections), {
    prefix: "/api",
  });
  registerOptionalApiModules(server, options.routeModules ?? {});

  return server;
}
