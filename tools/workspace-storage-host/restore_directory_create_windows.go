//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"golang.org/x/sys/windows"
)

func (area *maintenanceArea) checkRestoreRecord(record storeRestoreRecord, assertStopped func() error) error {
	if assertStopped == nil || record.Identity.StoreRoot != filepath.Dir(area.Path) {
		return errors.New("fixed stopped store required")
	}
	if err := area.assertHeld(); err != nil {
		return err
	}
	if err := validateStoreRestoreRecord(record, record.Identity); err != nil {
		return err
	}
	stored, err := loadStoreRestoreRecord(record.Identity, area.restoreRecordStorage(assertStopped, storeRestoreRecordLimit), assertStopped)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(stored, record) {
		return errors.New("recorded store restore authority changed")
	}
	return assertStopped()
}

// Create in protected scaffolding first, then durably identify and publish the
// empty directory. A restart does not recreate the staging slot if the target
// already exists; publication replay checks its recorded native file identity.
func (area *maintenanceArea) createRecordedDirectory(record storeRestoreRecord, entry storeInventoryEntry, assertStopped func() error) error {
	if err := area.checkRestoreRecord(record, assertStopped); err != nil {
		return err
	}
	admitted := false
	for _, candidate := range record.Plan.CreateDirectories {
		if candidate == entry {
			admitted = true
			break
		}
	}
	if !admitted || entry.Name == "." {
		return errors.New("directory is not admitted for creation")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	preservation, err := openPrivateMaintenanceChild(area.directory, record.Identity.PreviousName, true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(preservation)
	pending, err := openPrivateMaintenanceChild(preservation, "new-directories", true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pending)
	name := evidenceHash([]byte(strings.ToLower(entry.Name)))
	target := filepath.Join(record.Identity.StoreRoot, filepath.FromSlash(entry.Name))
	candidate := filepath.Join(area.Path, record.Identity.PreviousName, "new-directories", name)
	if _, err = os.Lstat(target); os.IsNotExist(err) {
		if err = check(); err != nil {
			return err
		}
		handle, err := openPrivateMaintenanceChild(pending, name, true)
		if err != nil {
			return err
		}
		if err = windows.CloseHandle(handle); err != nil {
			return err
		}
	} else if err != nil {
		return err
	}
	return publishRestoreDirectory(record.Identity.Transaction, candidate, target, area.restoreRecordStorage(check, 64<<10), check)
}
