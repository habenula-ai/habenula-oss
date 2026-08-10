# Agent Runtime

The agent runtime is the core orchestration layer: LLM conversation loop, tool call dispatch, and session state. The DO topology follows the OS model: one coordinator DO (kernel) per user, one worker DO (process) per agent.

## Durable Object Topology

### Coordinator DO (1 per user — the kernel)

The coordinator holds centralized, per-user state that must be serialized:

- Audit log with SHA-256 hash chain (must be serialized — inherent, not a bottleneck)
- Permission state and policy storage
- Tool registry cache
- Kill switch state
- Spending counters (DO SQLite — strongly consistent)
- Heartbeat tracking (DO alarms)
- `evaluatePolicy()` — governance evaluation

The coordinator does only lightweight work — microseconds per request. It never makes LLM calls, MCP calls, or holds conversation state.

### Worker DOs (1 per agent — processes)

Each accountable agent runs in its own worker DO:

- Conversation history (recent window)
- Active MCP session state and connections
- LLM calls (outbound, async)
- Pending confirmation requests (tool calls awaiting user approval)
- The LLM client for the deployment's configured provider

Workers RPC to the coordinator for governance checks. The tool call flow:

1. Worker receives LLM tool call response
2. Worker maps tool name through local tool registry cache
3. Worker RPCs to coordinator: `evaluatePolicy({ agent, service, verb, noun, toolName, params })`
4. Coordinator evaluates (pure function, <0.5ms) + writes audit entry (<0.5ms) → returns decision
5. Worker executes MCP call using Habenula-held credential (or holds for confirmation)

**Inter-DO RPC latency:** ~1-5ms (Cloudflare internal, same colo). Compared to LLM calls (1-5 seconds) and MCP calls (100ms+), this is noise.

**Hibernation:** Worker DOs hibernate independently — an idle agent costs nothing. The coordinator hibernates when no workers are making governance calls. 50 agents where 3 are active = 3 active workers + 1 coordinator = 4 active DOs. 47 hibernating workers cost zero.

### Single DO (current release)

The current release implements the coordinator/worker interface within a single DO. `evaluatePolicy()` and `writeAuditEntry()` are behind an interface from day one. The migration to separate DOs is:

1. Extract agent conversation loop into a Worker DO class
2. Extract governance + audit into a Coordinator DO class
3. Replace local function calls with RPC calls
4. The governance function and audit log are unchanged — they don't care where they run

### Agents SDK

Both DO classes extend the Agents SDK `Agent` base class, which provides:
- `addMcpServer()` — the SDK's MCP-client method; **unused by the engine** (built-ins run in-process — see §Tool Execution; the inbound MCP surfaces are hosted separately)
- `this.sql` — built-in SQLite for persistent structured data
- `this.state` / `this.setState()` — managed state with automatic persistence
- WebSocket hibernation (built-in, enabled by default)
- Scheduling (delay, specific time, cron)

**Hibernation footgun:** In-memory state is not reliable across hibernation — all persistent state must be written to DO SQLite before any await. See `docs/footguns.md`.

**DO upgrade behavior:** Deploying new Worker code disconnects all active WebSockets on both coordinator and worker DOs. Rolling upgrade + client reconnection strategy required. Coordinator and worker code deploy together atomically. See deployment documentation.

## LLM Provider Selection

The runtime is model-agnostic through a canonical request/response shape with per-provider adapters. The provider is chosen **per deployment**, from config — not per task, and not by any router. `readLLMConfig(env)` reads the deployment's `(provider, model, endpoint/credential)` tuple and `createLLMClient` builds the matching adapter. Two adapters cover every backend:

- **Anthropic** — the default (`claude-sonnet-4-6`).
- **OpenAI-compatible** — every non-Anthropic backend on the OpenAI inference-API shape: hosted OpenAI-API providers, gateways, and local runtimes (Ollama, vLLM, llama.cpp).

Selection is deployment-static: the whole deployment runs one provider, so a held turn always resumes under the provider that parked it. Misconfiguration fails loud at client construction — the runtime never silently falls back to another provider. Governance is a pure function of policy, independent of which model is selected.

## Accountable Agent Model

Each named agent is an **accountable agent** — a sandboxed runtime with explicit, scoped permissions. The current release runs a single agent in one session; the per-agent isolation, kill, and heartbeat below are the model the runtime is built for, and the per-agent forms arrive with the multi-agent split.

- **Isolation:** Each agent has its own session state, conversation history, and permission scope within the user's DO. No agent can access another agent's state.
- **No implicit access:** An agent starts with zero permissions. Every service, verb, and noun must be explicitly granted in its policy.
- **Noun-scoped resources:** An agent doesn't get "access to Gmail" — it gets "list access to `INBOX`." Nouns are matched as exact strings today, with no glob or pattern support, so breadth is an enumeration of concrete nouns. Permissions are `(agent, service, verb, noun)` tuples.
- **Kill:** `habenula kill` clears every grant to the deny-all floor. In the current release it stops all agents at once; scoped per-agent kill (`habenula kill <agent-name>`) arrives with the multi-agent split.
- **Session timeout:** The current release runs a single 90-minute session clock; session-scoped grants and held calls expire when it ends. Per-agent, configurable heartbeats — a dead man's switch that pushes a termination proposal and stops the agent absent renewal — arrive with the multi-agent split. See `docs/architecture/governance.md`.

This maps to OS process isolation: a process only accesses files and resources it has permissions for. An accountable agent only applies verbs to nouns it has been explicitly granted.

## Tool Execution

The built-in integrations are **Habenula-authored** and run **in-process**: each is a direct API client in `@habenula-ai/tools`, dispatched inside the user's DO. They are not MCP servers, and executing a tool is not an MCP round-trip. MCP is the protocol of the runtime's *inbound* surfaces — the commission and internal-drive endpoints — and the version the runtime pins (2025-11-25); see `docs/architecture/inbound-mcp.md` and `docs/footguns.md`. Connecting *outbound* to a third-party MCP server is planned, not shipped.

When the LLM returns a tool call, the DO — never the model — runs:

1. Extract the tool name and parameters from the LLM response.
2. **Registry lookup:** map the raw tool name to `(service, verb, noun)` through the Habenula-authored tool registry (see `docs/architecture/governance.md`). Integrations do not classify themselves.
3. **Governance evaluation:** `evaluatePolicy(policy, { agent, service, verb, noun, toolName, params })` — a pure, deterministic function.
4. On an allow, dispatch to the integration's executor with the one credential its service declared, resolved at execution time and discarded after the call.
5. Return the result to the DO and inject it into the LLM context inside the untrusted-content fence.

The DO never dispatches a tool call outside this path — a hard invariant. The LLM never sees the registry metadata, the verb classification, the noun extractor, or a raw credential.

**Third-party MCP servers (planned).** A future outbound path will let a user connect an external MCP server; its tools enter the same pipeline. Classification is the hard part: a server that declared its own `(service, verb, noun)` would be setting its own permission bits, so Habenula authors the mapping, and any unregistered tool is held to confirmation on every call. MCP 2025-11-25 `readOnly`/`destructive` tool annotations are authoring *hints* only, never authoritative — the Habenula tool registry is the single source of truth for verb-noun classification. Until that path ships, integrations are the in-process authored clients above.
