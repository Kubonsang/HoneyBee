//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
)

const storeRestoreRecordLimit = 64 << 20

type storeRestoreIdentity struct {
	Transaction   string `json:"transaction"`
	StoreRoot     string `json:"storeRoot"`
	BackupName    string `json:"backupName"`
	BackupSHA256  string `json:"backupSha256"`
	CandidateName string `json:"candidateName"`
	PreviousName  string `json:"previousName"`
}

type storeRestoreRecord struct {
	SchemaVersion int                  `json:"schemaVersion"`
	Identity      storeRestoreIdentity `json:"identity"`
	Current       storeInventory       `json:"current"`
	Source        storeInventory       `json:"source"`
	Plan          storeRestorePlan     `json:"plan"`
}

func validateStoreRestoreIdentity(identity storeRestoreIdentity) error {
	if !filepath.IsAbs(identity.StoreRoot) || filepath.Clean(identity.StoreRoot) != identity.StoreRoot || !migrationDigest(identity.BackupSHA256) {
		return errors.New("canonical restore store and pinned backup required")
	}
	seen := map[string]bool{}
	for _, name := range []string{identity.Transaction, identity.BackupName, identity.CandidateName, identity.PreviousName} {
		if validateColdBackupName(name) != nil || strings.Contains(name, "/") {
			return errors.New("single-component restore identity required")
		}
	}
	for _, name := range []string{identity.BackupName, identity.CandidateName, identity.PreviousName} {
		if seen[strings.ToLower(name)] {
			return errors.New("restore locations must be distinct")
		}
		seen[strings.ToLower(name)] = true
	}
	return nil
}

func storeRestoreRecordName(identity storeRestoreIdentity) string {
	// A transaction has one identity. Changing paths or the backup pin must
	// conflict with the existing record rather than select a different filename.
	return "store-restore-" + evidenceHash([]byte(strings.ToLower(identity.Transaction))) + ".json"
}

func validateStoreRestoreRecord(record storeRestoreRecord, expected storeRestoreIdentity) error {
	if err := validateStoreRestoreIdentity(expected); err != nil {
		return err
	}
	if record.SchemaVersion != 1 || record.Identity != expected {
		return errors.New("store restore identity mismatch")
	}
	plan, err := planStoreRestore(record.Current, record.Source)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(plan, record.Plan) {
		return errors.New("recorded restore plan differs from inventories")
	}
	return nil
}

func loadStoreRestoreRecord(identity storeRestoreIdentity, storage restoreIntentStorage, check func() error) (storeRestoreRecord, error) {
	var record storeRestoreRecord
	if err := validateStoreRestoreIdentity(identity); err != nil {
		return record, err
	}
	if storage.read == nil || check == nil {
		return record, errors.New("protected record reader required")
	}
	if err := check(); err != nil {
		return record, err
	}
	data, err := storage.read(storeRestoreRecordName(identity))
	if err != nil {
		return record, err
	}
	if len(data) == 0 || len(data) > storeRestoreRecordLimit {
		return record, errors.New("store restore record exceeds bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&record); err != nil {
		return storeRestoreRecord{}, err
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF {
		return storeRestoreRecord{}, errors.New("trailing restore record")
	}
	if err = validateStoreRestoreRecord(record, identity); err != nil {
		return storeRestoreRecord{}, err
	}
	if err = check(); err != nil {
		return storeRestoreRecord{}, err
	}
	return record, nil
}

// Observe runs only before the first durable record. On restart the original
// observation is loaded; partially restored filesystem state is never rebaselined.
func prepareStoreRestoreRecord(identity storeRestoreIdentity, storage restoreIntentStorage, check func() error, observe func() (storeInventory, storeInventory, error)) (storeRestoreRecord, error) {
	record, err := loadStoreRestoreRecord(identity, storage, check)
	if err == nil || !os.IsNotExist(err) {
		return record, err
	}
	if observe == nil {
		return record, errors.New("initial stopped-store observation required")
	}
	current, source, err := observe()
	if err != nil {
		return record, err
	}
	canonical := func(inventory storeInventory) storeInventory {
		inventory.Entries = append([]storeInventoryEntry(nil), inventory.Entries...)
		sort.Slice(inventory.Entries, func(i, j int) bool {
			return strings.ToLower(inventory.Entries[i].Name) < strings.ToLower(inventory.Entries[j].Name)
		})
		return inventory
	}
	current, source = canonical(current), canonical(source)
	plan, err := planStoreRestore(current, source)
	if err != nil {
		return record, err
	}
	record = storeRestoreRecord{1, identity, current, source, plan}
	data, err := json.Marshal(record)
	if err != nil {
		return storeRestoreRecord{}, err
	}
	if err = persistRestoreRecord(storeRestoreRecordName(identity), data, storeRestoreRecordLimit, storage, check); err != nil {
		return storeRestoreRecord{}, err
	}
	return loadStoreRestoreRecord(identity, storage, check)
}

func (area *maintenanceArea) prepareStoreRestore(identity storeRestoreIdentity, assertStopped func() error) (storeRestoreRecord, error) {
	if assertStopped == nil || identity.StoreRoot != filepath.Dir(area.Path) {
		return storeRestoreRecord{}, errors.New("fixed stopped store required")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	return prepareStoreRestoreRecord(identity, area.restoreRecordStorage(check, storeRestoreRecordLimit), check, func() (storeInventory, storeInventory, error) {
		backup, err := verifyColdBackup(filepath.Join(area.Path, identity.BackupName), identity.BackupSHA256, check)
		if err != nil {
			return storeInventory{}, storeInventory{}, err
		}
		defer backup.close()
		source, err := readStoreRestoreInventory(backup)
		if err != nil {
			return storeInventory{}, storeInventory{}, err
		}
		current, err := inventoryColdStore(identity.StoreRoot, check)
		return current, source, err
	})
}

// Mutating adapters remain responsible for their own idempotent intents. This
// wrapper ensures a restarted coordinator consumes the original durable plan.
func executeRecordedStoreRestore(record storeRestoreRecord, storage restoreIntentStorage, hooks storeRestoreHooks) error {
	if err := validateStoreRestoreRecord(record, record.Identity); err != nil {
		return err
	}
	hooks.PersistPlan = func(plan storeRestorePlan) error {
		stored, err := loadStoreRestoreRecord(record.Identity, storage, hooks.AssertStopped)
		if err != nil {
			return err
		}
		if !reflect.DeepEqual(stored, record) || !reflect.DeepEqual(stored.Plan, plan) {
			return errors.New("restore authority changed before execution")
		}
		return nil
	}
	return restoreStoreInventory(record.Current, record.Source, hooks)
}
