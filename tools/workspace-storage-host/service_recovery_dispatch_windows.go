//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type serviceBackupRecord struct {
	SchemaVersion        int    `json:"schemaVersion"`
	TransactionSHA256    string `json:"transactionSha256"`
	SourceEvidenceSHA256 string `json:"sourceEvidenceSha256"`
	Name                 string `json:"name"`
	SHA256               string `json:"sha256"`
}

func verifyRecoveryBackup(area *maintenanceArea, record serviceRecoveryContext, source serviceEvidence) error {
	data, err := area.restoreRecordStorage(area.assertHeld, 64<<10).read("service-backup-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return err
	}
	var backup serviceBackupRecord
	if err = decodeMaintenanceRecord(data, &backup); err != nil {
		return err
	}
	if backup.SchemaVersion != 1 || backup.TransactionSHA256 != record.TransactionSHA256 || backup.SourceEvidenceSHA256 != record.SourceEvidenceSHA256 || validateColdBackupName(backup.Name) != nil || strings.Contains(backup.Name, "/") || !migrationDigest(backup.SHA256) {
		return errors.New("protected service backup identity mismatch")
	}
	held, err := verifyColdBackup(filepath.Join(area.Path, backup.Name), backup.SHA256, area.assertHeld)
	if err != nil {
		return err
	}
	defer held.close()
	inventory, err := readStoreRestoreInventory(held)
	if err != nil {
		return err
	}
	expected := map[string]string{"broker/unity-workspace-storage-host.exe": source.ExecutableSHA256, "install-receipt.json": source.ReceiptSHA256, "broker-config.json": source.ConfigSHA256}
	for _, entry := range inventory.Entries {
		if pin, ok := expected[entry.Name]; ok {
			if entry.Directory || entry.SHA256 != pin {
				return errors.New("backup differs from original component pair")
			}
			delete(expected, entry.Name)
		}
	}
	if len(expected) != 0 {
		return errors.New("backup omits original component files")
	}
	return area.assertHeld()
}

func recoveryApplicationSelection(record serviceRecoveryContext) (string, error) {
	data, err := evidenceBytes(filepath.Join(record.ApplicationRoot, "current.json"), 64<<10)
	if err != nil {
		return "", err
	}
	switch evidenceHash(data) {
	case record.SourcePointerSHA256:
		return "source", nil
	case record.TargetPointerSHA256:
		return "target", nil
	default:
		return "unknown", nil
	}
}

func targetReplacementEvidence(record serviceReplacementRecord) serviceEvidence {
	result := record.Source
	result.Receipt = record.Target
	result.ReceiptSHA256 = record.TargetReceiptSHA256
	result.ExecutableSHA256 = record.Target.ExecutableSHA256
	return result
}

