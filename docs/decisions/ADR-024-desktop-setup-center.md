# ADR-024: Desktop Setup Center and managed Unity parent provisioning

## Status

Accepted.

## Context

Desktop dogfood previously required an operator to install storage, provision an immutable Unity
Library parent, calculate pins, and hand-author a v0.6 batch config before Doctor could help. That
setup was too error-prone for a control plane intended to remain open during ordinary Unity work.
The Work runtime must remain the existing v0.6 kernel; setup cannot become a second scheduler.

## Decision

Desktop provides a local Setup Center in the main process. The sandboxed renderer sends strict,
versioned discovery and setup requests through preload IPC. Setup performs no downloads. The
packaged Desktop carries a commit-pinned `unity-workspace-storage` client and a minimal HoneyBee
service host as internal resources. Starting Setup installs or starts that bundled service with one
explicit Windows elevation prompt; the renderer cannot substitute an external storage executable.
All other operations run as the installed user.

Setup always pins Unity, bundled `unity-workspace-storage`, and the selected Agent command.
TestPlay protocol 3 and the TestPlay Bridge tree are an optional, all-or-nothing capability backend.
An Agent-only environment omits both and produces Works with an empty capability list. Setup
calculates `honeybee-library-compatibility-v1` from canonical serialization of:

- Unity project version and Unity executable SHA-256;
- Packages `manifest.json` and `packages-lock.json` (including a deterministic missing value);
- the required ProjectSettings manifest and scripting backend;
- `StandaloneWindows64` build target; and
- Bridge overlay digest and protocol version 3 when the optional backend is enabled.

`Assets` is deliberately absent from this key. Assets are still included in the before/after source
integrity check during a parent build, so the original project cannot change unnoticed.

Schema-2 `parent begin` returns a `stagingPath` whose final component is the provider-owned
`Library` mount. HoneyBee derives `projectRoot = dirname(stagingPath)`, proves that it is physically
beneath the configured broker workspace root, claims only that shell with an exclusive ownership
marker, and copies `Assets`, `Packages`, and `ProjectSettings` around the existing mount. HoneyBee
never creates, replaces, writes, or deletes `Library` directly. It runs pinned Unity against the
derived project root with `StandaloneWindows64`, verifies source/Bridge/Library identity and a
populated Library, then commits. Failure or cancellation aborts before the owned shell is removed.

The parent begin, Unity containment, commit/abort, shell cleanup, and profile publication boundaries
are recorded as typed metadata in an fsynced setup journal. A lost parent-begin response is replayed
with the same request ID before abort. Unity uses the existing deferred containment primitive;
resume drains an unmatched recorded process tree before storage cleanup. Request, ownership,
runtime-config, and profile files use no-overwrite atomic publication. A storage pin change or an
uncertain drain/abort remains `recovery-required` rather than inventing completion.

The resulting strict profile stores schema-2 parent identity and a generated v0.6 batch template.
Desktop still delegates Work execution, Run state, Evidence, verified patches, and cleanup to
`honeybee-cli/runtime`. Imported managed profiles are revalidated and receive a freshly materialized
local runtime config instead of trusting an exported `batchConfigPath`.

## Consequences

Ordinary Assets changes reuse the same parent, while changes that affect Library compatibility
produce a new key. Setup is restartable and cleanup-safe without broadening HoneyBee Core's
workspace abstraction. TestPlay is no longer a prerequisite for Agent-only verified-patch Work;
compile and warm-test remain unavailable until TestPlay and its Bridge are configured. Automatic
downloads, provider fallback, GUI scheduling, Git Worktree
integration, Recipe/Semantic IR systems, and full power-loss durability remain out of scope.
