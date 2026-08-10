# @habenula-ai/cli

## 1.0.0

### Major Changes

- 7a39633: First release. The `habenula` command — the only client at this release, and the surface every confirmation is answered on.

  - `habenula up` starts the local engine in one command: it generates the shared secrets on a first run, guarded so an existing store can never lose its key, picks and records a port, starts the daemon detached with a rotated log, and reports the URL once the engine answers. An engine already serving is recognised and verified, never replaced. `habenula down` stops it after proving the recorded process is that engine, and leaves your session and grants untouched.
  - `habenula` on its own opens the conversation. Held tool calls surface as prompts in place; answering one mints a grant scoped to the task or the session and lets the call through.
  - `habenula log` reads the audit chain, `log dump` writes it as JSONL, and `log verify` recomputes every hash locally — against a live engine or a dump file — using the same verifier the engine writes with. A broken chain and a decision closed two contradictory ways each exit with their own code.
  - `habenula status` shows running agents, connected services, and every pending held call rather than only the oldest. `habenula cap` reads and sets the spending limits. `habenula task` lists, shows, cancels, and watches the queue.
  - `habenula connect` runs the OAuth flow, and refuses up front with the variables to set when the provider is not configured, instead of sending you to a broken authorize page. `habenula disconnect` clears the service and its stored credential in one atomic delete.
  - `habenula kill` is the emergency stop, and `habenula quit` ends the session and frees the slot.

  The transport holds a connection for the full deadline the CLI chose, so a slow model turn ends in a readable message rather than a socket error.