// Recovery never replays a user command line. Both SCM targets and every input
// path below come from the fixed service's protected original/candidate records.
func recoverInstalledService(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext) (bool, error) {
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return area.assertHeld()
	}
	if err := check(); err != nil {
		return false, err
	}
	records := area.restoreRecordStorage(check, 16<<20)
	source, err := loadServiceSourceRecord(filepath.Dir(area.Path), record.TransactionSHA256, record.SourceEvidenceSHA256, records, check)
	if err != nil {
		return false, err
	}
	if source.Evidence.Receipt.WorkspaceRoot != filepath.Join(record.ApplicationRoot, "Workspaces") || source.Evidence.Receipt.ComponentVersion != record.ReleaseSource.ComponentVersion {
		return false, errors.New("recovery user/source binding changed")
	}
	journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
	if err != nil {
		return false, err
	}
	defer journal.closePrivate()
	terminal := journal.state() == "Committed" || journal.state() == "RolledBack" || journal.state() == "Resumed" || journal.state() == "Failed"
	contextBytes, err := records.read("service-recovery-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return false, err
	}
	contextPin := evidenceHash(contextBytes)
	if !terminal {
		released, releaseErr := serviceUpdateOwnerReleased(area, record, contextPin)
		if releaseErr != nil {
			return false, releaseErr
		}
		alive, err := serviceRecoveryOwnerAlive(record.Owner)
		if err != nil {
			return false, err
		}
		if alive && !released {
			return false, nil
		}
	}
	selection, err := recoveryApplicationSelection(record)
	if err != nil {
		return false, err
	}
	if selection == "unknown" {
		return false, errors.New("unknown application selection blocks service recovery")
	}
	_, decisionErr := readServicePairCommit(area, record, contextPin)
	if decisionErr != nil && !os.IsNotExist(decisionErr) {
		return false, decisionErr
	}
	if decisionErr == nil && selection != "target" {
		return false, errors.New("protected pair commit requires target application recovery")
	}
	// Application pointer writes remain in the unelevated Launcher. System must
	// not follow writable application paths to change user files on its behalf.
	if selection == "target" && journal.state() != "Committed" {
		if _, err := readServicePairCommit(area, record, contextPin); err != nil {
			if os.IsNotExist(err) {
				return false, errRecoveryWaitingForApplication
			}
			return false, err
		}
		if journal.state() != "ReadyForAppCommit" {
			return false, errors.New("commit decision conflicts with service journal")
		}
	}
	keys, _, err := installedReleaseTrust()
	if err != nil {
		return false, err
	}
	arm := func(serviceSourceRecord) error {
		// The executing worker is the registered recovery owner. Recheck its
		// immutable context; never recursively start a second recovery process.
		data, err := records.read("service-recovery-" + record.TransactionSHA256 + ".json")
		if err != nil {
			return err
		}
		return armInstalledServiceRecovery(ctx, area, record, record.registration(evidenceHash(data)))
	}
	resume := func(expected serviceEvidence, automatic bool) error {
		transaction := record.TransactionSHA256
		if expected != source.Evidence {
			transaction = evidenceHash([]byte("target-recovery:" + transaction))
		}
		bound, err := openMaintenanceServiceFromOriginal(area, source.InitiatingSID, expected, &source.Original, transaction, arm)
		if err != nil {
			return err
		}
		defer bound.close()
		_, err = records.read("service-topology-" + record.TransactionSHA256 + ".json")
		if os.IsNotExist(err) {
			status, err := bound.handle.Query()
			if err != nil {
				return err
			}
			if expected != source.Evidence || (status.State != svc.Running && status.State != svc.Paused) {
				return errors.New("stopped service has no protected topology")
			}
			return bound.resume(ctx)
		}
		if err != nil {
			return err
		}
		return bound.resumeRecordedTopology(ctx, area, record.TransactionSHA256, source.Evidence, automatic)
	}
	loadReplacement := func() (serviceReplacementRecord, error) {
		var replacement serviceReplacementRecord
		data, err := records.read("service-replacement-" + record.TransactionSHA256 + ".json")
		if err != nil {
			return replacement, err
		}
		if err = decodeMaintenanceRecord(data, &replacement); err != nil {
			return replacement, err
		}
		if replacement.Source != source.Evidence || replacement.TransactionSHA256 != record.TransactionSHA256 {
			return replacement, errors.New("replacement differs from original recovery pair")
		}
		return replacement, nil
	}
	rollback := func() error {
		// A previous rollback may have restored and restarted the original pair
		// before its terminal journal write. Do not try to drain it as the target.
		if held, err := holdMaintenanceSource(source.Evidence, check); err == nil {
			held.close()
			return resume(source.Evidence, true)
		}
		replacement, err := loadReplacement()
		if err != nil {
			return err
		}
		quiet, closeControl, err := quiesceRecoveryService(ctx, area, record, source, replacement, arm)
		if err != nil {
			return err
		}
		defer closeControl()
		if err = area.rollbackServiceFiles(replacement, record.ReleaseSource, keys, quiet); err != nil {
			return err
		}
		return resume(source.Evidence, true)
	}
	validateTarget := func() error {
		replacement, err := loadReplacement()
		if err != nil {
			return err
		}
		return resume(targetReplacementEvidence(replacement), journal.state() == "Committed")
	}
	unavailable := func() error { return errors.New("boot recovery cannot initiate a new forward migration") }
	hooks := migrationHooks{AssertHeld: check, ValidateSource: func() error { return resume(source.Evidence, true) }, CaptureBackup: unavailable, VerifyBackup: func() error { return verifyRecoveryBackup(area, record, source.Evidence) }, StopSource: unavailable, PauseSource: unavailable, ReserveDisks: unavailable, QuiesceDisks: unavailable, ResumeSource: func() error { return resume(source.Evidence, true) }, Replace: unavailable, ValidateTarget: validateTarget, RestoreSource: rollback, AppSelection: func() (string, error) { return recoveryApplicationSelection(record) }}
	hooks.AuthorizeCommit = func() error { _, err := readServicePairCommit(area, record, contextPin); return err }
	if err = journal.recover(hooks); err != nil {
		if errors.Is(err, errInstalledServiceProcessAlive) {
			return false, nil
		}
		return false, err
	}
	if journal.state() == "Committed" {
		if err := validateTarget(); err != nil {
			return false, err
		}
	}
	return true, nil
}

