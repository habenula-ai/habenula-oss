# Security Policy

## Reporting a vulnerability

Email **security@habenula.ai**. Please do not open public issues or pull
requests for security reports — this repository is public, and an issue is a
disclosure.

Include what you can: affected package and version (or `Private-RevId` of
the snapshot), reproduction steps, and impact as you understand it. You will
get an acknowledgment within 72 hours and a status update as the fix
progresses. Fixes ship through an expedited release of the affected
packages; we credit reporters in the release notes unless you ask otherwise.

## Scope and current posture

Habenula is an early alpha, and some essential controls are not yet
implemented — most notably **authentication**. The detailed, honestly-stated
security posture (what is done well, known limitations, and what not to
deploy to production yet) lives at
[`packages/engine/SECURITY.md`](packages/engine/SECURITY.md). There is no
published audit for this release, and that file explains why.

## Supported versions

Only the latest release of each package is supported. There are no
maintenance branches during `0.y`; fixes ship as new releases on the current
line.
