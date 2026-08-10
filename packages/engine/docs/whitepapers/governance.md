# Governance: How Habenula Decides What an Agent May Do

**Habenula Whitepaper · RFC v1.0**

> **Status: Request for Comments.** This paper describes the governance model as implemented in the current open-source release, plus clearly-marked direction. It is published as a draft inviting technical and community review — corrections and challenges are welcome via the repository. Where the system has limits, they are stated here rather than discovered later.

---

## 1. Confirmation is not control

Serious agent governance exists — enterprise control planes and policy gateways, built for security teams to run. But the agents an individual can actually install don't come with that; they come with a confirmation prompt. Asking before acting is not the same as being governable.

The pattern behind the public agent failures of the last year is consistent. Untrusted content reaches the model: a calendar invite, an email body, a web page, a poisoned config message. The model, which cannot reliably distinguish data from instructions, is steered into acting against its user inside the user's own authenticated session. And the thing standing between the manipulated plan and the real-world consequence is a confirmation prompt: phrased from the model's own output and rendered by the same software that will execute the action, arriving in a stream of identical prompts the user long ago stopped reading. This is not hypothetical, and it is not any one vendor's failure. Over the last year the same shape has produced published CVEs against coding assistants, an agent destroying production data against an explicit instruction not to, and a browser agent driven to exfiltrate a user's data by content it merely read. The vendors are competent and the engineering is serious; the pattern recurs anyway, which is the point. Where the answer has been another confirmation, the same failure remains available. Where it has been a structural boundary — separating production from development, refusing a class of access outright — the failure closes. That second answer is the right one, and it is what this paper is about.

Confirmation UX fails for a structural reason, not a design-polish reason: it asks the component that was manipulated to faithfully describe the manipulation. If the model composes the request, frames the summary, and renders inside the same trust surface that executes, then a sufficiently manipulated model controls both the action and the user's picture of the action — as does a compromised process driving it.

Governance, as this paper uses the word, means something narrower and harder: **a deterministic decision, made outside the model, about whether a concrete action runs — enforced by a runtime the model cannot reach around, and recorded in a log the runtime cannot quietly rewrite.** Habenula is a personal agent control harness: an integrated runtime built so that this property holds end to end, for one person's agents, without an IT department.

## 2. The worldview: the model is an untrusted optimizer

Most agent vendors are betting they can make the model trustworthy enough to hold its own permissions. It is a coherent bet — for them. It is also a bet the user cannot verify, and it asks more of the model than resisting attackers: it asks the model to be *right* about consequential action every time, with no adversary required to make it wrong. Prompt injection is the sharpest way that bet loses — an attacker deliberately steering the model — but it is not the only one. An un-manipulated model still misreads intent, acts on something it hallucinated, or takes the overconfident path. Being usually right is not the same as being authorized to act.

Habenula takes the opposite bet: **the model is never trusted, and nothing in the safety layer depends on its judgment.** The model is treated as a brilliant, unreliable optimizer — superb at proposing what to do, categorically unqualified to decide what it is *allowed* to do, whether a given proposal came from sound reasoning, a manipulation, or an honest mistake. So the architecture separates the two:

- The model **proposes**: conversation, reasoning, tool-call requests.
- A deterministic runtime **disposes**: classification, policy evaluation, audit, execution — pure code, no model anywhere in the decision path.

This split has a clarifying consequence, and the gate does not care *why* an action is wrong. A manipulated model, a mistaken model, an overconfident model can each *want* anything; each can only *do* what the user's standing grants permit, and in this release those grants are narrow, session-bound, and locked down by default. Prompt injection is the case this bounds most visibly, because it is adversarial and public — but the same boundary holds for the model that simply erred with no one attacking. The gate does not care how persuasive the reasoning was, or whether anyone was steering it. Wanting and doing are separated by code.

The rest of this paper is that sentence, made concrete.

## 3. The permission calculus: verbs, nouns, and nothing bare

### 3.1 Actions, not tool names

Raw tool names (`gmail_send_email`, `slack_post_message`) are implementation details of whichever integration happens to serve them. Governance never operates on them. Every tool call is first mapped to an abstract action:

```
(service, verb, noun)  —  e.g. (gmail, send, "alice@example.com")
```

