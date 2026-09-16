# ADR-071: Desktop authenticated update check

Date: 2026-09-13

Status: Desktop check/status/cancel UI implemented; download/apply UI remains pending.

This implements the UI discovery portion of fixed acceptance gate 04. It does not
add a VM qualification or claim the entire Update & Restart flow is complete.

## Connection

The title bar now contains a localized update-check action and a status panel.
Preload exposes three versioned IPC methods: `updateStatus`, `checkUpdate` and
`cancelUpdateCheck`. Their strict response contains only schema version, state,
offered version and mandatory flag. No renderer-provided URL, signing key, source
component identity or installation path is accepted. Main additionally requires
the requesting WebContents and frame to be the current Desktop's main frame.

`DesktopUpdateCheck` coalesces repeated checks, aborts on cancellation/quit and
ignores late results from older operations. Failed verification/network requests
remain failures rather than an up-to-date indication. The renderer polls only
while checking and prevents stale poll responses from overriding a later action.
Cancellation affects discovery, not projects or an application update transaction.

Main obtains the managed source component from `readInstalledStorage` and calls
the authenticated discovery implementation from ADR-070. Release metadata and
trusted keys stay in main. The trust JSON is imported into the application build;
there is no environment-variable or renderer override for trust keys.

## Trust availability and limits

`resources/update-trust-v1.json` currently has no production public keys. Such a
build immediately returns Unavailable without reading source state or accessing
the network. Development/fixture or unmanaged installations are also unavailable.
The beta channel and bootstrapper 1.0.0 are explicit current build settings; a
qualified distribution must bind them and actual public keys into the approved
signed build. A `.d.mts` declaration exposes only the discovery types needed by
Desktop; Vite bundles the actual implementation, not a duplicate verifier.

The UI currently checks and displays an authenticated offer; it does not download,
apply, promise restart, or imply that migration is implemented. Download progress,
independent updater handoff, consecutive-source recovery, service migration and
production signing remain in the fixed acceptance ledger.

## Verification

- Six controller tests passed: absent trust performs no I/O; duplicate requests;
  late completion after cancellation/new check; cancellation during source loading;
  verification failure and retry; quit/disposal.
- Main, preload and renderer TypeScript checks passed; changed TS/TSX passed ESLint.
- Renderer, preload and main production builds passed. Vite reported its existing
  large-renderer-chunk advisory, not a build failure.
- Actual Electron IPC/UI smoke passed, including the existing workbench flow.
- Visual fixture passed with the new action invoked through real preload/IPC.
  `output/update-check-ui/09-update-check.png` was visually inspected: the Korean
  unavailable message and close button fit inside the panel without hiding the
  title-bar controls. The fixture does not authenticate a live production release.
- No VM bundle, installed service or existing user project was modified.
