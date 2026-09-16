//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestProtectedMigrationPublicationFailureDoesNotAdvanceState(t *testing.T) {
	root, storage := restoreIntentFixture(t)
	identity := migrationIdentity{3, "source.hb12", "target.hb13", evidenceHash([]byte("source")), evidenceHash([]byte("target"))}
	data, _ := json.Marshal(identity)
	check := func() error { return nil }
	if err := persistRestoreRecord("identity.json", data, 64<<10, storage, check); err != nil {
		t.Fatal(err)
	}
	fail := false
	j := &serviceMigration{directory: root, identitySHA256: evidenceHash(data), persist: func(name string, b []byte) error {
		if fail {
			return errors.New("publication failed")
		}
		return persistRestoreRecord(name, b, 64<<10, storage, check)
	}}
	if err := j.mark("Prepared"); err != nil {
		t.Fatal(err)
	}
	fail = true
	if err := j.mark("Reserving"); err == nil || j.state() != "Prepared" {
		t.Fatal("failed publication advanced state")
	}
	loaded, err := loadServiceMigrationUsing(root, j.identitySHA256, storage.read)
	if err != nil || loaded.state() != "Prepared" {
		t.Fatal(loaded, err)
	}
	fail = false
	if err := j.mark("Reserving"); err != nil {
		t.Fatal(err)
	}
	loaded, err = loadServiceMigrationUsing(root, j.identitySHA256, storage.read)
	if err != nil || loaded.state() != "Reserving" {
		t.Fatal(loaded, err)
	}
}

func TestProtectedMigrationRefusesUnownedOrRedirectedDestination(t *testing.T) {
	area := &maintenanceArea{Path: t.TempDir()}
	for _, name := range []string{"migration-ok", "../migration-escape", `migration-foo\bar`, filepath.Join(area.Path, "migration-absolute")} {
		if _, _, err := area.migrationStorage(name, true); err == nil {
			t.Fatal("unowned migration created", name)
		}
	}
}
