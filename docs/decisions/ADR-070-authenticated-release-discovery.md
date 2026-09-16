# ADR-070: Authenticated release discovery

Date: 2026-09-13

Status: Internal discovery/authentication/staging composition implemented and tested;
Desktop integration and production trust provisioning pending.

This work implements parts of fixed acceptance gates 04 and 12 in
`docs/validation/installation-update-v1-acceptance.md`. It adds no VM gate.

## Trust boundary

Existing manifest SHA-256 checks bind bytes but do not authenticate their publisher.
`release-authentication.mjs` signs/verifies exact manifest bytes with Ed25519 and
the byte prefix `HoneyBee release manifest signature v1\n`. The detached
`release.sig.json` has exactly `schemaVersion: 1`, `algorithm: ed25519`, `keyId`,
`manifestSha256`, and a canonical base64 signature. `keyId` is the SHA-256 of the
public key's DER SPKI. Verification accepts only caller-supplied trusted public
keys; the manifest or signature cannot provide its own trust key. Empty trust,
unknown signer, other algorithms, noncanonical encodings, altered bytes and extra
envelope fields fail closed. Signature metadata is capped at 4 KiB; release
metadata remains capped at 64 KiB.

The implementation uses [Node's crypto sign/verify API](https://nodejs.org/api/crypto.html#cryptoverifyalgorithm-data-key-signature-callback)
with a null algorithm for Ed25519. No private key is generated or persisted by
release code. Tests generate ephemeral keys in memory. A real trust root must be
bound into the approved application/recovery build before this becomes a user
update path. Detached manifest signatures do not replace Authenticode signing of
Setup and native executable artifacts.

## Discovery and download

`release-discovery.mjs` reads at most 100 entries from the fixed repository's
GitHub Releases API, caps the body at 2 MiB and uses a 30-second deadline. Drafts,
invalid tags, installed/older versions and other channels are ignored. The highest
matching version must provide exactly one `release.json` and `release.sig.json`
asset at the expected repository/tag paths. Discovery metadata is routing input,
not authority. Authentication and existing source/bootstrapper/service admission
must pass, and the signed version must match the selected tag. Invalid newest
metadata is an error, not a silent fallback to an older candidate. Network errors
are not reported as "up to date". Beta and stable remain distinct v1 channels.

`authenticated-release.mjs` reuses the existing HTTPS host/redirect policy, bounds
metadata reads and performs signature/source admission before calling the existing
package staging primitive. Discovery alone does not download an application.
Staging alone does not activate files. Legacy digest-only tooling remains internal;
production UI must enter through trusted discovery/authentication and must not
accept renderer-supplied trust keys or downgrade to unsigned metadata.

Staging also admits available capacity before creating an attempt: package length
plus 64 MiB metadata/headroom, using `statfs` caller-available blocks. This is an
advisory download check, not a reservation or an extraction/service-backup estimate.
Insufficient capacity fails with ENOSPC before package download or staging writes.
The existing write/hash failure paths still preserve evidence if capacity changes.
An optional progress callback reports frozen `Downloading` byte counts and reports
`Verified` only after complete hash validation. It can trigger AbortSignal-based
user cancellation; the authenticated composition forwards this callback.

This implementation does not persist a revocation or freshness policy and does
not claim protection against a withheld release index. Existing version admission
prevents installing the current or an older release. Consecutive-update recovery
approval and privileged service admission must independently reuse the trusted
release binding when those remaining components are implemented.

## Checks and remaining integration

54 local tests passed: 31 new authentication/discovery/composition tests, 19
existing staging tests and four new capacity/progress tests. These cover real cryptographic verification, source/channel
admission, index/metadata bounds, untrusted routing, cancellation and proving no
package download or installation writes on metadata refusal. Transport responses
are injected; a live signed GitHub release is still part of final gate 16.

Changed JavaScript passed ESLint and Prettier. The new suite is included in
`test:run` through `test:update-trust`. This work has
not enabled a Desktop update button, published a release, provisioned signing
credentials, modified an installed service or rebuilt the pinned recovery runtime.
