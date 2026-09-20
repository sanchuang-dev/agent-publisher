# Pi Ecosystem Evaluation for Agent Publisher

Status: architecture research baseline  
Date: 2026-09-20  
Scope: Pi ecosystem reuse for Agent Publisher; not an implementation claim

## 1. Why this evaluation exists

Agent Publisher already has durable job/checkpoint storage, human ActionRequest handling, BrowserProvider abstractions, visible browser runtime, and material contracts. The next engineering phase introduces model-driven content work and bounded browser recovery.

The main risk is not whether an LLM can call a tool. The risk is accidentally rebuilding an agent harness around a thin `AgentRuntime.start/resume/cancel` adapter while Pi already provides session lifecycle, resource loading, tools, skills, extensions, compaction, model runtime, and event handling.

This evaluation asks:

1. which Pi layer should Publisher embed;
2. how reusable agent definitions should be represented;
3. how Tools, Skills, MCP, context, sessions, and resume should map into Publisher;
4. which state remains Publisher-owned;
5. what must be proven in-project before the design becomes implementation baseline.

## 2. Current Publisher reality

Current `dev` already owns business durability:

- SQLite is the execution/resume source of truth;
- JobRepository persists checkpoints;
- ActionRequest represents login / approval / clarification pauses;
- the Orchestrator is intended to own phase transitions and retry policy;
- publication is an irreversible side effect with explicit approval and publish-once semantics;
- BrowserProvider and PlatformPublisher are product boundaries, not generic agent tools.

These are product-domain invariants. They should not move into Pi session state.

The current Agent design is comparatively thin:

```ts
interface AgentRuntime {
  start(input: AgentRunInput): Promise<AgentRunResult>;
  resume(runId: string, input?: AgentResumeInput): Promise<AgentRunResult>;
  cancel(runId: string): Promise<void>;
}
```

That abstraction is replaceable, but it hides so much of Pi that Publisher would likely have to rebuild session configuration, skill discovery, tool lifecycle, context loading, MCP bridging, and resource policy outside the framework.

## 3. Pi layers considered

### 3.1 `@earendil-works/pi-agent-core`

Pi Agent Core provides the low-level stateful agent loop, tool execution, events, and interception points.

It is a good primitive, but using only Agent Core means Publisher must compose more of the harness itself.

### 3.2 `@earendil-works/pi-coding-agent` SDK

Despite the package name, the SDK is explicitly embeddable. Its `createAgentSession()` API accepts explicit models, tools, ResourceLoader, SessionManager, SettingsManager, ModelRuntime, extensions, and skills.

The SDK also exposes reusable session-service factories such as `createAgentSessionServices()` / `createAgentSessionFromServices()`, which fit a host that reuses configuration/runtime services while creating isolated sessions.

For Publisher, the coding-specific CLI behavior is not the product. The reusable harness facilities are.

**Research conclusion:** evaluate `pi-coding-agent` SDK as the MVP harness baseline before implementing a custom harness around `pi-agent-core`.

## 4. Agent object model

The reusable unit should be an **AgentDefinition**, not a singleton long-lived conversation.

Conceptually:

```ts
interface AgentDefinition {
  id: string;
  model: ModelPolicy;
  systemPrompt: SystemPromptProvider;
  skills: SkillSource[];
  tools: ToolProfile;
  mcp?: McpProfile[];
  context?: ContextProvider[];
  settings?: AgentSettings;
  session?: SessionPolicy;
}
```

A process-level `PiAgentHost` compiles/owns reusable runtime resources and creates Pi AgentSessions:

```text
AgentDefinition
      ↓
PiAgentHost.createSession(...)
      ↓
Pi AgentSession
```

The API may feel like creating a new configured agent object, but initialization should remain asynchronous because model/runtime/resource/session setup is asynchronous.

### Reuse boundary

Reuse across jobs:

- AgentDefinition;
- ModelRuntime where safe;
- controlled ResourceLoader/services;
- tool factories;
- skill resources;
- MCP profiles/configuration.

Do not reuse across unrelated jobs:

- conversation transcript;
- dynamic job context;
- temporary tool grants;
- browser observations;
- task-specific MCP state unless explicitly designed for it.

Recommended session scope is `job + role` (or narrower helper-task scope).

## 5. Multiple sessions are not a multi-agent organization

Publisher may create more than two AgentSession instances:

- Content Secretary session;
- Publishing Secretary session;
- bounded Browser Recovery helper session;
- future specialized helper sessions if evidence justifies them.

This does not imply autonomous peer-to-peer multi-agent orchestration.

The control model remains:

```text
                 Publisher Orchestrator
                 /        |          \
        Content Session  Publish Session  Recovery Session
```

The Orchestrator creates/calls/resumes/disposes sessions and owns business transitions. Agent sessions do not delegate the Publish Job among themselves or decide business completion.

