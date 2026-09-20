import {
  JobNotFoundError,
  type Job,
  type JobRepository,
} from "../contracts/job.js";
import type {
  AgentDefinition,
  AgentSessionScope,
} from "./definition.js";
import type { AgentHost, PublisherAgentSession } from "./host.js";
import { buildPublisherJobContext } from "./job-context.js";
import {
  AgentSessionBindingConflictError,
  AgentSessionBindingMismatchError,
  AgentSessionBindingNotFoundError,
  type AgentSessionBinding,
  type AgentSessionBindingRepository,
} from "./job-session-binding.js";

export interface JobAgentSessionInput {
  readonly jobId: string;
  readonly role: string;
  readonly definition: AgentDefinition;
}

export class JobAgentSessionService {
  readonly #jobs: Pick<JobRepository, "getById">;
  readonly #bindings: AgentSessionBindingRepository;
  readonly #host: AgentHost;

  constructor(dependencies: {
    readonly jobs: Pick<JobRepository, "getById">;
    readonly bindings: AgentSessionBindingRepository;
    readonly host: AgentHost;
  }) {
    this.#jobs = dependencies.jobs;
    this.#bindings = dependencies.bindings;
    this.#host = dependencies.host;
  }

  async create(input: JobAgentSessionInput): Promise<PublisherAgentSession> {
    const job = this.#requireJob(input.jobId);
    const scope = this.#scope(input);

    const existing = this.#bindings.getForScope(scope);
    if (existing) {
      throw new AgentSessionBindingConflictError(
        `Job ${scope.jobId} role ${scope.role} is already bound to ${existing.sessionRef}`,
      );
    }

    const session = await this.#host.createSession({
      definition: input.definition,
      scope,
      context: buildPublisherJobContext(job, scope.role),
    });

    try {
      this.#bindings.bind({
        scope,
        definitionId: input.definition.id,
        sessionRef: session.ref,
      });
    } catch (error) {
      await session.dispose();
      throw error;
    }

    return session;
  }

  async resume(input: JobAgentSessionInput): Promise<PublisherAgentSession> {
    const job = this.#requireJob(input.jobId);
    const scope = this.#scope(input);
    const binding = this.#bindings.getForScope(scope);

    if (!binding) {
      throw new AgentSessionBindingNotFoundError(scope);
    }

    this.#assertBinding(binding, scope, input.definition);

    return this.#host.resumeSession({
      definition: input.definition,
      scope,
      ref: binding.sessionRef,
      context: buildPublisherJobContext(job, scope.role),
    });
  }

  #scope(input: JobAgentSessionInput): AgentSessionScope {
    if (input.role.trim().length === 0) {
      throw new AgentSessionBindingMismatchError("Agent session role must not be empty");
    }

    return { jobId: input.jobId, role: input.role };
  }

  #requireJob(jobId: string): Job {
    const job = this.#jobs.getById(jobId);
    if (!job) {
      throw new JobNotFoundError(jobId);
    }
    return job;
  }

  #assertBinding(
    binding: AgentSessionBinding,
    scope: AgentSessionScope,
    definition: AgentDefinition,
  ): void {
    if (binding.jobId !== scope.jobId || binding.role !== scope.role) {
      throw new AgentSessionBindingMismatchError(
        `AgentSession ${binding.sessionRef} is bound to ${binding.jobId}/${binding.role}, not ${scope.jobId}/${scope.role}`,
      );
    }
    if (binding.definitionId !== definition.id) {
      throw new AgentSessionBindingMismatchError(
        `AgentSession ${binding.sessionRef} was created for definition ${binding.definitionId}, not ${definition.id}`,
      );
    }
  }
}
