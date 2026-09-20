import {
  InMemoryCredentialStore,
  type Api,
  type Model,
} from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";

import {
  CONTENT_SECRETARY_ALLOWED_TOOLS,
  createContentSecretaryResourceLoader,
} from "./content-secretary.js";
import { PiAgentHost } from "./pi-agent-host.js";

export const PUBLISHER_AI_BASE_URL_ENV = "PUBLISHER_AI_BASE_URL";
export const PUBLISHER_AI_API_KEY_ENV = "PUBLISHER_AI_API_KEY";
export const PUBLISHER_AI_MODEL_ENV = "PUBLISHER_AI_MODEL";
export const PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID =
  "publisher-openai-compatible";

const DEFAULT_CONTEXT_WINDOW = 128_000;
const DEFAULT_MAX_TOKENS = 4_096;

export interface PublisherAiConfig {
  readonly baseUrl: string;
  readonly apiKey: string;
  readonly model: string;
}

export interface PublisherAiRuntimeSelection {
  readonly providerId: string;
  readonly model: Model<Api>;
  readonly modelRuntime: ModelRuntime;
}

export class PublisherAiConfigError extends Error {
  readonly code = "PUBLISHER_AI_CONFIG_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "PublisherAiConfigError";
  }
}

export class PublisherAiRuntimeError extends Error {
  readonly code = "PUBLISHER_AI_RUNTIME_INITIALIZATION_FAILED" as const;

  constructor(message: string) {
    super(message);
    this.name = "PublisherAiRuntimeError";
  }
}

function requiredEnvironmentValue(
  env: NodeJS.ProcessEnv,
  name: string,
  trim: boolean,
): string {
  const raw = env[name];
  if (raw === undefined || raw.trim().length === 0) {
    throw new PublisherAiConfigError(
      "Required Publisher AI environment variable " + name + " is missing or blank.",
    );
  }

  return trim ? raw.trim() : raw;
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized === "::1" ||
    normalized === "[::1]" ||
    normalized.startsWith("127.")
  );
}

function normalizeBaseUrl(raw: string): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new PublisherAiConfigError(
      PUBLISHER_AI_BASE_URL_ENV + " must be a valid absolute URL.",
    );
  }

  if (parsed.username || parsed.password) {
    throw new PublisherAiConfigError(
      PUBLISHER_AI_BASE_URL_ENV + " must not contain URL credentials.",
    );
  }

  if (parsed.search || parsed.hash) {
    throw new PublisherAiConfigError(
      PUBLISHER_AI_BASE_URL_ENV + " must not contain a query string or fragment.",
    );
  }

  const isHttps = parsed.protocol === "https:";
  const isLocalHttp =
    parsed.protocol === "http:" && isLoopbackHostname(parsed.hostname);

  if (!isHttps && !isLocalHttp) {
    throw new PublisherAiConfigError(
      PUBLISHER_AI_BASE_URL_ENV +
        " must use HTTPS unless the endpoint is an explicit loopback address.",
    );
  }

  parsed.pathname = parsed.pathname.replace(/\/+$/, "") || "/";
  const normalized = parsed.toString();
  return normalized.endsWith("/") ? normalized.slice(0, -1) : normalized;
}

export function readPublisherAiConfig(
  env: NodeJS.ProcessEnv = process.env,
): PublisherAiConfig {
  const baseUrl = normalizeBaseUrl(
    requiredEnvironmentValue(env, PUBLISHER_AI_BASE_URL_ENV, true),
  );
  const apiKey = requiredEnvironmentValue(env, PUBLISHER_AI_API_KEY_ENV, false);
  const model = requiredEnvironmentValue(env, PUBLISHER_AI_MODEL_ENV, true);

  return { baseUrl, apiKey, model };
}

export function redactPublisherAiSecret(
  message: string,
  apiKey: string | undefined,
): string {
  if (!apiKey) return message;
  return message.split(apiKey).join("[REDACTED]");
}

export async function createPublisherAiRuntime(
  config: PublisherAiConfig,
): Promise<PublisherAiRuntimeSelection> {
  let modelRuntime: ModelRuntime;

  try {
    modelRuntime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      refreshOnCreate: false,
      allowModelNetwork: false,
    });

    modelRuntime.registerProvider(PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID, {
      name: "Publisher OpenAI-compatible",
      baseUrl: config.baseUrl,
      api: "openai-completions",
      models: [
        {
          id: config.model,
          name: config.model,
          reasoning: false,
          input: ["text"],
          cost: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
          },
          contextWindow: DEFAULT_CONTEXT_WINDOW,
          maxTokens: DEFAULT_MAX_TOKENS,
          compat: {
            supportsDeveloperRole: false,
            supportsReasoningEffort: false,
          },
        },
      ],
    });

    await modelRuntime.setRuntimeApiKey(
      PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
      config.apiKey,
    );
  } catch {
    throw new PublisherAiRuntimeError(
      "Publisher AI runtime could not initialize the configured OpenAI-compatible provider.",
    );
  }

  const model = modelRuntime.getModel(
    PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
    config.model,
  );
  if (!model) {
    throw new PublisherAiRuntimeError(
      "Publisher AI runtime did not expose the configured model.",
    );
  }

  return {
    providerId: PUBLISHER_OPENAI_COMPATIBLE_PROVIDER_ID,
    model,
    modelRuntime,
  };
}

export interface PublisherContentSecretaryHostOptions {
  readonly sessionDirectory: string;
  readonly cwd?: string;
  readonly defaultRunTimeoutMs?: number;
  readonly defaultAbortTimeoutMs?: number;
  readonly defaultDisposeTimeoutMs?: number;
}

export function createPublisherContentSecretaryHost(
  runtime: PublisherAiRuntimeSelection,
  options: PublisherContentSecretaryHostOptions,
): PiAgentHost {
  if (options.sessionDirectory.trim().length === 0) {
    throw new PublisherAiConfigError(
      "Content Secretary runtime requires a non-empty session directory.",
    );
  }

  return new PiAgentHost({
    model: runtime.model,
    modelRuntime: runtime.modelRuntime,
    sessionDirectory: options.sessionDirectory,
    defaultRunTimeoutMs: options.defaultRunTimeoutMs ?? 120_000,
    defaultAbortTimeoutMs: options.defaultAbortTimeoutMs ?? 5_000,
    defaultDisposeTimeoutMs: options.defaultDisposeTimeoutMs ?? 5_000,
    tools: CONTENT_SECRETARY_ALLOWED_TOOLS,
    sessionOptions: { thinkingLevel: "off" },
    createResourceLoader: createContentSecretaryResourceLoader,
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
  });
}
