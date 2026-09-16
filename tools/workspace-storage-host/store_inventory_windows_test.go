//go:build windows

package main

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestColdStoreInventoryPreservesEmptyDirectoriesAndExcludesMaintenance(t *testing.T) {
	root := t.TempDir()
	for _, dir := range []string{"empty", "tenant", "maintenance"} {
		if err := os.Mkdir(filepath.Join(root, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(root, "tenant", "child.vhdx"), []byte("disk"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "maintenance", "previous-backup"), []byte("excluded"), 0600); err != nil {
		t.Fatal(err)
	}
	inventory, err := inventoryColdStore(root, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if err = validateStoreInventory(inventory); err != nil {
		t.Fatal(err)
	}
	seen := map[string]storeInventoryEntry{}
	for _, entry := range inventory.Entries {
		seen[entry.Name] = entry
		if entry.Security == "" {
			t.Fatal("lost permissions")
		}
		if strings.HasPrefix(entry.Name, "maintenance") {
			t.Fatal("recursive maintenance backup")
		}
	}
	if !seen["empty"].Directory || !seen["."].Directory {
		t.Fatal("lost empty/root directory")
	}
	child := seen["tenant/child.vhdx"]
	if child.Size != 4 || child.SHA256 != evidenceHash([]byte("disk")) {
		t.Fatal("wrong file identity", child)
	}
	manifest := coldBackupManifest{1, []coldBackupFile{{"store/tenant/child.vhdx", 4, child.SHA256}}}
	if err = matchStoreBackup(inventory, manifest); err != nil {
		t.Fatal(err)
	}
	manifest.Files[0].SHA256 = evidenceHash([]byte("edit"))
	if err = matchStoreBackup(inventory, manifest); err == nil {
		t.Fatal("accepted changed store")
	}
	if err = matchStoreBackup(inventory, coldBackupManifest{SchemaVersion: 1}); err == nil {
		t.Fatal("accepted incomplete store")
	}
}

func TestColdStoreInventoryRejectsHardLinkedFiles(t *testing.T) {
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "source"), []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(filepath.Join(root, "source"), filepath.Join(root, "alias")); err != nil {
		t.Fatal(err)
	}
	if _, err := inventoryColdStore(root, func() error { return nil }); err == nil {
		t.Fatal("accepted hard-linked store data")
	}
}
