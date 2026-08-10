# Habenula — Your Agents on Your Terms

**Habenula is the personal agent control harness.** The model does the thinking; Habenula governs the *doing*. When an AI agent acting on your behalf reaches for a consequential action — sending, spending, deleting, posting, booking — that action passes through Habenula first: classified, checked against your rules, recorded in a tamper-evident log, and executed only with authority you actually granted. If anything ever feels wrong, one command stops all of it.

Habenula is open source. The code that holds your credentials, evaluates your rules, and writes your audit trail is public, and you can run it yourself. You don't have to take our word for any claim on this page — that's the point.

## Why this exists

AI agents are becoming genuinely capable, and that capability is wasted until you can trust it. An agent with access to your email, your accounts, and your money is powerful precisely because it can act. And the most damaging public agent failures share a shape: untrusted content reaches the model, or the model is simply wrong, and it acts inside the user's authenticated session with nothing standing between a bad plan and a real-world consequence.

Serious governance for this exists — but it assumes an operator. The real controls are built for enterprises with security teams, or for developers willing to assemble and run their own; either way they presume someone whose job is to operate the governance system, not just the agent. The individual whose email, money, and accounts are actually on the line is handed something thinner: the confirmation pop-up, a prompt rendered by the same software that runs the model. That prompt fatigues people into reflexive approval, and prompt injection has walked straight past it again and again. The problem was never that governance is impossible. It's that staying in control of your own agents shouldn't require being your own security department.

Habenula gives the individual those real controls directly, and makes them architectural rather than advisory. We assume any model, from any vendor, can go wrong — manipulated by an attacker, or simply mistaken. You cannot verify in advance that it won't. So the layer that decides what an agent may do lives outside it, in deterministic code the model cannot reach. The model proposes; the runtime gates. No security team, no assembly required.

## What it looks like

**As a sidecar to your coding agent.** You keep working in Cursor, Claude Code, or whatever agent IDE you already use. You point its MCP config at Habenula. When your coding agent needs to take consequential action beyond the codebase — email a customer, post to your whole team's Slack, comment on a live GitHub issue — it hands the goal to Habenula instead of doing it itself. Habenula drafts the governed task, and you review it in the Habenula CLI sitting next to your editor: what service, what action, what specific resource. You approve, narrow, or deny. Habenula executes inside its own runtime, using credentials it holds and your agent never sees, and writes every step into your hash-chained audit log. The outcome flows back to your coding agent — how the run ended, never the work product. Your agent stays useful; it just stops being able to act on the world without you.

**Standalone.** You don't need a separate coding agent at all — here Habenula runs the agent itself. Start the CLI, connect a service, and you're talking to an agent hosted inside the Habenula runtime, powered by the model you chose and gated by the same governance on everything it tries to do. The first time it needs a capability, it asks — *"Read your inbox? For this task / For this session / Deny / Tell me more"* — and you decide the scope at the moment it matters. Permissions accumulate through use, at exactly the granularity you chose. No policy file to write, no settings safari before the first useful minute.

**It stops re-asking what you've decided — and keeps asking what matters.** A new agent can do nothing; deny is the default, so at first every capability is a question. But each answer settles that question at the scope you set: one "for this session" covers every matching action until the session ends, so you approve reading your inbox once, not on every message. What keeps prompting is what you *haven't* settled and what carries real stakes — a reply to an unknown recipient, a first charge on a new service. The asking isn't wearing down over time; it's concentrating on the decisions that are genuinely yours to make. You never configure any of this up front — the only permissions that exist are the ones you've granted in the moment, and each lasts exactly as long as the scope you gave it.

**With whatever model is behind it.** Habenula is model-agnostic: the model your agent thinks with is yours to choose. Use a frontier model from a lab like Anthropic or OpenAI, an open-weight model like Llama or Mistral, or one running entirely on your own hardware. Governance holds identically across all of them, because the gate judges the action, not the reasoning that produced it. You can run the strongest model available without taking on a new trust story for it, and change the model without your controls moving an inch.

