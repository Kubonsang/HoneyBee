//go:build windows

package main

import (
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Internal cold-store restoration only: callers retain service startup inhibition,
// detached disks and writer exclusion. Completion does not restore mounts/SCM,
// start the service, select an app version or waive subsequent health validation.
func (area *maintenanceArea) executeStoreRestore(record storeRestoreRecord, assertStopped func() error) error {
	if err := area.checkRestoreRecord(record, assertStopped); err != nil {
		return err
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	// Revalidate immutable backup authority on every invocation. Candidate files
	// may already be consumed by an interrupted restore, but backup must be intact.
	backup, err := verifyColdBackup(filepath.Join(area.Path, record.Identity.BackupName), record.Identity.BackupSHA256, check)
	if err != nil {
		return err
	}
	defer backup.close()
	source, err := readStoreRestoreInventory(backup)
	if err != nil {
		return err
	}
	if hashStoreInventory(source) != record.Plan.SourceInventorySHA256 {
		return errors.New("restore record differs from pinned backup inventory")
	}
	hooks := storeRestoreHooks{
		AssertStopped:     check,
		CreateDirectory:   func(entry storeInventoryEntry) error { return area.createRecordedDirectory(record, entry, check) },
		PreserveDirectory: func(entry storeInventoryEntry) error { return area.preserveRecordedDirectory(record, entry, check) },
		RestoreMetadata:   func(entry storeInventoryEntry) error { return area.restoreRecordedMetadata(record, entry, check) },
		RestoreFile: func(step storeRestoreFileStep) error {
			preservation, err := openPrivateMaintenanceChild(area.directory, record.Identity.PreviousName, true)
			if err != nil {
				return err
			}
			defer windows.CloseHandle(preservation)
			files, err := openPrivateMaintenanceChild(preservation, "files", true)
			if err != nil {
				return err
			}
			defer windows.CloseHandle(files)
			paths := restoreFilePaths{
				Target:    filepath.Join(record.Identity.StoreRoot, filepath.FromSlash(step.Name)),
				Candidate: filepath.Join(area.Path, record.Identity.CandidateName, "store", filepath.FromSlash(step.Name)),
				Previous:  filepath.Join(area.Path, record.Identity.PreviousName, "files", evidenceHash([]byte(strings.ToLower(step.Name)))),
			}
			return area.applyRecordedRestoreFile(record.Identity.Transaction, paths, step.CurrentSHA256, step.RestoredSHA256, check)
		},
		VerifyStore: func(expected storeInventory) error {
			actual, err := inventoryColdStore(record.Identity.StoreRoot, check)
			if err != nil {
				return err
			}
			if hashStoreInventory(actual) != hashStoreInventory(expected) {
				return errors.New("restored store does not exactly match source inventory")
			}
			return check()
		},
	}
	return executeRecordedStoreRestore(record, area.restoreRecordStorage(check, storeRestoreRecordLimit), hooks)
}
