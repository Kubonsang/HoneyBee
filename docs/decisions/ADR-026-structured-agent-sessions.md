# ADR-026: Desktop structured Agent sessions

## Status

Accepted as an Experimental, opt-in Desktop boundary.

## Decision

HoneyBee keeps **stdio-framed-v2** as the stable default and adds two exact-version session
adapters: Codex CLI 0.146.0 through **app-server --stdio**, and OpenCode 1.18.16 through
**opencode acp**. There is no automatic fallback between adapters.

Agent session lifetime is not a durable resource lease. The Electron single instance owns one
process-local DesktopWorkScheduler with capacity four, priority/FIFO admission, and structured
scope exit. Existing batch maxParallelWorks remains an independent upper bound. Durable leases
remain limited to Run single-writer ownership, external workspace storage, and the Unity Editor
pool.

The provider process is created behind a deferred containment wrapper. HoneyBee journals the
wrapper PID and process identity before activation. Cancellation and failure drain the containment
tree, preserving the v0.6 cleanup boundary.

Session Works use Journal schema v6. It is the v5 Unity transaction event set plus metadata-only
admission, session, turn, and root approval events. Prompts, raw approval payloads, provider
transcripts, and Skill manifests are content-addressed Artifacts; Journal events contain references
and typed decisions only. Approval resolution is durable before its response is sent to the
provider. An unclear delivery is not retransmitted automatically.

The Desktop policy auto-denies elevation, may auto-allow a verified file change confined to the
materialized workspace Assets, Packages, or ProjectSettings, and escalates commands and ambiguous
requests for allow once or deny. It never grants a session-wide approval.

Project AGENTS.md and .agents/skills files are bounded, link-free, hardlink-free, read through an
open/fstat identity check, copied into the isolated workspace, and stored as Artifacts. Their root
location keeps them outside Unity source manifests and verified patches. Codex skills/list is also
stored independently. Because provider-global Skills are not yet suppressible across both
adapters, v1 declares Skill isolation as observe-only; observed and materialized sets are not
silently presented as identical.

## Explicit non-capabilities

Plan mode, native resume/fork/reconstruction, steering, structured user questions, subagent
approval, slash commands, and plugins remain unsupported. The capability contract reports these
facts rather than emulating them.

CLI config execution remains on the stable framed adapter. A structured adapter in a direct CLI
execution fails closed; session ownership currently belongs to the Desktop single instance.