The **verb** comes from a canonical vocabulary Habenula defines, not the integration: read, list, send, reply, archive, and the like. The vocabulary is kept deliberately stable, because every verb names a category of consequence a user must be able to reason about. The **noun** is the concrete resource: an address, a path, a channel, a label. Policies written against `(service, verb, noun)` survive integration renames, transfer across alternative servers for the same service, and translate directly into sentences a person can evaluate: *"this agent may send email, to that one address."*

### 3.2 Mandatory noun binding

There are no bare verb grants. A verb without a noun scope is not "allowed everywhere" — it is functionally deny. This mirrors file permissions in an operating system: a process is not granted *write*; it is granted *write to these paths*. No path, no access.

This rule is the difference between connecting a service and empowering an agent. Connecting Gmail establishes a credential in Habenula's custody — it grants no agent anything. Capability arrives only through explicit `(verb, noun)` grants, and those arrive only through the consent flow in §5.

### 3.3 The tool registry: the dispatch table is not self-declared

The mapping from raw tool to `(service, verb, noun)` is a security boundary, and Habenula authors all of it. Integrations do not classify themselves. An integration that could declare its own verb classification would be a process setting its own permission bits — a malicious or sloppy tool could label a destructive operation `read` and sail through governance. Classification sits *inside* the chain of trusted governance actions: every call is classified before it is evaluated, so a wrong mapping bypasses the gate upstream of the policy engine, exactly as a mislabeled entry in an operating system's syscall table would. The registry is therefore held to the engine's own standard — Habenula-authored, and fully open to audit.

Two fail-safe defaults follow. A tool call that appears in no registry entry is classified as unknown and **requires confirmation on every call** — unrecognized surface gets stricter treatment, never looser. And when the registry cannot extract a noun from a call's parameters, the call falls back to confirmation rather than to verb-level allow. Ambiguity resolves toward the user, not the agent.

## 4. The pipeline: what happens to every tool call

When the model emits a tool call, the runtime — not the model — runs this sequence:

