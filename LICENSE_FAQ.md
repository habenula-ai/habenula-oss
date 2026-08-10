# Licensing FAQ

Answers to common questions about how Habenula is licensed. This document
explains the licence structure in plain language; it is not legal advice, and
the licence texts themselves are the authoritative terms.

## What licence is Habenula under?

Almost everything is **AGPL-3.0-only** (the GNU Affero General Public
License, version 3). One package is different: `packages/audit`, the
audit-chain kernel, is **MIT**. Each package ships its full licence text as
its `LICENSE` file. The documentation is licensed separately, under
**CC BY 4.0** — see below.

## Why AGPL?

Habenula is governance software: it decides what an agent may do, holds the
audit record, and operates the kill switch. Anyone relying on it deserves to
see exactly how those decisions are made — no matter who is running a copy for them as a service. The AGPL's network provision keeps
that whole class of use open: a provider who modifies Habenula and offers it
over a network must offer those users the modified source.

## I self-host Habenula for myself. What does the AGPL require of me?

For private use: nothing beyond keeping the licence and notices intact. You
can run it, modify it, and keep your modifications to yourself. The source
provision applies when you convey the software to others or offer a
**modified** version to other users over a network — then those users must
be able to get the modified source. This is a simplified explanation; please
see the license for the exact requirements.

## Can I use Habenula commercially?

Yes. The AGPL does not restrict commercial use. It requires that users of
conveyed or network-provided modified versions can obtain the corresponding
source under the same licence. Please see the license for the exact
requirements.

## Why is the audit package MIT?

An audit log verified only by whoever wrote it proves very little. The point
of the audit chain is that a *relying party* — an auditor, a researcher, a
security team — can verify it independently, inside their own tooling,
whatever licence that tooling is under. MIT makes the verifier embeddable
anywhere without pulling copyleft into the host codebase.

The whole package is MIT, not just the verification half, because verifying
means recomputing hashes with the same function that wrote them. Splitting
"write" from "verify" across two licences would break the property the
verifier exists to provide.

## Can I embed the audit verifier in proprietary software?

Yes. The audit package is MIT: keep the copyright and permission notice with
your copies, and you can embed it in anything, closed or open.

## Why "AGPL-3.0-only" rather than "or later"?

The licence terms are part of Habenula's trust story, so they are pinned to
the text that exists today. "Or later" would let a future revision of the
licence — written by the Free Software Foundation, not by us or by you —
change the terms that govern this code.

## Do the shipped binaries mix licences?

Yes: the engine and CLI build artifacts inline the MIT
audit source inside otherwise AGPL-licensed bundles. Each of those packages
ships a `NOTICE` file describing the inlined MIT code, and the MIT header
comments are preserved verbatim inside the bundles themselves.

## How do I check the licence of any given file?

Every source file carries an SPDX header naming its copyright holder and
licence. The repository is compliant with the REUSE specification (version
3.3): files that cannot carry a header are covered by `REUSE.toml`, and the
full licence texts live in `LICENSES/`. Any REUSE-compatible tool — for
example `reuse lint` — can verify the whole tree mechanically.

## What licence covers the documentation?

The documentation — the guides, architecture notes, and whitepaper content in
each package's `docs/` tree — is licensed **CC BY 4.0** (Creative Commons
Attribution 4.0 International), not the AGPL that covers the code. You can
quote, adapt, translate, and republish it, including commercially, as long as
you credit Habenula. One carve-out: the **code snippets and examples embedded
in the documentation are offered under MIT**, not CC BY — so you can lift a
sample straight into your own project, open or closed, without the attribution
requirement. The surrounding prose stays CC BY. The code stays copyleft, the
name and marks stay protected (see `TRADEMARKS.md`), and the documentation is
free to travel. The
mirror-root files — this FAQ, `README.md`, `CONTRIBUTING.md`, `CLA.md`,
`TRADEMARKS.md`, and the licence texts — are not documentation in this sense
and remain under the repository licence.

## How do contributions work?

This repository is a read-only mirror of an internal tree, so pull requests
here are treated as proposals rather than merged directly: accepted changes
are integrated internally and ship in a subsequent release. Signing the
Contributor License Agreement (see `CLA.md`) is what permits us to use
proposed code. `CONTRIBUTING.md` describes the process. Accepted contributions are credited in the release notes of the release that ships them.

## Can I fork Habenula and call it Habenula?

You can fork the code — that is the licence working as intended. The name
and marks are separate: see `TRADEMARKS.md` for what you can and cannot call
your fork.

## Is there a warranty?

No. The software is provided as-is, without warranty, as stated in the
licence texts (AGPL sections 15–16 and the MIT licence's warranty
disclaimer).
