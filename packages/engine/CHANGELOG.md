# @habenula-ai/engine

## 1.0.0

### Major Changes

- 7a39633: First release. The agent runtime: it holds the conversation, calls the model, and runs every tool call through the governance pipeline before anything reaches a real service.

  - **Governance on every tool call.** Each call is mapped to an abstract `(service, verb, noun)` tuple and evaluated against a `default-deny` floor. A call with no grant behind it is held, not run, and the answer is yours: deny, ask for details, allow it once for this task, or allow it for this session. There is no permanent allow.
  - **Spending caps.** A call that moves money is priced from a bound quote and checked against a monthly and a session limit before it dispatches. A breach becomes a question naming the amount, the limit, and the running total — never a silent block, and never a standing approval. The money verb it governs is on a mock delivery service, so the caps are exercised end to end without a real charge.
  - **An audit chain you can verify yourself.** Every decision and outcome is written to an append-only SHA-256 hash chain in per-user SQLite, and the write happens before the tool runs. Chain verification is a separate MIT-licensed package so a relying party can run it without trusting us.
  - **Credentials the model never sees.** OAuth tokens are encrypted at rest and resolved to a real credential only at execution time. The model receives a session reference. The engine refuses every route but its health check if the encryption key is missing, malformed, or the publicly known placeholder.
  - **Two inbound surfaces at two trust levels.** An external commission surface where another agent states a goal and cannot issue commands, and a trusted local drive surface for your own CLI. Operating Habenula itself — kill, disconnect, quit, reading status — is a governed service reachable only from the trusted surface, and the engine refuses a control-plane call named from anywhere else rather than asking you to approve it.
  - **Kill.** `kill` sets a global deny policy, clears every grant except the deny floor, and sweeps held calls, in one transaction. Connected services survive it, so you resume without redoing OAuth.
  - **Two ways to run it.** A host-run daemon that `habenula up` starts for you, and a loopback container image. Both host the same Worker bundle on the same runtime, persist to the same store, and bind to localhost.
  - **Connect Gmail, Google Calendar, Outlook Mail, Slack, and GitHub**, plus two mock services for trying the governance loop without connecting anything real.

  Both run paths are loopback-only and single-user at this release. There is no engine authentication yet, and the security policy says so on its front page.