## 6. Skills

Pi Coding Agent already supports skills through ResourceLoader. Agent Skills use a standard `SKILL.md` representation and progressive disclosure.

Publisher should therefore not invent a separate SkillRegistry/schema for the MVP.

Expected repository shape can remain simple:

```text
skills/
├─ content-planning/
│  └─ SKILL.md
├─ xiaohongshu-copy/
│  └─ SKILL.md
└─ browser-recovery/
   └─ SKILL.md
```

### Important Publisher-specific issue

Pi's normal environment can discover resources from user/project Pi directories. That is convenient for a local coding agent but is unsafe as an ambient dependency for a server product.

Publisher must use **explicit resources / controlled discovery**, not inherit arbitrary `~/.pi`, project extensions, skills, settings, or context from the machine running the service.

The Pi SDK includes a full-control ResourceLoader pattern where no discovery occurs unless supplied explicitly. That pattern is a better Publisher baseline.

### Skill loading and read access

Progressive skill loading can depend on read access. Publisher must not solve this by enabling unrestricted filesystem tools.

The implementation work must prove one of:

- a restricted read tool that can read approved skill/job-workspace paths only; or
- host-controlled loading/injection for mandatory skills.

Critical workflow rules must not depend solely on the model deciding to load an optional skill.

## 7. Tools

Pi already owns tool registration/execution and supports:

- explicit built-in tool selection;
- disabling all built-ins;
- custom tools via extensions;
- tool-call interception/blocking.

Publisher should not build a generic ToolRegistry unless a proven gap remains after integration.

Use two controls:

1. **visibility:** an AgentSession receives only the tools it should know;
2. **execution guard:** sensitive tools are checked again at tool-call time.

Publication itself should remain outside the Agent tool surface. The irreversible flow is still:

```text
resolved approval
  ↓
Publisher Orchestrator
  ↓
external_actions
  ↓
PlatformPublisher.publish()
```

This makes prompt injection unable to discover a generic `publish` tool because that tool does not exist in the agent session.

## 8. MCP

Pi core intentionally does not need to become a universal MCP runtime. MCP can be integrated through extensions/adapters.

The community `pi-mcp-adapter` currently provides capabilities that would otherwise be costly to rebuild, including transport handling, tool discovery, include/exclude filters, lazy server startup, metadata caching, direct/proxy tools, and OAuth-related flows.

It is a **third-party dependency**, not a Pi core guarantee. It must pass Publisher's in-project evaluation before becoming a production baseline.

Recommended shape:

```text
Publisher-owned MCP profile
      ↓
Pi MCP extension/adapter
      ↓
MCP servers
      ↓
Pi tool surface
```

Publisher should own configuration and allowlists. It should not inherit arbitrary developer-machine MCP configuration.

For large MCP catalogs, proxy/search activation is preferable to placing every MCP schema in every prompt.

The implementation work must measure per-session server lifecycle. If the adapter starts independent stdio servers per AgentSession, that is acceptable for the MVP only if bounded and explicit.

### Publisher integration baseline (AGT-04)

Publisher pins `pi-mcp-adapter@2.34.0` and creates it only through
`createMcpAdapter({ config })`. The config is compiled from the
`AgentDefinition.mcp` profile for each AgentSession, so Publisher does not read
developer-machine `.mcp.json`, `~/.pi`, host MCP imports, or adapter management
state.

The MVP surface is deliberately proxy-first:

- only the adapter's `mcp` gateway tool is activated;
- every server must declare a non-empty `includeTools` fail-closed allowlist;
- `excludeTools` may narrow that allowlist further;
- direct tools, namespace proxy tools, and MCP script mode are disabled;
- stdio environment and HTTP credential headers can be sourced by environment
  variable name rather than committed secret values.

Lifecycle remains AgentSession-scoped. Two sessions that reference the same
stdio profile are expected to own two independent child processes; Publisher
does not add a shared MCP multiplexer. Because Pi's bare `AgentSession.dispose()`
does not emit extension shutdown, `PiAgentHost` must emit
`session_shutdown` before disposing the Pi session. Teardown is bounded and an
explicit dispose failure is surfaced as an AgentSession error.

The AGT-04 integration tests use controlled stdio and Streamable HTTP fixtures
to cover discovery, invocation, negative allowlisting, per-session process
isolation/disposal, unavailable-server containment, and invalid-profile
fail-closed behavior.

## 9. Context model

Do not introduce a generic ContextManager until a concrete gap exists.

Map context to existing Pi/Publisher mechanisms:

| Context | Owner / mechanism |
| --- | --- |
| role responsibility | controlled system prompt |
| stable working instructions | system prompt / mandatory skill |
| platform knowledge | Skill |
| Job brief / mode | session dynamic context |
| material state | dynamic context / tool result |
| browser observation | browser inspect tool result |
| external knowledge | MCP result |
| conversation history | Pi AgentSession |
| compaction | Pi |
| Job lifecycle / checkpoint | Publisher SQLite only |

