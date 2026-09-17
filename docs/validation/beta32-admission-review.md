# beta.32 compatibility and artifact review

The candidate is unchanged: Setup SHA-256
`8b4dc6b513e2a0190b1d429284070fbf1cc3df08e2877804fba6b22153a5b56e`,
manifest SHA-256
`43fdd39e04c0d4a34bd5b0b92ead99e5044e2d41df82548621acd79741f2a9d3`.

## Gate 11: reviewed pass

`scripts/qualification/verify-beta32-admission.mjs` ran successfully against the
assembled candidate, not rebuilt working-tree modules. Evidence is
`output/acceptance-completion-20260916/admission-V6OFSk/result.json`.
Before importing code it verified the pinned recovery inventory and every listed
file, and compared all compiled core JavaScript files with the installed CLI
copies. The native control/client bytes matched installation metadata. This
establishes which implementation was exercised; it is not a native fault test.

The authenticated production manifest admits beta.31 or newer sources below
beta.32 with bootstrapper 1.0.0 or newer and exact hb13 service compatibility.
Positive admission passed. Source beta.30, bootstrapper 0.0.9, wrong channel,
same version, downgrade, older hb12 and unsupported newer hb14 were refused.
The shipped compiled core rejected both service mismatch directions using
diagnostic boundary fixtures. The shipped planner rejected unsupported source
components before a native probe and never authorized activation.

`observe-source.mjs` routes the real preflight through these admission and planner
functions. Actual compatible-service integration is covered separately by the
reported beta.32 normal update, Setup Repair, installed Doctor and ZIP adoption
passes already retained in the ledger. Incompatible live services were not
installed for this check. Together the boundary refusals and actual compatible
integration cover the fixed gate; no migration of public hb12 is claimed.

## Gate 12: additional coverage, still partial

The same run authenticated the actual release with the packaged trust key and
refused changed manifest bytes, an untrusted signer and a damaged signature.
The exact native extractor already passed eleven black-box cases recorded in
`output/acceptance-completion-20260916/extractor-934b7a96f4ed47949b80c9f0e42266c1/result.json`.
Do not rerun either set merely to regenerate logs.

The retained `candidate-refusal-tests-unsandboxed.log` reports 65 passing tests
and one failed test-file import. The failed file is distribution-policy.test.mjs,
whose isolated build lacks scripts/qualification/final-acceptance.mjs. The
individual signature, discovery, staging damage, cancellation, source drift and
plan-integrity passes remain evidence, but the entire run must not be described
as successful. Current publication policy has its own passing tests. Final
packaged Desktop integration still needs reconciliation, so gate 12 remains
partial rather than being promoted by these lower-level results.

## Gate 13: no promotion

Initial capacity refusal and staging capacity checks already have retained
passes. The VM's host-capacity watchdog is infrastructure protection, not proof
of product disk-full recovery. Native backup/restore and extraction/write/lock
failure coverage must still be tied to the candidate. No host disk was filled,
no VM operation was performed and no release was published by this review.
