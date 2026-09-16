# ADR-072: Desktop authenticated update download

Date: 2026-09-13

Status: Download/progress/cancel composition implemented; activation handoff pending.

This continues fixed gate 04 without a new manual VM qualification.

## Behavior

Desktop retains an authenticated offer in main. A new argument-free
`desktop.update.download.v1` IPC starts downloading only when such an offer exists.
The renderer supplies no release address, hash, key, compatibility fact or target
path. The same main-frame admission as update-check applies. The installation root
is derived from packaged resources (`root/versions/version/desktop/resources`).

Before staging, main reads the managed source facts again and the authenticated
downloader fetches and verifies signed metadata again. It now accepts an expected
manifest digest and rejects a changed offer before package download or staging
writes, even if the changed metadata has a valid trusted signature. Legacy internal
callers may omit that optional pin; the Desktop path always supplies it.

The controller reports Downloading and byte progress, then Downloaded only after
the staging result has the expected version/digest and Verified state. These fields
extend the existing v1 Desktop status schema. The UI shows a Download button for an
offer, a progress indicator and cancellation while downloading, and explicitly says
downloaded files have not been installed. Download errors require a new check.

Repeated requests cannot start concurrent downloads. Cancellation aborts the active
request and invalidates late progress/results. New check/download work remains
blocked until the old staging promise settles, preventing overlapping cleanup and
retry. Closing Desktop aborts ongoing work. Existing staging retains partial/failure
evidence and never switches the active version.

## Checks

- Eleven controller tests passed, including five download cases: main-owned offer
  and refreshed source, duplicate request suppression, cancellation/late completion,
  stage failure and mismatched completed manifest/version.
- Fifty-five authentication/discovery/staging tests passed, including a new test
  that a different valid signed offer cannot replace the user's selection.
- Main/preload/renderer type checks, ESLint, formatting and production builds passed.
- Actual Electron IPC/UI smoke passed. The real production-signed download journey
  remains a final integrated gate; these download tests use injected responses.

The build still has no production signing trust keys, so ordinary runs continue
to report updates unavailable. This change does not enable unsigned updates, run
an extractor, alter an installed version/service, or claim Update & Restart is
finished. The independent updater handoff, durable activation/recovery binding and
service migration remain to be connected before the final integrated VM bundle.
