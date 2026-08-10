# Session Lifecycle

A session is the unit of governance continuity: one grant scope and one expiry clock. Session-scoped permissions ("For this task" confirmations) live exactly as long as their session, and every held call is governed by the same clock. This doc covers how sessions start, how work attaches to them, and how they end.

**The current release runs at most one active session per user.** The per-user Durable Object owns it and is the source of truth: the active session is the single `session_state` row with `ended_at IS NULL`. This is deliberate policy standing in for per-agent isolation — the capacity for concurrent sessions arrives with the coordinator/worker DO split in a later release. The lifecycle operations below are durable primitives that generalize into `agent start` / `agent stop` / `agent status` at that split; only the refuse-if-active rule is a current-release policy.

## The DO derives the session

No HTTP caller chooses or supplies a session id. Every entry point (`/api/chat`, `/api/tools/execute`) resolves the active session inside the DO — attach if one exists, lazily create if none. This is what makes a "for this session" grant approved on one message authorize the same action on the next: both requests resolve to the same session, so the grant's `session_id` matches.

Two mechanics carry the single-active invariant:

- **A synchronous derive region.** Nothing at the database level caps un-ended rows — the invariant holds because the "is there an active session?" read and the create run in one `transactionSync` with no intervening `await`. A Durable Object interleaves requests only at await points, so the gap-free region makes two near-simultaneous first calls resolve to one row. The derive also reaps expired sessions first, so it can never attach to a session past its lifetime.
- **A tie-break that leaves evidence.** If more than one un-ended row is ever observed (an invariant break), the newest wins and every other open row is closed with a `session.end` audit event (reason `superseded`) and a sweep of its held calls. The tie-break is a detector, not a silent repair — a `superseded` event in the audit log means the invariant broke.

## Lifecycle operations

| Operation | Route | Behavior |
|---|---|---|
| Start | `POST /api/session/start` | The interactive launch's handshake. Creates the session, or **refuses** if one is active — `409` carrying `{ status: "refused", activeSession }`. The refusal means no second session was *created*; the client attaches to the named session rather than being locked out. |
| Attach | `POST /api/chat`, `POST /api/tools/execute` | No session id in the body. The DO derives the active session (creating one lazily if none), so direct API use is never bricked. (`/api/tools/execute` is a debug surface — it serves 404 unless the engine runs with `DEBUG_MODE=true`.) |
| End | `POST /api/session/quit` | Explicit end (`habenula quit` / `:quit`). Idempotent — `{ ended: false }` when nothing is active. |
| Read | `GET /api/session` | `{ active: { sessionId, startedAt, expiry } | null }`. Expired sessions are reaped before reporting, so a timed-out session is never shown as active. |

## Session end

A session ends by exactly one of four paths, and every path keeps the same symmetry: sweep the session's held calls to terminal audit outcomes, write one `session.end` audit event, stamp `ended_at`.

| Path | Trigger | `session.end` reason | Stamped at |
|---|---|---|---|
| Quit | `POST /api/session/quit` | `quit` | now |
| Timeout | Lazy reaper on next DO activity, once `started_at + 90 min` passes | `timeout` | the effective expiry instant, not wake time |
| Kill | `habenula kill` (deny-all) | `kill` | now |
| Superseded | The derive's tie-break closing a stale open row | `superseded` | now |

The reason lives in the audit entry's `error_message` field — distinguish end paths by `tool_name = 'session.end'` + `error_message`, never by `outcome`.

Details that keep the end paths honest:

- **The held-call sweep is load-bearing.** Without it, a call parked awaiting confirmation would stay approvable after its session died — and approving it would execute against a dead session's scope. Every end path sweeps.
- **Mid-resolve calls are not falsified.** If a held call is already mid-resolve when a sweep runs (the user approved it and the tool dispatched), the sweep deletes the row but does not write the timeout outcome — the resolve path owns that call's real result. Closing it as "denied" would record a false denial for a call that executed. The site-level `turn_state` check is what prevents that, and it is the only thing that covers the whole case. Behind it, every sweep write passes through the closer write on an *inferred* basis and is skipped whenever a closer already exists, so a sweep path that forgot the check still cannot overwrite a recorded disposition. That backstop is narrower than the check: a call that dispatched and crashed before its outcome landed has no closer yet, so the skip does not fire and the site-level check is what keeps the sweep off it.
- **The conversation is repaired, not wedged.** A sweep resolves a parked call's audit side but cannot reach the in-memory conversation, which still ends with the model's unanswered tool-use block — a shape the LLM API rejects. The next chat turn answers any such orphan with a synthetic error tool result before running, asserting only what is known (the result was not recorded; the call may or may not have executed — the audit log holds the truth).
- **`quit` is best-effort; the timeout is authoritative.** A client can crash without quitting. The 90-minute clock, anchored at the session's recorded start, is the dead-man's-switch backstop, consistent with the heartbeat posture.

## Grants and the session clock

Session-scoped policy entries all share one expiry: `session_state.started_at + 90 min`. There is no per-grant drift and no per-call clock — see [governance.md](governance.md) for how grants are minted through the confirmation flow. When the session ends by any path, its grants are dead with it (expiry for timeout; the deny-all sweep for kill; scope mismatch for anything resolved later).

## CLI surface

Exit and quit are different verbs:

- `:exit` / `.exit` / Ctrl-D — **detach**. The CLI leaves; the session survives. A returning launch re-attaches via the handshake and prints a notice with the session's age and remaining time.
- `:quit` / `.quit` / `habenula quit` — **end**. The session closes, grants expire, and the slot frees. The top-level command works from any terminal, so a stuck slot is recoverable without entering the REPL.

`habenula status` leads with the active session (id, age, remaining time) or "No active session." Age is the concurrency-awareness signal: a session that started 40 minutes ago when you sat down 2 minutes ago means another client is attached.

## Trust posture (current release)

The guarantee is "no second session is *created*" — not client isolation. All entry points attach to the one active session, so two clients (or an inbound commission) share its grant scope and conversation context. The current release is single-user on a local deployment: terminal access equals full inheritance of the active session's grants. Per-client identity and per-session conversation isolation arrive with the coordinator/worker split in a later release, which also lifts the single-session constraint itself.
