//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// A privileged journal never inherits creator ownership or uses user-writable
// temporary files. Final records are renamed exclusively with their protected ACL.
func (area *maintenanceArea) migrationStorage(name string, create bool) (restoreIntentStorage, func(), error) {
	if area == nil || validateColdBackupName(name) != nil || strings.Contains(name, "/") || !strings.HasPrefix(name, "migration-") {
		return restoreIntentStorage{}, nil, errors.New("protected migration directory required")
	}
	if err := area.assertHeld(); err != nil {
		return restoreIntentStorage{}, nil, err
	}
	disposition := uint32(windows.FILE_OPEN)
	if create {
		disposition = windows.FILE_CREATE
	}
	parent, err := privateMaintenanceChild(area.directory, name, true, disposition)
	if err != nil {
		return restoreIntentStorage{}, nil, err
	}
	closed := false
	closeStorage := func() {
		if !closed {
			closed = true
			_ = windows.CloseHandle(parent)
		}
	}
	check := func() error {
		if closed {
			return errors.New("protected migration ownership released")
		}
		return area.assertHeld()
	}
	return privateRecordStorage(parent, check, 64<<10), closeStorage, nil
}

func (area *maintenanceArea) createMigration(identity migrationIdentity) (*serviceMigration, error) {
	if identity.SchemaVersion != 3 || !nativeComponentID.MatchString(identity.SourceComponent) || !nativeComponentID.MatchString(identity.TargetComponent) || identity.SourceComponent == identity.TargetComponent || !migrationDigest(identity.SourceEvidenceSHA256) || !migrationDigest(identity.TargetManifestSHA256) {
		return nil, errors.New("invalid protected migration identity")
	}
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return nil, err
	}
	name := "migration-" + hex.EncodeToString(nonce[:])
	storage, closeStorage, err := area.migrationStorage(name, true)
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(identity)
	if err != nil {
		closeStorage()
		return nil, err
	}
	persist := func(name string, data []byte) error {
		return persistRestoreRecord(name, data, 64<<10, storage, area.assertHeld)
	}
	if err = persist("identity.json", data); err != nil {
		closeStorage()
		return nil, err
	}
	journal := &serviceMigration{directory: filepath.Join(area.Path, name), identitySHA256: evidenceHash(data), persist: persist, closePrivate: closeStorage}
	if err = journal.mark("Prepared"); err != nil {
		closeStorage()
		return nil, err
	}
	return journal, nil
}

func (area *maintenanceArea) loadMigration(name, pin string) (*serviceMigration, error) {
	storage, closeStorage, err := area.migrationStorage(name, false)
	if err != nil {
		return nil, err
	}
	journal, err := loadServiceMigrationUsing(filepath.Join(area.Path, name), pin, storage.read)
	if err != nil {
		closeStorage()
		return nil, err
	}
	journal.persist = func(name string, data []byte) error {
		return persistRestoreRecord(name, data, 64<<10, storage, area.assertHeld)
	}
	journal.closePrivate = closeStorage
	return journal, nil
}
