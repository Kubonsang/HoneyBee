# ADR-021: Desktop shell and project profiles

- Status: Accepted
- Date: 2026-08-18

## Context

The Desktop MVP needs a continuously running Unity operator surface without moving orchestration,
filesystem authority, or process control into renderer code. Users already have strict v0.6 batch
configs, so a second setup model would create configuration drift.

## Decision

The Desktop uses Electron with a React renderer. `contextIsolation` and the renderer sandbox are
enabled, Node integration is disabled, new windows and navigation are denied, and the production
document uses a restrictive CSP. A bundled CommonJS preload exposes one frozen, versioned API.
Every renderer request and every main-process response is parsed through strict Zod contracts.

The Electron main process owns one `HoneyBeeRuntimeFacade`, rooted at
`<Electron userData>/runtime/runs`. It is the only Desktop component allowed to start Work, run
Doctor, or access runtime state. The renderer does not import CLI adapters or orchestration classes.

Project profiles contain only a generated profile ID, display labels, the selected Unity project
path, and the path to an existing v0.6 batch schema 3 config. They are stored in a bounded strict
settings document using an fsynced temporary file and atomic rename. Unknown or unsafe settings
fail closed. Recent projects are derived from the profile timestamps.

The Task Composer uses the Agent command already owned by the linked config. Priority and ordered
compile/warm-test capabilities remain per-Work choices. One submitted Work calls the existing
single v0.6 transaction; two or more call the existing batch workflow. The renderer never selects
an Editor slot.

Doctor is required before the UI enables Start. It remains read-only and does not launch an Agent
unless a future explicit probe contract is supplied.

## Consequences

This slice provides project selection, recent projects, Doctor, and Work submission while keeping
the v0.6 runtime authoritative. Live Run observation, detail/evidence views, controls, patch
disposition, packaging, and Electron smoke automation remain separate later slices.
