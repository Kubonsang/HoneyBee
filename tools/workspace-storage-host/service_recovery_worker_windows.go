//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

var errRecoveryWaitingForApplication = errors.New("service recovery is waiting for source application selection")

func runServiceRecoveryWorker(transaction, pin string) error {
	if !migrationDigest(transaction) || !migrationDigest(pin) {
		return errors.New("protected recovery arguments required")
	}
	var record serviceRecoveryContext
	handler := &recoveryWorkerHandler{
		initialize: func() error { var err error; record, err = loadInstalledRecoveryWorker(transaction, pin); return err },
		work: func(ctx context.Context) error {
			if err := watchServiceRecovery(ctx, record, pin, recoverInstalledService); err != nil {
				return err
			}
			// Retain the named recovery service as evidence, but do not run an old
			// completed transaction on every boot or interfere with future updates.
			manager, err := mgr.Connect()
			if err != nil {
				return err
			}
			defer manager.Disconnect()
			registration := record.registration(pin)
			service, err := manager.OpenService(registration.name())
			if err != nil {
				return err
			}
			defer service.Close()
			config, err := service.Config()
			if err != nil {
				return err
			}
			if !recoveryServiceConfigMatches(config, registration) {
				return errors.New("completed recovery registration changed")
			}
			status, err := service.Query()
			if err != nil {
				return err
			}
			if status.ProcessId != uint32(os.Getpid()) {
				return errors.New("completed recovery is owned by another process")
			}
			return (nativeMaintenanceService{service}).setStartType(mgr.StartDisabled)
		},
	}
	return svc.Run((serviceRecoveryRegistration{TransactionSHA256: transaction}).name(), handler)
}

func loadInstalledRecoveryWorker(transaction, pin string) (serviceRecoveryContext, error) {
	var record serviceRecoveryContext
	area, records, closeReader, err := openMaintenanceReader()
	if err != nil {
		return record, err
	}
	defer closeReader()
	record, err = readServiceRecoveryContext(transaction, pin, area, records)
	if err != nil {
		return record, err
	}
	executable, err := os.Executable()
	if err != nil {
		return record, err
	}
	if !strings.EqualFold(executable, record.WorkerExecutable) {
		return record, errors.New("recovery must run from its protected candidate")
	}
	keys, _, err := installedReleaseTrust()
	if err != nil {
		return record, err
	}
	data, err := records.read("service-candidate-" + transaction + ".json")
	if err != nil {
		return record, err
	}
	var candidate serviceCandidateRecord
	if err = decodeMaintenanceRecord(data, &candidate); err != nil {
		return record, err
	}
	admitted, err := validateCandidateRecord(candidate, transaction, record.ReleaseSource, keys)
	if err != nil {
		return record, err
	}
	if filepath.Join(area, candidate.PayloadName, "host.exe") != record.WorkerExecutable || admitted.ExecutableSHA256 != record.WorkerSHA256 {
		return record, errors.New("recovery executable differs from signed candidate")
	}
	held, err := verifyColdBackup(filepath.Join(area, candidate.PayloadName), candidate.PayloadSHA256, func() error { return nil })
	if err != nil {
		return record, err
	}
	defer held.close()
	if err = matchServiceCandidate(held.manifest, admitted); err != nil {
		return record, err
	}
	source, err := loadServiceSourceRecord(filepath.Dir(area), transaction, record.SourceEvidenceSHA256, records, func() error { return nil })
	if err != nil {
		return record, err
	}
	if source.Evidence.Receipt.WorkspaceRoot != filepath.Join(record.ApplicationRoot, "Workspaces") || source.Evidence.Receipt.ComponentVersion != record.ReleaseSource.ComponentVersion {
		return record, errors.New("recovery worker original user binding changed")
	}
	identityBytes, err := evidenceBytes(filepath.Join(area, record.MigrationName, "identity.json"), 64<<10)
	if err != nil {
		return record, err
	}
	var identity migrationIdentity
	if err = decodeMaintenanceRecord(identityBytes, &identity); err != nil {
		return record, err
	}
	if evidenceHash(identityBytes) != record.MigrationSHA256 || identity.SchemaVersion != 3 || identity.SourceEvidenceSHA256 != record.SourceEvidenceSHA256 || identity.SourceComponent != source.Evidence.Receipt.ComponentVersion || identity.TargetManifestSHA256 != admitted.ManifestSHA256 || identity.TargetComponent != admitted.Release.Components.Storage.ComponentVersion {
		return record, errors.New("recovery worker migration identity changed")
	}
	return record, nil
}

type recoveryWorkerHandler struct {
	initialize func() error
	work       func(context.Context) error
}

func (h *recoveryWorkerHandler) Execute(_ []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	changes <- svc.Status{State: svc.StartPending, WaitHint: 30000}
	if h.initialize == nil || h.work == nil {
		return true, 1
	}
	if err := h.initialize(); err != nil {
		return true, 2
	}
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- h.work(ctx) }()
	status := svc.Status{State: svc.Running, Accepts: svc.AcceptStop | svc.AcceptShutdown}
	changes <- status
	for {
		select {
		case err := <-finished:
			if err != nil && !errors.Is(err, context.Canceled) {
				return true, 3
			}
			return false, 0
		case request, ok := <-requests:
			if !ok {
				cancel()
				return true, 4
			}
			switch request.Cmd {
			case svc.Interrogate:
				changes <- status
			case svc.Stop, svc.Shutdown:
				cancel()
				changes <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				timer := time.NewTimer(30 * time.Second)
				defer timer.Stop()
				select {
				case <-finished:
					return false, 0
				case <-timer.C:
					return true, 5
				}
			}
		}
	}
}

func recoveryLockBusy(err error) bool {
	return errors.Is(err, windows.ERROR_SHARING_VIOLATION) || errors.Is(err, windows.STATUS_SHARING_VIOLATION) || errors.Is(err, windows.ERROR_LOCK_VIOLATION)
}

// The live updater owns the operation lock. The worker remains alive across its
// lifetime, takes over only after release/crash, and also starts independently at
// boot. Unknown failures are not treated as a busy writer or a successful update.
func watchServiceRecovery(ctx context.Context, record serviceRecoveryContext, pin string, attempt func(context.Context, *maintenanceArea, serviceRecoveryContext) (bool, error)) error {
	if attempt == nil {
		return errors.New("recovery dispatcher required")
	}
	ticker := time.NewTicker(time.Second)
	defer ticker.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		area, err := openMaintenanceArea()
		if err == nil {
			current, readErr := readServiceRecoveryContext(record.TransactionSHA256, pin, area.Path, area.restoreRecordStorage(area.assertHeld, 64<<10))
			if readErr != nil {
				area.close()
				return readErr
			}
			if current != record {
				area.close()
				return errors.New("protected recovery context changed")
			}
			done, recoverErr := attempt(ctx, area, record)
			area.close()
			if recoverErr != nil && !errors.Is(recoverErr, errRecoveryWaitingForApplication) {
				return recoverErr
			}
			if done {
				return nil
			}
		} else if !recoveryLockBusy(err) {
			return err
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}
