# Mock Integrations

`mock_email` and `mock_delivery` are **development and test fixtures**, not third-party services a user connects in production. They are catalog services (`packages/tools/src/services/mock/`) so the test runtime and the onboarding demo can exercise the full governance pipeline — noun extraction, confirmation holds, audit logging, scope and spend checks — without calling a real provider. Each runs the same dispatch path as a real integration; only the outbound transmission is canned.

They connect through the `mock` OAuth provider, an in-process consent page that mints a credential locally. No external app registration is needed.

Two fixtures cover the two capabilities that are hard to demonstrate against a live service safely:

- **`mock_email`** exercises structured iteration — a tool that pauses to ask the agent for a missing value before it can run.
- **`mock_delivery`** exercises the spending cap — a money verb whose charge is checked against the user's cap before it commits.

## mock_email

`mock_email` mirrors the shape of the real email services, sharing their schemas and noun resolvers, so a change to email governance can be tested here first. It requests the `email.read` and `email.send` scopes.

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `mock_email_list` | `list` | the mailbox label listed, normalized (default `INBOX`) | read |
| `mock_email_search` | `search` | the mailbox(es) the query resolves to via its `in:`/`label:` operators, sorted and comma-joined; the sentinel `anywhere` when the query is unscoped | read |
| `mock_email_send` | `send` | the set of distinct recipient addresses across `to`+`cc`+`bcc`, de-duped and sorted; a sentinel when there are none | send |

**Structured iteration.** `mock_email_send` publishes a required data slot, `to`. On a commissioned run, a call without a recipient parks the task as `needs_input` naming the missing slot — the required-slot gate runs before dispatch, so the tool is never invoked with the incomplete call. The commissioning client supplies the value with `habenula_provide` and the call proceeds. A chat turn never parks: the agent asks for the missing value inline. This is the onboarding demonstration of a run that requests input mid-flight. A blank or whitespace label on `mock_email_list` is coerced to the default so the governance noun is never empty.

## mock_delivery

`mock_delivery` is the reference **money verb** service — the fixture every later paid integration is modeled on. It requests the `delivery.read` and `delivery.order` scopes. The merchant is the governed noun for every verb, and policy matches merchants exactly (no wildcards).

| Tool | Verb | Noun | Capability |
|------|------|------|-----------|
| `mock_delivery_search` | `search` | the merchant filter, lower-cased; the sentinel `all` when browsing every merchant | read |
| `mock_delivery_quote` | `quote` | the named merchant, lower-cased; a sentinel for a missing or empty merchant | read |
| `mock_delivery_order` | `order` | the merchant decoded from the quote id (the call itself names no merchant); a sentinel for an invalid quote | send (money verb) |

**Quote, then commit.** `mock_delivery_order` is the only money verb: it declares a `spend` descriptor, and the spending cap keys off that descriptor's presence — the cap and the verb are inseparable. The order takes only a quote id and an idempotency key, so it cannot construct its own price; it commits a price the service already quoted (the pattern real delivery and ride APIs enforce with a required fare id). The `spend` descriptor decodes the quote's total as an upper bound on the charge, describes the order for the confirmation surface, and names the `quoteId` plus `idempotencyKey` pair the ledger dedupes on. The cap is checked against the decoded total before the order commits (see [`governance.md`](../governance.md)).

**API quirks**

- **Quotes are multi-use while unexpired.** The same signed quote can commit more than once under different idempotency keys, and each commit re-enters the spending-cap check independently. A quote id's `nonce` only makes the id unique; it does not make the quote single-use. Quotes expire after a few minutes — an expired quote returns `quote_expired` and must be re-quoted.
- **Retries are idempotent.** Re-sending an order with the same `quoteId` and `idempotencyKey` pair returns the original order rather than charging twice.
- **Quote ids encode UTF-8 bytes.** A quote id is base64url over the payload's UTF-8 bytes, not its code units, so a merchant name with an em dash, a `×`, or an accented character encodes without error.
