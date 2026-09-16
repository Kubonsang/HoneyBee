# ADR-045: Service identity evidence and component backup

## Status

Implemented in the Storage host source after ADR-044. The new `service-evidence`
command observes SCM/receipt/configuration/binary identity and can preserve those
component files in a new backup directory. This is a prerequisite for a future
migrator, not a working service migration or full data rollback mechanism.

The existing installed host, VM, Setup preview and approved package digests were
not replaced in this increment. New source must pass the existing pinned-source
packaging/integrity workflow before distribution. ADR-046 subsequently connects the read-only evidence command to Core planning,
while preserving the rollback and locked-recheck gates. An older installed host
does not support the new command.

## Observation

```text
honeybee-workspace-storage-host.exe service-evidence
```

The command returns `{schemaVersion: 1, ok: true, evidence: ...}` on success. Errors
use the existing host error envelope. No service control operation is performed.
SCM handles request query-config and query-status access only. Access denied,
missing service, non-running state and inconsistent metadata return errors.

Inspection requires:

- a valid schema-2 receipt owned by the invoking SID;
- canonical receipt, broker config and broker executable locations beneath its store;
- local, non-redirected, separate store/workspace roots that currently exist;
- SCM command arguments matching the existing receipt command validator;
- LocalSystem, automatic startup and a standalone Win32 service process;
- broker configuration matching the installer's existing expected configuration;
- executable SHA-256 matching the installation receipt;
- no pending/previous binary or receipt replacement evidence.

The command records SCM command, account, start type, service type and state,
plus the receipt and hashes of the receipt, config and executable. It deliberately
does not serialize the complete mgr.Config struct, which includes unrelated and
password-shaped fields. It does not capture recovery actions, ACLs, dependencies,
delayed-start settings, service SID settings or a full SCM restore specification.

Receipt/config bytes are bounded to 64 KiB and broker bytes to 128 MiB. Receipt
parsing now reuses `decodeReceipt`; it rejects trailing JSON for all callers.
Inspection parses the same captured bytes it hashes, rechecks receipt/config bytes,
and queries SCM again before returning. This detects ordinary drift but is not
an atomic system snapshot or protection against an administrator racing changes.

## Component backup

```text
honeybee-workspace-storage-host.exe service-evidence --backup-directory NEW_DIRECTORY
```

This variant refuses an elevated caller. It never launches UAC or accepts a
service replacement flag. The destination must be a new local directory whose
parent exists, must not be redirected, and must not overlap either service data
root in either direction. Existing destinations are never reused or overwritten.

The resulting directory contains:

```text
001-Capturing.json
install-receipt.json
broker-config.json
broker.exe
002-Captured.json
```

Each file is created exclusively, synced and closed. Every source is checked against
the initial evidence before copying. Copied bytes are read back and verified. After
all copies, service identity is captured again and compared with the original, and
all backup file hashes are rechecked before writing the final evidence record.

Failures retain partial output and return an error. Disk-full or process termination
may leave a missing or truncated journal; a directory or filename is never proof of
a complete backup. Retry must use a new destination. There is no cleanup, repair,
restore, service stop/start or installation-pointer mutation in this command.

## Recovery authority and remaining work

All evidence explicitly sets `recoveryReady: false`. The running service's store,
VHDX images, workspace mounts, user worktrees, project registry and branches are
not backed up. Live service operations are not quiesced and this command does not
hold the future updater/operation lock. Therefore a successful component capture
must never authorize `install --replace`, data migration or automatic rollback.

The future migrator must acquire operation ownership, establish a coherent backup
strategy for mutable store/workspace state, capture the remaining SCM/ACL settings,
revalidate original-user identity across elevation, verify backup restoration,
and persist a recovery journal before replacing anything. It must recheck these
component hashes under that transaction. User-writable backup files are evidence,
not trusted input for a future elevated restore operation.

The current installer's configuration equality rules intentionally reject custom
quota/configuration variants. Supporting those variants requires a deliberate
configuration-preservation contract, not silently normalizing them during update.

## Validation

Five new Go test groups cover admitted identity; SCM/account/start/state/user
mismatches; damaged binary/config/receipt and pending replacement evidence;
byte-exact backup and overwrite/overlap refusal; interruption after each copied
file, changing source identity, tampered backup data; and unsupported command
arguments. Tests use fake SCM observations and disposable filesystem fixtures.
The complete Storage host Go test and vet suites pass.

Tests required execution outside the tool sandbox because existing Windows
handle/path tests receive Access denied there. No real service was queried,
installed, stopped or changed for qualification. Real-machine SCM capture, backup
permissions, reboot/power-loss and restore qualification remain outstanding.
