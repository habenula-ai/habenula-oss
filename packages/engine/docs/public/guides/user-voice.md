# Voice

Habenula has no voice interface of its own. You interact with it by typing —
in the CLI, or through a client app. Speaking to a Habenula agent directly is
planned; the public roadmap is where that lives.

Voice reaches Habenula today in one indirect way.

## Voice through a commissioning agent

Habenula can run as a sidecar to a commissioning agent — Cursor, Claude Code,
or another agent that speaks MCP. When that agent supports voice, you speak to
*it*. To take a consequential action, it hands the goal to Habenula through the
commissioning surface, as text.

The voice is the commissioning agent's, not Habenula's. Habenula receives a
written intent, governs it exactly as it governs any commissioned goal, and
returns status. No audio and no transcript reaches Habenula.

Voice-initiated work is therefore governed identically to typed work. A
commissioning agent's voice support does not widen what Habenula will do. Every
action still faces the same permission checks, the same held-call approvals,
and the same audit log — and the log records the governed action, never audio.