## What makes it a harness, not a prompt

These are structural properties of the runtime, not features layered on top:

- **A deterministic gate, with no model in it.** Every tool call is mapped to a `(service, verb, noun)` action — the noun is the resource it touches — and evaluated by a pure function against your grants. Deny is the default — a fresh agent can do nothing. The model's eloquence is irrelevant to the gate; wanting and doing are separated by code, not judgment.
- **Credential custody.** Habenula performs the OAuth handshake and holds your tokens encrypted. The model never sees them. A fully compromised agent cannot exfiltrate keys it never had.
- **Agents commission; humans approve.** The surface an agent uses to submit work is structurally unable to approve work. Approval happens on a Habenula surface you control — and can require **Human Touch**: an OS-level presence gesture, like a fingerprint, in front of an affirmative grant. Human Touch ships today as an early proof of concept, with hardware-bound approval to follow. This is the same separation of duties banks apply to wire transfers, applied to your agents.
- **A tamper-evident record.** Every decision and outcome is written to an append-only, hash-chained audit log in your own per-user database *before* execution — including which actions arrived from an outside agent, tagged by origin in the chain itself. You can dump it and recompute the chain yourself, which shows that nothing inside the dumped range has been altered or reordered.
- **A real kill switch.** One command clears every grant down to the deny-all floor and sweeps anything pending — in under a second, typically tens of milliseconds. Your service connections survive, so recovery doesn't mean re-running OAuth. With zero grants in force, nothing can act.
- **No lock-in, by design.** The harness runs on any model — frontier labs, open-weight models, ones running locally — because a control layer owned by the model vendor it is supposed to control is a conflict of interest, not a safety story.

## What Habenula is not

- **Not an MCP gateway.** Gateways are middleware bolted in front of a runtime somebody else owns. They can filter tool calls; they cannot make the runtime hold credentials properly, and they cannot stop tool-result content from flowing back into the calling model's context. Habenula *is* the runtime. The governance decision is made and enforced inside it — credentials resolved, audit written, on the only path a tool call can take. The guarantees are structural, not a filter bolted in front.
- **Not a governance toolkit.** We don't ship components for you to assemble into a safe agent. We ship the assembled thing, with the architectural trade-offs already made.
- **Not a replacement for your coding agent.** Cursor and Claude Code are excellent at what they do. Habenula coexists with them by design: they keep the editor, Habenula takes governed custody of external action.

And one thing we deliberately refuse to build: **a public tool surface.** Habenula never exposes its integrations (Gmail, Slack, and the rest) as MCP tools for outside agent loops to call piecemeal. That pattern hands the content behind your credentials back to a model loop nobody governs, and turns a control harness into yet another tool marketplace. Outside agents get exactly one thing: the ability to *commission* a goal and learn how it ended. Everything between those two moments happens under governance.

## Trust, verified

Trust claims in this space are cheap. Ours are designed to be checked:

- **Read the code.** The credential broker, the policy engine, the audit chain, and the kill switch are all in the open repository, under AGPL v3.
- **Run it yourself.** The launch release ships two ways to run it — a container on any Docker host, or the packages on npm — so you can run and explore the whole product firsthand, not a hosted service with an open-source demo sibling. A hosted option follows fast, on the same code.
- **Read the whitepapers.** The architecture, governance, and security papers document the trust boundaries, the invariants, and — deliberately — the current limits. This is an early release: it runs one active session at a time, and its API is not yet authenticated beyond a loopback boundary. We publish what isn't done with the same prominence as what is.

## Who it's for

Today: developers who run agents and have watched them fail — the audience that reads a CVE writeup and wants the decision moved out of the model and into code they can read, not another confirmation dialog. The harness meets you where you work: a CLI beside your editor, an MCP handoff your agent already speaks.

Where it goes: the same runtime, surfaced for everyone — mobile approvals, voice, plain-language permissions, hardware-key confirmation for the actions that matter most. Agents will manage more of ordinary life every year. The control harness is how that stays *your* life, on your terms.

See the public roadmap for what ships when.
