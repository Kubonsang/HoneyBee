//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func restoreRecordIdentity(t *testing.T) storeRestoreIdentity {
	return storeRestoreIdentity{"transaction-1", t.TempDir(), "backup", evidenceHash([]byte("backup manifest")), "candidate", "previous"}
}

func TestStoreRestoreRecordPublicationAndRestart(t *testing.T) {
	_, storage := restoreIntentFixture(t)
	identity := restoreRecordIdentity(t)
	observations := 0
	observe := func() (storeInventory, storeInventory, error) {
		observations++
		return restorePlanInventory(nil, map[string]string{"file": "new"}), validRestoreInventory(), nil
	}
	check := func() error { return nil }
	record, err := prepareStoreRestoreRecord(identity, storage, check, observe)
	if err != nil {
		t.Fatal(err)
	}
	// A restart sees partially restored files. That state must not become the
	// baseline, so even an unavailable observation callback must be irrelevant.
	restarted, err := prepareStoreRestoreRecord(identity, storage, check, func() (storeInventory, storeInventory, error) {
		t.Fatal("reobserved partially restored store")
		return storeInventory{}, storeInventory{}, errors.New("unavailable")
	})
	if err != nil || !reflect.DeepEqual(record, restarted) || observations != 1 {
		t.Fatal("restart changed plan", err)
	}
	changed := identity
	changed.BackupSHA256 = evidenceHash([]byte("another backup"))
	if _, err = prepareStoreRestoreRecord(changed, storage, check, observe); err == nil || observations != 1 {
		t.Fatal("conflicting backup reauthorized")
	}
	changed = identity
	changed.CandidateName = "another-candidate"
	if _, err = prepareStoreRestoreRecord(changed, storage, check, observe); err == nil || observations != 1 {
		t.Fatal("conflicting candidate reauthorized")
	}
}

func TestStoreRestoreRecordInterruptedPublication(t *testing.T) {
	root, storage := restoreIntentFixture(t)
	identity := restoreRecordIdentity(t)
	check := func() error { return nil }
	observe := func() (storeInventory, storeInventory, error) {
		return validRestoreInventory(), validRestoreInventory(), nil
	}
	broken := storage
	broken.publish = func(*os.File, string, string) error { return errors.New("crash before publish") }
	if _, err := prepareStoreRestoreRecord(identity, broken, check, observe); err == nil {
		t.Fatal("publication failure ignored")
	}
	if _, err := loadStoreRestoreRecord(identity, storage, check); !os.IsNotExist(err) {
		t.Fatal("partial became restore authority", err)
	}
	if _, err := prepareStoreRestoreRecord(identity, storage, check, observe); err != nil {
		t.Fatal(err)
	}
	entries, err := os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatal("partial evidence lost", err)
	}
}

func TestStoreRestoreRecordRejectsCorruptionBeforeMutation(t *testing.T) {
	for _, kind := range []string{"plan", "inventory", "unknown-field", "trailing", "truncated"} {
		t.Run(kind, func(t *testing.T) {
			root, storage := restoreIntentFixture(t)
			identity := restoreRecordIdentity(t)
			check := func() error { return nil }
			record, err := prepareStoreRestoreRecord(identity, storage, check, func() (storeInventory, storeInventory, error) {
				return validRestoreInventory(), validRestoreInventory(), nil
			})
			if err != nil {
				t.Fatal(err)
			}
			bad := record
			switch kind {
			case "plan":
				bad.Plan.Files[0].RestoredSHA256 = evidenceHash([]byte("other"))
			case "inventory":
				bad.Current.Entries[1].Security = "O:BAG:BA"
			}
			data, _ := json.Marshal(bad)
			switch kind {
			case "unknown-field":
				data = append([]byte(`{"unexpected":1,`), data[1:]...)
			case "trailing":
				data = append(data, []byte(" {}")...)
			case "truncated":
				data = data[:len(data)/2]
			}
			if err = os.WriteFile(filepath.Join(root, storeRestoreRecordName(identity)), data, 0600); err != nil {
				t.Fatal(err)
			}
			if _, err = prepareStoreRestoreRecord(identity, storage, check, func() (storeInventory, storeInventory, error) {
				t.Fatal("corruption caused new observation")
				return storeInventory{}, storeInventory{}, nil
			}); err == nil {
				t.Fatal("corruption accepted")
			}
		})
	}
}

func TestRecordedStoreRestoreChecksPersistedAuthority(t *testing.T) {
	root, storage := restoreIntentFixture(t)
	identity := restoreRecordIdentity(t)
	check := func() error { return nil }
	record, err := prepareStoreRestoreRecord(identity, storage, check, func() (storeInventory, storeInventory, error) {
		return validRestoreInventory(), validRestoreInventory(), nil
	})
	if err != nil {
		t.Fatal(err)
	}
	mutations, verified := 0, false
	entry := func(storeInventoryEntry) error { mutations++; return nil }
	hooks := storeRestoreHooks{AssertStopped: check, CreateDirectory: entry, PreserveDirectory: entry, RestoreMetadata: entry,
		RestoreFile: func(storeRestoreFileStep) error { mutations++; return nil },
		VerifyStore: func(storeInventory) error { verified = true; return nil },
	}
	if err = executeRecordedStoreRestore(record, storage, hooks); err != nil || !verified || mutations == 0 {
		t.Fatal("recorded plan did not execute", err)
	}
	mutations, verified = 0, false
	if err = os.WriteFile(filepath.Join(root, storeRestoreRecordName(identity)), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = executeRecordedStoreRestore(record, storage, hooks); err == nil || mutations != 0 || verified {
		t.Fatal("mutated without recorded authority")
	}
}
