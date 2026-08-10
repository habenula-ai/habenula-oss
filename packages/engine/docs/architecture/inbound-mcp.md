# Inbound MCP: the commission surface

Habenula's MCP role is bidirectional. Downstream it is the host, calling tool
service providers under governance. Upstream — this document — it exposes one
inbound seam at `/mcp` on the engine Worker: an external agent (a coding agent
such as Claude Code or Cursor) **commissions a goal** and learns whether it
succeeded. It never discovers, names, or calls Habenula's tools.

## The closed surface

`/mcp` speaks MCP over Streamable HTTP, served Worker-level per request — no
Durable Object of its own; every piece of commission state lives in the user's
DO. Exactly six tools are registered:

| Verb | Purpose |
|------|---------|
| `habenula_commission` | Submit a goal (intent in the client's words) + an optional `data` map |
| `habenula_status` | Liveness: `{ running, version }` |
| `habenula_result` | Run status by handle — metadata only in this release, not the work product (governed content-return to commissioners is planned) |
| `habenula_provide` | Supply the data-slot value(s) a task awaits, resuming a run parked on missing input — input-only, never a tool call |
| `habenula_cancel` | Cancel a commissioned task by handle, sweeping the holds it owns — it cannot touch the user's own tasks, approve, or reach a tool |
| `habenula_amend` | Persist corrected data-slot value(s); input-only and does not resume — `habenula_provide` is what answers and resumes |

Awareness comes from the read-only `habenula://capabilities` **resource**:
every catalog service with its connection state, verb classes, and published
data slots. Informational, not invocable — the interface a client could drive
is never advertised, because tool selection (the intent→action mapping, the
highest-leverage injection surface) happens only inside the governed runtime.
The property is non-invocability, not secrecy: internal tool names are
trivially reconstructible from `service` + `verb`, and that is harmless —
nothing reconstructed is callable here.

## Two enforcement points, not one

Registration bounds what this surface offers. It is not the whole enforcement,
because the commissioned goal is the one input an outside agent writes, and a
model told to call a tool can emit a name it was never offered. So the runtime
enforces the same bound a second time, on the way back.

Habenula's own control operations — `kill`, `disconnect`, `quit`, and the
`status` and policy reads — are governed tools, reachable only from the trusted
internal drive interface (`/internal/mcp`). A commissioned run is never offered
them. If its model names one anyway, the engine refuses the call at dispatch. It
does not hold the call for the user to approve: no answer to that question could
be right, and asking it would make the user the last line of a boundary the
engine keeps. The refused attempt is recorded in the audit log as a denial that
names the reason, so the attempt is visible afterwards.

The agent is told the boundary refused the call. It is not told that a policy
denied it. There is no policy to change here, and no grant that would make the
call allowed, so a policy reason would send the agent back to the user for
permission that must never be given.

The client is told the same thing, and for the same reason. A refused call
carries its own tool-call outcome, `boundary_refused`, rather than sharing
`denied` with a policy refusal. The two differ in the only way a client cares
about: a policy deny can become a grant, and this one cannot. A client that
reads them as one outcome tells the user to wait for a confirmation the engine
will never offer — which is the question this boundary exists to refuse rather
than ask.

The same rule binds the local API. Running on your own machine is not
authorization to operate Habenula, so the direct chat and tool-execute routes
reach no control operation either.

## The data map: fidelity, not trust

`habenula_commission` takes `{ goal, data? }`. Keys of `data` must come from
the **published slot vocabulary** (each tool's curated `dataSlots`); an
unknown key is rejected at the boundary naming the vocabulary. A tool
parameter whose whole value is `{{data.<key>}}` is substituted engine-side
*before* noun extraction, governance, and audit — on both the conversation
loop and the confirmation-resolve path — so a client-held literal never
round-trips through the model. Binding is a fidelity property, not a trust
property: the values are client-authored and stay untrusted; governance, the
audit log, and the confirmation prompt all evaluate the substituted real
value.

## Run lifecycle

A commission attaches to the user's single active session (creating one if
none is active — its `session.start` is origin-tagged) and runs as a normal
governed turn. The `commission_runs` record is the stable handle across
holds: `running → awaiting_confirmation ⇄ running → completed | failed |
denied | expired`. Terminal statuses are computed from the run-cumulative
per-action outcomes; terminal writes are absorbing (a quit/kill/read-time
`expired` landing mid-turn is never overwritten). Read-time expiry on
`habenula_result` is the load-bearing guard: a run can never report
awaiting-confirmation against a dead session, even if a best-effort sweep was
lost. One unresolved commission at a time; further commissions return `busy`.

## Turn serialization

An in-memory turn-in-flight marker serializes the conversation loop across
every origin — chat, commission, and confirmation-resume all mutate the one
shared buffer. A second turn-start (or a concurrent second resolve) is
refused: `busy` on the commission surface, HTTP 409 with
`error_code: "TURN_IN_PROGRESS"` on `/api/chat` and `/api/resolve`. The
marker is deliberately in-memory: a crash kills the turn with the flag, so a
fresh instance booting clear is the truth — a persisted flag would wedge the
DO permanently.

## Provenance

Every audit entry carries `origin` (`human` | `mcp_commission`), and origin
joins the hash-chain input, so provenance is tamper-evident. Origin marks the
initiator of the recorded event: commissioned actions and their terminal
entries (including sweep-side closures) carry `mcp_commission`;
`session.start` is tagged by whoever established the session; `session.end`
stays `human`. The commission goal itself enters the conversation under a
persistent engine-authored provenance frame, and the commission turn (and any
run-linked resume) carries an origin notice on the system prompt.

## Trust posture (current release)

Unauthenticated, like the rest of this release's API. The structural scope
above — no approve, deny, kill, or policy verb — is a property of the MCP
surface, and it is real: nothing commissioned through `/mcp` can approve
itself *through `/mcp`*. It is not a property of the client: a commissioning
client is a local process, the REST API is unauthenticated and
loopback-admitted, so client and CLI are indistinguishable local peers, and a
malicious client can `POST /api/resolve` directly to approve its own holds. One
class of action is outside that reach: a commissioned run cannot park a
control-plane call at all, so there is no such hold to self-approve.
Confirmation-on-the-CLI is the designed workflow, not an enforced boundary;
the enforced boundary in this release is localhost itself (the Worker-wide loopback
guard: non-loopback Host or Origin refused 403 on every route, gated by
`LOCALHOST_ONLY`, default on). A commissioned action already covered by a
standing or session grant executes without a prompt, by design. Inbound auth
(OAuth 2.1) is what makes the structural scope a containment boundary;
per-task isolation and structured iteration (`needs_input`/`provide`) are
a later release.