Pi transcript can inform a run, but it is never the source of truth for whether a real publication or business transition occurred.

## 10. Session persistence and business persistence

Keep two persistence domains:

```text
Pi session
= agent transcript, context continuity, model-facing history

Publisher job
= actual business state, checkpoints, ActionRequests,
  approvals, external_actions, evidence
```

A restart may restore both, but a restored AgentSession does not advance the Job by itself.

Current Publisher JobRepository should not be replaced by Pi session/durable storage merely for reuse.

## 11. HTTP / application framework

The project still needs a small Node application surface for HTTP + SSE. Fastify 5 is the selected baseline:

- mature Node server framework;
- compatible with the project's Node 22 baseline;
- explicit plugin/lifecycle model;
- schema-oriented API surface;
- no need for a heavier application framework or DI container.

This is independent from Pi. Fastify hosts the application; Pi hosts model-driven sessions.

## 12. Proposed Publisher-owned abstractions

Keep custom abstractions intentionally thin.

### `AgentDefinition`

Reusable configuration for a class of agent work.

### `PiAgentHost`

Process-level integration boundary responsible for:

- creating/resuming/disposal of sessions;
- controlled Pi ResourceLoader/services;
- model/runtime wiring;
- tool/skill/MCP profile compilation;
- Pi-version compatibility isolation.

### `AgentSessionRef`

Opaque Publisher reference to resume the correct Pi session for a Job/role.

Do not create generic Publisher implementations of:

- Agent loop;
- SkillRegistry;
- ToolRegistry;
- MCP transport/runtime;
- session transcript storage;
- model provider abstraction;
- context compaction;

unless the in-project evaluation proves Pi cannot provide the needed behavior.

## 13. Implementation timing

The harness foundation should start **before** the old AgentRuntime design or real model/MCP features are implemented.

It may run in parallel with:

- Browser runtime acceptance;
- platform capability research;
- deterministic Xiaohongshu work.

It should precede:

- implementation of Issue #7's old `start/resume/cancel` adapter shape;
- a custom SkillRegistry / ToolRegistry / McpManager;
- model/session logic embedded directly into Material Providers;
- agent-driven browser recovery.

This moves **agent infrastructure** earlier without moving **agent autonomy** earlier.

## 14. Required in-project proof

The design is intentionally evidence-seeking. Mergeable implementation slices should prove:

1. Pi SDK can be embedded without CLI assumptions;
2. one AgentDefinition can create isolated sessions;
3. process restart/resume semantics are compatible with Publisher;
4. resource loading can be fully controlled with no ambient user-machine discovery;
5. Skills work with restricted file access;
6. tool allowlisting and execution blocking work at the real boundary;
7. job context does not leak across sessions;
8. MCP can be configured programmatically per definition/session;
9. MCP lifecycle is bounded and observable;
10. the resulting code is clean enough to remain on `dev`, not disposable spike code.

## 15. Decisions and open questions

### Accepted architecture direction

- Pi ecosystem is the preferred MVP harness.
- Evaluate the full `pi-coding-agent` SDK before building around only Agent Core.
- AgentDefinition is reusable; AgentSession is isolated by job/role/helper task.
- One Publisher Orchestrator owns workflow state.
- Skills use the existing Pi / Agent Skills mechanism.
- Tools use Pi registration/selection/interception.
- MCP should first reuse a mature adapter rather than a custom runtime.
- Publisher Job/checkpoint/approval/publish-once remain independent from Pi session state.
- no irreversible publish tool is exposed to the model.

### Must be proven before hardening

- exact Pi package/version and Node engine floor;
- controlled ResourceLoader implementation shape;
- restricted skill loading behavior;
- Pi session persistence/resume storage choice;
- suitability and operational behavior of `pi-mcp-adapter`;
- whether shared MCP process multiplexing is needed later.

## 16. Primary sources reviewed

Pi official repository / SDK:

- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/sdk.md
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/sdk.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/04-skills.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/05-tools.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/06-extensions.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/sdk/12-full-control.ts
- https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/security.md

MCP adapter evaluated as a third-party candidate:

- https://github.com/nicobailon/pi-mcp-adapter

Fastify baseline:

- https://fastify.dev/docs/latest/
- https://fastify.dev/docs/v5.6.x/Guides/Migration-Guide-V5/

## 17. Final recommendation

Do not build a Publisher-specific agent framework.

Build a small, high-quality Publisher integration layer that answers:

> Which configured Pi agent session should exist for this Job, what resources may it see, what tools may it execute, and how does its result return to the Publisher-owned workflow?

Everything else should be delegated to mature Pi/MCP ecosystem components when they pass the project's own evidence bar.