func quiesceRecoveryService(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext, source serviceSourceRecord, replacement serviceReplacementRecord, arm func(serviceSourceRecord) error) (func() error, func(), error) {
	manager, err := mgr.Connect()
	if err != nil {
		return nil, nil, err
	}
	service, err := manager.OpenService(workspace.WindowsServiceName)
	if err != nil {
		_ = manager.Disconnect()
		return nil, nil, err
	}
	close := func() { _ = service.Close(); _ = manager.Disconnect() }
	reject := func(err error) (func() error, func(), error) { close(); return nil, nil, err }
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := area.assertHeld(); err != nil {
			return err
		}
		config, err := service.Config()
		if err != nil {
			return err
		}
		if !maintenanceConfigMatches(config, source.Original) {
			return errors.New("service configuration changed during recovery")
		}
		return nil
	}
	if err = check(); err != nil {
		return reject(err)
	}
	status, err := service.Query()
	if err != nil {
		return reject(err)
	}
	quiet := func() error {
		if err := check(); err != nil {
			return err
		}
		config, err := service.Config()
		if err != nil {
			return err
		}
		if config.StartType != mgr.StartDisabled {
			return errors.New("service automatic/demand startup remains enabled during disk quiescence")
		}
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped || status.ProcessId != 0 {
			return errInstalledServiceProcessAlive
		}
		return assertInstalledServiceProcessExited(source.Evidence.Receipt.Executable)
	}
	if status.State == svc.Running || status.State == svc.Paused {
		target := targetReplacementEvidence(replacement)
		tx := evidenceHash([]byte("rollback-drain:" + record.TransactionSHA256))
		bound, err := openMaintenanceServiceFromOriginal(area, source.InitiatingSID, target, &source.Original, tx, arm)
		if err != nil {
			return reject(err)
		}
		defer bound.close()
		if status.State == svc.Running {
			if err = bound.pause(ctx); err != nil {
				return reject(err)
			}
		}
		reservation, err := bound.reserve(area, tx)
		if err != nil {
			return reject(err)
		}
		defer reservation.close()
		if err = bound.stop(ctx); err != nil {
			return reject(err)
		}
		if err = reservation.quiesce(quiet); err != nil {
			return reject(err)
		}
	} else if status.State != svc.Stopped {
		return reject(errInstalledServiceProcessAlive)
	}
	if err = arm(source); err != nil {
		return reject(err)
	}
	if err = (nativeMaintenanceService{service}).setStartType(mgr.StartDisabled); err != nil {
		return reject(err)
	}
	if err = quiet(); err != nil {
		return reject(err)
	}
	// A process crash loses reservation handles. Re-establish a complete native
	// lock set before touching files; SCM Stopped alone says nothing about VHDX.
	tx, err := newServiceTransactionID()
	if err != nil {
		return reject(err)
	}
	reservation, err := area.reserveTopology(source.Evidence, tx, quiet)
	if err != nil {
		return reject(err)
	}
	if err = reservation.quiesce(quiet); err != nil {
		return reject(err)
	}
	return quiet, close, nil
}

func verifyNativeRecoveryRegistration(registration serviceRecoveryRegistration) error {
	manager, err := mgr.Connect()
	if err != nil {
		return err
	}
	defer manager.Disconnect()
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
		return errors.New("recovery boot registration changed")
	}
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Running || status.ProcessId == 0 {
		return errors.New("recovery worker is not running")
	}
	_, closeProcess, err := holdMaintenanceProcess(registration.Executable, status.ProcessId)
	if err != nil {
		return err
	}
	defer closeProcess()
	return nil
}
