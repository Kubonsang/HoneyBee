# ADR-025: Fixed-manifest Component Manager v1

## Status

Accepted.

## Context

TestPlay is optional for Agent-only Unity work, while workspace-storage is part of every isolated
Work transaction. Requiring operators to enter executable paths made Setup fragile, but accepting
arbitrary release metadata would move trust from HoneyBee to the network. Projects also need an
exact, inspectable component identity instead of silently following whichever machine version was
installed most recently.

## Decision

Desktop Component Manager v1 manages only `workspace-storage` and optional `testplay`. It is not a
general plugin system. HoneyBee packages a strict compatibility manifest whose raw file SHA-256 is
pinned in code. Every approved release fixes the HoneyBee version, component version, platform,
architecture, payload roles, URL when downloaded, byte length, and SHA-256. TestPlay releases also
fix protocol 3 and the extracted Bridge tree digest. Redirects remain bounded to approved GitHub
release origins, downloads are size-bounded, and install occurs through a private staging directory
followed by immutable publish. Receipts and every later lock lookup re-hash all files and trees.

The packaged workspace-storage client and service host are installed automatically from bundled
bytes. Multiple exact versions may coexist in Component Manager storage, but Windows has one
machine-global `UnityWorkspaceStorage` service. Add Project chooses the already active supported
version or the manifest's preferred bundled version and performs any required elevated transition
internally; a transition is refused while a Run is active, cleanup-pending, or indeterminate. The installer compares the
approved service binary, uses durable fixed replacement/backup paths, and reconciles an interrupted
switch on the next invocation. A service without HoneyBee's exact machine receipt is a typed
`workspace-storage.service-conflict`, never an externally adopted success. Work start and Doctor require the project lock, the active-version
receipt, and the actual installed service executable digest to agree; mismatch fails closed.

New managed profiles use schema 3 and contain exact workspace-storage and optional TestPlay locks.
A lock includes component/version, receipt digest, and exact file/tree identities. Compatible
schema-2 profiles can be upgraded only when their pins match an approved installed component;
otherwise they remain legacy and are never silently relocked.

TestPlay installation is an explicit user action and is available only when the fixed compatibility
manifest contains a protocol-3 release. With no TestPlay lock, compile and warm-test controls stay
disabled. A successful Agent-only Work still produces a patch whose workspace and content-addressed
Artifact integrity are verified, but its patch manifest and Desktop result state explicitly record
compile and warm-test as `not-run`. It is not presented as capability-verified.

## Consequences

Fresh Desktop installs need no external storage path, version selector, or activation step. Project execution is reproducible against
exact local component locks, and an out-of-band service replacement is detected before Agent work.
TestPlay can evolve independently without becoming a hard HoneyBee dependency. Plugin discovery,
third-party manifests, dependency solving, automatic updates, registries, and arbitrary download
URLs remain out of scope.
