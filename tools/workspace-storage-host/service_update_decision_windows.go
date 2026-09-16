//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
)

type serviceOwnerRelease struct {
	SchemaVersion     int                  `json:"schemaVersion"`
	TransactionSHA256 string               `json:"transactionSha256"`
	ContextSHA256     string               `json:"contextSha256"`
	Owner             serviceRecoveryOwner `json:"owner"`
}

func serviceUpdateOwnerReleased(area *maintenanceArea, record serviceRecoveryContext, pin string) (bool, error) {
	data, err := area.restoreRecordStorage(area.assertHeld, 64<<10).read("service-owner-release-" + record.TransactionSHA256 + ".json")
	if os.IsNotExist(err) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	var value serviceOwnerRelease
	if err = decodeMaintenanceRecord(data, &value); err != nil {
		return false, err
	}
	if value != (serviceOwnerRelease{1, record.TransactionSHA256, pin, record.Owner}) {
		return false, errors.New("protected update owner release changed")
	}
	return true, nil
}

func requireServiceUpdateOwner(area *maintenanceArea, record serviceRecoveryContext, pin string) error {
	current, err := readServiceRecoveryContext(record.TransactionSHA256, pin, area.Path, area.restoreRecordStorage(area.assertHeld, 64<<10))
	if err != nil {
		return err
	}
	if current != record {
		return errors.New("protected service owner context changed")
	}
	released, err := serviceUpdateOwnerReleased(area, record, pin)
	if err != nil {
		return err
	}
	if released {
		return errors.New("service update owner has relinquished this transaction")
	}
	source, err := loadRecoverySource(area, record)
	if err != nil {
		return err
	}
	owner, err := captureServiceRecoveryOwner(record.Owner.PID, source.InitiatingSID)
	if err != nil {
		return err
	}
	if owner != record.Owner {
		return errors.New("service update owner exited or PID was reused")
	}
	return area.assertHeld()
}

func releaseServiceUpdateOwner(area *maintenanceArea, record serviceRecoveryContext, pin string) error {
	released, err := serviceUpdateOwnerReleased(area, record, pin)
	if err != nil {
		return err
	}
	if released {
		return nil
	}
	alive, err := serviceRecoveryOwnerAlive(record.Owner)
	if err != nil {
		return err
	}
	if alive {
		if err = requireServiceUpdateOwner(area, record, pin); err != nil {
			return err
		}
	}
	data, err := json.Marshal(serviceOwnerRelease{1, record.TransactionSHA256, pin, record.Owner})
	if err != nil {
		return err
	}
	return persistRestoreRecord("service-owner-release-"+record.TransactionSHA256+".json", data, 64<<10, area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld)
}

func abortInstalledServiceUpdate(area *maintenanceArea, record serviceRecoveryContext, pin string) error {
	if _, err := readServicePairCommit(area, record, pin); err == nil {
		return errors.New("committed pair decision cannot be rolled back")
	} else if !os.IsNotExist(err) {
		return err
	}
	return releaseServiceUpdateOwner(area, record, pin)
}

type servicePairCommit struct {
	SchemaVersion        int    `json:"schemaVersion"`
	TransactionSHA256    string `json:"transactionSha256"`
	ContextSHA256        string `json:"contextSha256"`
	TargetManifestSHA256 string `json:"targetManifestSha256"`
	TargetPointerSHA256  string `json:"targetPointerSha256"`
	TargetReceiptSHA256  string `json:"targetReceiptSha256"`
	DesktopValidationID  string `json:"desktopValidationId"`
	DoctorSHA256         string `json:"doctorSha256"`
}