1. **Classify.** Registry lookup maps the call to `(service, verb, noun)`.
2. **Evaluate.** A pure function compares the action against the user's live policy entries. No I/O, no network, no model, no side effects — the same inputs produce the same decision, every time, testably. Entries carry priority; matching entries are sorted and the highest wins; if nothing matches, the answer is deny. A deny floor covering everything is seeded into every user's policy at creation and cannot be removed — deny is not a default setting, it is the substrate.
3. **Price, if the action spends money.** An action that moves money carries a bound quote — the service commits to an exact total before anything is charged. A second pure function compares that total against the user's two spending windows, per-session and per-month, each summed from an append-only ledger. Going over does not fail the request: it turns it into the question below, with the amount named. This stage exists only for paid actions; every other call skips it.
4. **Record.** The decision is written to the append-only, hash-chained audit log **before** anything executes. If execution later fails, the failure is recorded against that entry; there are no silent retries. (The chain's design and integrity properties are covered in the security whitepaper.)
5. **Execute or hold.** Allowed calls execute inside Habenula's runtime, using credentials Habenula holds and the model never sees. Un-granted calls are not rejected outright — they are **held**.

A held call is the confirmation moment done in the runtime rather than in the chat. The entire in-flight turn is persisted and parked: the pending call, its exact parameters, everything queued behind it. The model does not get the call back to rephrase; the user is asked out-of-band, and what they review is the runtime's record of the action, not the agent's summary of it. On approval, the runtime dispatches *the parked parameters* — precisely what was approved, not whatever the model might supply after the fact.

One further hardening applies where the model meets content it did not author and the user did not type. Input does not all carry the same trust, and the runtime keeps the classes distinct rather than flattening them into one undifferentiated prompt. Four provenances matter: the system's own rules and framing (the top authority), the user's own words, the model's prior output, and external data — tool results, web pages, values relayed by an outside client. That last class is the dangerous one, and it is labeled as such at both ends. For the model, external data enters its context inside a fenced envelope marked as data-never-instructions, with a per-message random nonce so injected content cannot forge the fence's closing and "resume" as trusted text. The same provenance is meant to be legible to the human: the client surface distinguishes the agent's words from quoted external content from the app's own prompts, so a person is never silently reading attacker-supplied text as though the agent wrote it. (The model-side fence ships today; the human-facing rendering is client-side and still evolving.) This is labeling, not a guarantee — a determined injection can still sway a model reading labeled data. That is exactly why the deterministic gate, not the labeling, is the load-bearing defense.

## 5. Consent: grants that are built, scoped, and mortal

Habenula has no policy-file prerequisite and no up-front permission wizard. Permissions are built **through use**, at the moment an agent first needs something:

> *Your agent wants to: list email in INBOX.*
> **Deny** · **Tell me more** · **For this task** · **For this session**

- **Deny** refuses this action and grants nothing.
- **Tell me more** leaves the call parked and expands the runtime's registry metadata for the tool — what it is, what it touches. No decision is extracted by impatience.
- **For this task** mints a single-use grant, consumed the instant it authorizes its one call.
- **For this session** mints a grant that lives exactly as long as the session — and sessions have one clock, started at session start, after which everything scoped to it is inert.

A call held because it would cross a spending cap asks a narrower question, because permission is no longer what is in doubt:

> *Your agent wants to: place an order for $11.50 — $6.50 over your $20.00 session limit.*
> **Deny** · **Tell me more** · **Approve this order**

The two grant answers are absent by design, and the runtime refuses them here rather than relying on the interface to hide them: a session-scoped answer would quietly raise the ceiling for the rest of the session, which is not what a user answering a question about one order intends. Approving mints nothing and raises nothing — it authorizes that one order at that one amount, and the next order over a limit asks again.

Note what is absent: **there is no "always."** In the current release, no permanent allow exists anywhere in the system. The policy engine will not even honor a wildcard *allow* — wildcards are reserved for deny. The strongest thing a user can grant dies with the session, and the kill switch (below) kills it sooner. A standing-grant tier is planned for later phases, where it will arrive together with the tooling to review and revoke it; the trust curve at launch is deliberately conservative, because a new runtime with a new user has earned nothing yet.

This is **confirmation-as-onboarding**: within a session the asking tapers as grants accumulate, and at every moment the permission set in force is exactly what the user has said yes to, at the scope they said it. The strongest grant dies with the session, so a later session starts from the same empty floor — the taper resets each time, by design.

### 5.1 The kill switch

`habenula kill` is governance-scoped and absolute: in one atomic transaction, every grant is deleted down to the seeded deny floor and every held call is swept away. Each swept call is then recorded as a terminal, audited denial. It propagates at edge speed — typically tens of milliseconds.

Deliberately, a kill does **not** disconnect services or destroy stored credentials. It does not need to: with the deny floor in force and zero grants, a still-valid credential authorizes nothing. Preserving connections means recovering from a kill takes seconds, not a re-run of every OAuth flow — a kill switch users are reluctant to press is a kill switch that fails at its only job. Nor does it revoke tokens at the provider: there is no revocation path in this release, on kill or on disconnect. A disconnect deletes the stored credential locally, and whatever the provider still honors stays live until it expires on the provider's own schedule. We state that rather than imply a cleanup that does not happen.

In this release, sessions host a single agent, so grant scope and agent scope coincide: what you grant in a session is what that session's agent may do, and it survives no longer than the session. Named multi-agent isolation means several agents with independently scoped grants under one user. It arrives with the multi-agent split on the roadmap.

## 6. Separation of duties: agents commission, humans approve

The deepest structural commitment in Habenula is about *surfaces*: **the surface through which an agent submits work is incapable of approving work.**

Habenula exposes exactly one inbound seam to outside agents — an MCP commission endpoint with six verbs. Three drive a job: commission a goal, check liveness, read a run's status. Three iterate on a commissioned job: supply a value the run is waiting on, correct that value before supplying it, and cancel a parked run. Every one of them is scoped to commissioned work, and the set is closed. There is no approve verb, no deny verb, no kill verb, no policy verb, and no tool surface: an outside agent never names or invokes Habenula's individual tools; it sees only a read-only capability manifest of what may be commissioned. It hands over an *intent* in its own words; the governed runtime does the work; the human approves on a Habenula-owned surface. What the seam registers is the first enforcement point, though, not the whole of it. A commissioned goal is text an outside agent wrote, and a model can emit the name of a tool it was never offered — so the runtime checks the same bound a second time, when a name comes back. A call on Habenula's own controls (kill, disconnect, quit, the status and policy reads) is refused at dispatch unless it came from the trusted internal surface. Refused, not held for your approval: no answer to that question could be right, and asking it would make you the last line of a boundary the engine keeps for you. Each refused attempt lands in the audit log naming the reason. The same rule binds an agent driven through the local API's direct routes, because running on your own machine is not authorization to set a model at Habenula's controls. In this release, results returned through this seam are metadata only — status, not content — so data a credential unlocked does not exit the governed runtime by the door the commission came in. Returning content to a commissioner is planned, but as a governed channel — policy in the runtime deciding what may flow to whom — not an open results pipe. The durable property is not that content never leaves; it is that content leaves only under governance.

The two inbound surfaces are treated differently by provenance. Content arriving through the commission seam is flagged to the model as relayed by an outside client, not typed by the user, and handled with heightened scrutiny: the model is directed to ignore instructions embedded in it that try to rewrite the system's rules or governance, and verbatim values the client supplies pass into tool parameters through a placeholder the engine substitutes, so the model never retypes or reinterprets attacker-supplied data. Content the user types into the CLI is the user's own input. The distinction is load-bearing because the CLI is the human's approval surface and the commission seam is not — which is also why **driving the CLI with an agent is discouraged.** Pointing an agent at the human's own CLI to click through approvals collapses the very separation the commission surface exists to enforce: it lets a model loop resolve holds as if it were the person. This release cannot prevent this — the local API is unauthenticated and loopback-guarded — and we do not pretend to; we name it as misuse, and planned work adds sanity checks that detect and discourage agent-driven CLI use rather than silently allowing it.

Approval, meanwhile, can be pushed beyond a keystroke. **Human Touch** is Habenula's name for requiring an OS-level user-presence gesture in front of an affirmative grant in the CLI — today, an opt-in Touch ID check on macOS. Enabled and working, it means an approval carries a fingerprint's worth of evidence that a person, not a process, said yes: a failed gesture withholds the approval. What happens when it does *not* yield a yes splits in two, and only one case lets an approval through. Where the gate is switched off, or the platform has no such gesture, approvals proceed ungated — a deliberate usability choice, and the honest weakness of a tier-1 presence check: it proves a person was there when it runs, and proves nothing when it is not enabled. Where the gate is enabled but *cannot complete* — the gesture fails, the check errors, it times out, or the packaged CLI cannot reach the presence helper — the approval is withheld. So the failure mode depends on whether the gate is off or merely unable to answer, and only the first of those lets an approval through. We are precise about its current strength: in this release it is a CLI-side presence check, not a cryptographic boundary — a process that can reach the local API directly does not pass through it. The destination model, on the roadmap, binds approvals to hardware-backed signatures over the exact action approved, at which point even Habenula's own backend cannot substitute what you consented to. This release ships the gesture; later releases ship the proof.

The honest boundary statement for this release, then: the runtime's API is local and unauthenticated, guarded by a loopback-only rule — the machine itself is the trust boundary, and any existing malicious local process would be inside it. The commission surface's structural scope (no approve verb) is real and enforced; turning it into containment against hostile local software arrives with inbound authentication on the roadmap. We publish this rather than imply otherwise, because a control harness that overstates its boundary is exactly the product this one exists to replace.

## 7. What governance cannot do

A governance model that only lists its powers is marketing. The limits:

- **The policy is the blast radius.** Governance enforces the user's grants; it does not second-guess them. An agent granted broad read and external send can be prompt-injected into misusing both, within scope. Narrow grants are the mitigation, and the defaults push hard toward them — but a user who grants broadly has bought the corresponding risk.
- **Permitted channels can carry anything.** Every call is gated and recorded, but noun binding scopes *where* data may go, not *what* a permitted call carries — an agent allowed to send email can put sensitive content in an email it is allowed to send. This is narrowing, not solved: parameter-level noun binding, a near-term addition, will let a grant pin or constrain a call's individual fields, not just its destination, so a channel need not be opened wholesale; opt-in content inspection is a later, deeper layer. Underneath both is a deliberate privacy floor — by default governance runs on metadata and does not read your content.
- **Governance binds the request, not the effect.** The gate decides what an agent may *ask a tool to do*, and the audit chain records what the tool *reports back*. Neither verifies what the tool actually did on the far side. A tool runs on infrastructure Habenula does not operate — increasingly, infrastructure with its own model in the loop — so a tool told to send to one address, or shown one price, can do otherwise, and the runtime learns only what the tool returns. The authored, vetted integrations are the tightest case, because Habenula wrote the client that builds the call; a tool Habenula did not author is trusted to honor its own contract. The mitigations are the ones that run everywhere here: narrow nouns bound what a lying or compromised tool is *authorized* to attempt, the audit chain records the attempt and the reported outcome, and the kill switch ends the session. Independent post-hoc verification of a tool's effect is a roadmap item.
- **Actions are judged individually.** The pipeline does not yet evaluate *combinations* — "read sensitive mail, then post externally" is two independently-lawful actions today. Plan-level governance (§9) is the designed answer.
- **Semantic intent is enforced only once it is made concrete.** "Only research-related reads" is not itself a policy — a deterministic gate cannot judge relevance at run time, and the model cannot be trusted to. But such an intent compiles to concrete nouns — addresses, labels, paths — which the gate then enforces exactly. The system helps you build that concrete scope; what it will not do is leave the judgment to the model.
- **An agent can ask for too much, nicely.** Models can advocate for broad grants through the consent flow. The confirmation surface renders the runtime's facts, not the agent's pitch — but the final judgment is the user's, and always will be.

## 8. What a control harness is — and is not

The properties above define a category, and its edges are worth drawing precisely, because the market is crowded with adjacent shapes that do not deliver them.

**A personal agent control harness** is an integrated runtime an individual installs, inside which agent action is deterministically governed, credentials are custodied away from the model, every action is recorded tamper-evidently, and everything can be killed at once — with approval on surfaces the agent cannot drive.

- **A harness is not an MCP gateway.** Gateways filter tool calls in front of a runtime someone else owns. Useful for enterprise policy; structurally unable to deliver credential custody or content containment, because both live *inside* the runtime being fronted. If the runtime hands tokens or tool results to the model, no gateway rule un-hands them.
- **A harness is not a governance toolkit.** Toolkits ship the parts — policy engines, audit libraries, approval hooks. They leave the security-critical assembly to each developer. The harness ships assembled, with the invariants enforced by construction rather than by each integrator's diligence.
- **A harness does not ship a pass-through tool surface.** We name this antipattern because we were tempted by it and rejected it, and others will be tempted too: exposing a governed runtime's integrations as individual MCP tools for outside model loops to call. It demos well and it quietly breaks the model's containment — every tool result flows back into a calling context nobody governs, and the "governed" runtime degrades into a credential-holding proxy for an ungoverned loop. Habenula's integrations are reachable only from inside its own runtime. Outside agents commission; they do not drive.

One honesty note belongs here: this codebase is open source, and the license permits forking it into any of the shapes above, including the antipattern. We cannot prevent that and will not pretend to. What we ship, sign, and put our name on excludes them; this paper documents why, so that a fork that reintroduces them is legible as a different trust posture, not a variant of ours.

## 9. Direction: from call-level to plan-level governance

Everything above governs one action at a time. That is the correct primitive, and it is also not the destination — multi-step work governed call-by-call forces a bad choice between confirmation fatigue and over-broad session grants.

The designed evolution, arriving with the consumer surface on the roadmap, is **plan-level governance**: a multi-step task compiles into a structured plan — the steps, their scopes, their declared limits. *The plan* becomes the unit of consent. The user approves one legible description of the whole job; the runtime then holds the agent to exactly what was approved, step by step, deterministically, including the limits the plan declared about what it will *not* do. The model plans; the compiled plan, not the model's ongoing judgment, is what executes. The audit trail gains a second level: intent (the approved plan) above execution (each action, linked to its step).

This is the same worldview extended upward — the model as untrusted optimizer, now of whole plans. And it is where the harness's governance becomes something no per-call confirmation model can express. A dedicated whitepaper accompanies that release.

## 10. Verifying this paper

Every mechanism described here is in the open repository: the policy engine and its deny-floor evaluation, the registry-then-evaluate-then-record-then-execute pipeline, the held-call machinery, grant minting and expiry, the kill transaction, the commission surface's closed verb registration, and the Human Touch gate. The architecture whitepaper locates these components and their trust boundaries; the security whitepaper treats the adversary's view — the invariants, the attack surfaces, and the audit chain's integrity design. Read the code against all three; that is what it is public for.
