# ADR-035: Explicit storage tool resolution

## Status

Accepted as the first installation/update architecture foundation.

## Context

Workspace registry v2 persists the absolute storage client path chosen at project
registration. Desktop and CLI packages each contain their own tools, so moving to
a new ZIP leaves existing projects pointing at the old files. The control host is
also inferred as a sibling. Installation selection must become independent of
project identity without rewriting the registry or changing portable behavior.

## Decision

Core accepts optional `storageTools` resolution options. Resolution selects a
managed pair first, an explicit pair second, and the legacy project command last.
Each descriptor contains client and control paths, provenance, and optional exact
component version and SHA-256 expectations. Managed selections require all three
identity fields. Selection is copied and frozen when Core is constructed; an
invalid managed selection never falls back to explicit or legacy tools.

Core resolves and validates opted-in payloads before cache preparation, Workspace
creation, Repair or removal starts. Each operation passes the same descriptor
through its storage calls and compensation steps. Doctor uses the same resolver,
checks the resolved payloads and installed identity, and reports invalid selections
without invoking their executables. Conflicting caller and selection expectations
fail rather than replacing a required identity.

`WorkspaceStoragePort` accepts a string or a resolved descriptor. Windows storage
dispatches client commands to the client and control/diagnostic requests to the
explicit host. Direct legacy string callers retain sibling/environment resolution.
Core captures the control environment override when constructed so its descriptor
does not change during an operation. Custom port implementations should accept
`StorageCommand` and inspect its descriptor instead of assuming every input is a
string.

No managed selection is enabled by default in Desktop or CLI. Both already share
Core, and the CLI's companion discovery now uses the common path helper. This PR
does not discover installations, load manifests, adopt custom project bindings,
rewrite registry paths, install a shim, or update the machine service. Registry
schemas 1 and 2 and the existing `storageCommand` field remain unchanged.

## Safety and limits

Resolution pins paths and expected identities, not Windows file handles. SHA-256
checks are local payload checks, not publisher authentication or a lock against
concurrent replacement. A future updater must provide immutable version storage,
signed manifests, maintenance admission and service compatibility enforcement.
The descriptor's expected component version is checked by Doctor; this change
does not add a universal installed-service admission gate to Core mutations.

Managed selection applies to this Core instance. Future installation adoption
must distinguish managed and custom project bindings before enabling it globally.
No registry mutation occurs merely from resolving tools or running Doctor.

## Validation

Tests cover selection precedence, frozen descriptors, legacy environment behavior,
missing/altered payload rejection, separate control paths, transport dispatch,
Doctor identity checks, and retained dirty Workspace repair using new tools while
the original registered path is missing. Invalid managed tools are rejected before
Git worktree or registry changes.