func validateServicePairCommit(value servicePairCommit, record serviceRecoveryContext, pin string, replacement serviceReplacementRecord) error {
	if value.SchemaVersion != 1 || value.TransactionSHA256 != record.TransactionSHA256 || value.ContextSHA256 != pin || value.TargetManifestSHA256 != replacement.TargetManifestSHA256 || value.TargetPointerSHA256 != record.TargetPointerSHA256 || value.TargetReceiptSHA256 != replacement.TargetReceiptSHA256 || !migrationDigest(value.DesktopValidationID) || !migrationDigest(value.DoctorSHA256) {
		return errors.New("protected application/service commit identity mismatch")
	}
	return nil
}

func readServicePairCommit(area *maintenanceArea, record serviceRecoveryContext, pin string) (servicePairCommit, error) {
	var value servicePairCommit
	data, err := area.restoreRecordStorage(area.assertHeld, 64<<10).read("service-pair-commit-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return value, err
	}
	if err = decodeMaintenanceRecord(data, &value); err != nil {
		return value, err
	}
	source, err := loadRecoverySource(area, record)
	if err != nil {
		return value, err
	}
	replacement, err := loadRecoveryReplacement(area, record, source.Evidence)
	if err != nil {
		return value, err
	}
	return value, validateServicePairCommit(value, record, pin, replacement)
}

// Only the initiating update process can request the first durable pair decision.
// After it exists, reboot recovery finishes that exact decision without trusting
// a surviving user journal or re-running user executable code as LocalSystem.
func commitInstalledServiceUpdate(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext, pin, validationID, doctorPin string) error {
	decision, readErr := readServicePairCommit(area, record, pin)
	if readErr != nil && !os.IsNotExist(readErr) {
		return readErr
	}
	if os.IsNotExist(readErr) {
		alive, err := serviceRecoveryOwnerAlive(record.Owner)
		if err != nil {
			return err
		}
		if alive {
			if err := requireServiceUpdateOwner(area, record, pin); err != nil {
				return err
			}
		} else {
			// A restarted, authenticated service session may finish an in-flight
			// commit after the original coordinator exited. It must still supply
			// validation evidence and pass native target/mount health below.
			released, err := serviceUpdateOwnerReleased(area, record, pin)
			if err != nil {
				return err
			}
			if released {
				return errors.New("abandoned service transaction cannot commit")
			}
		}
	}
	selection, err := recoveryApplicationSelection(record)
	if err != nil {
		return err
	}
	if selection != "target" {
		return errors.New("pair commit requires admitted target application")
	}
	source, err := loadRecoverySource(area, record)
	if err != nil {
		return err
	}
	replacement, err := loadRecoveryReplacement(area, record, source.Evidence)
	if err != nil {
		return err
	}
	journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
	if err != nil {
		return err
	}
	defer journal.closePrivate()
	if journal.state() != "ReadyForAppCommit" && journal.state() != "Committed" {
		return errors.New("service has not reached pair commit readiness")
	}
	arm := func(serviceSourceRecord) error {
		return armInstalledServiceRecovery(ctx, area, record, record.registration(pin))
	}
	if err = resumeInstalledPair(ctx, area, record, source, targetReplacementEvidence(replacement), false, arm); err != nil {
		return err
	}
	if os.IsNotExist(readErr) {
		decision = servicePairCommit{1, record.TransactionSHA256, pin, replacement.TargetManifestSHA256, record.TargetPointerSHA256, replacement.TargetReceiptSHA256, validationID, doctorPin}
		if err = validateServicePairCommit(decision, record, pin, replacement); err != nil {
			return err
		}
		data, err := json.Marshal(decision)
		if err != nil {
			return err
		}
		if err = persistRestoreRecord("service-pair-commit-"+record.TransactionSHA256+".json", data, 64<<10, area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld); err != nil {
			return err
		}
	}
	if journal.state() != "Committed" {
		if err = journal.mark("Committed"); err != nil {
			return err
		}
	}
	// Commit the durable pair first. A reboot in the next call is forward replay,
	// never an automatic start of an uncommitted candidate.
	return resumeInstalledPair(ctx, area, record, source, targetReplacementEvidence(replacement), true, arm)
}
