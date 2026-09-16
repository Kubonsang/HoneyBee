//go:build windows

package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func validRestoreInventory() storeInventory {
	return storeInventory{1, []storeInventoryEntry{
		{Name: ".", Directory: true, Security: maintenanceSDDL, Attributes: windows.FILE_ATTRIBUTE_DIRECTORY},
		{Name: "file", Size: 4, SHA256: evidenceHash([]byte("data")), Security: maintenanceSDDL, Attributes: windows.FILE_ATTRIBUTE_ARCHIVE},
	}}
}

func TestStoreRestoreRejectsUnsafeInventory(t *testing.T) {
	if err := validateStoreInventory(validRestoreInventory()); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"escape", "maintenance", "missing-parent", "duplicate", "root-file", "permissions", "attributes", "hash"} {
		t.Run(kind, func(t *testing.T) {
			inventory := validRestoreInventory()
			switch kind {
			case "escape":
				inventory.Entries[1].Name = "../outside"
			case "maintenance":
				inventory.Entries[1].Name = "maintenance/journal"
			case "missing-parent":
				inventory.Entries[1].Name = "missing/file"
			case "duplicate":
				copy := inventory.Entries[1]
				copy.Name = "FILE"
				inventory.Entries = append(inventory.Entries, copy)
			case "root-file":
				inventory.Entries = inventory.Entries[1:]
			case "permissions":
				inventory.Entries[1].Security = "O:BAG:BA"
			case "attributes":
				inventory.Entries[1].Attributes = windows.FILE_ATTRIBUTE_ENCRYPTED
			case "hash":
				inventory.Entries[1].SHA256 = ""
			}
			if err := validateStoreInventory(inventory); err == nil {
				t.Fatal("accepted unsafe recovery metadata")
			}
		})
	}
}

func TestStoreRestoreReadsPinnedMetadataAndMatchesPayload(t *testing.T) {
	root := t.TempDir()
	inventory := validRestoreInventory()
	metadata, err := json.Marshal(inventory)
	if err != nil {
		t.Fatal(err)
	}
	metadataPath := filepath.Join(root, "metadata")
	source := filepath.Join(root, "source")
	if err = os.WriteFile(metadataPath, metadata, 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(source, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "backup")
	check := func() error { return nil }
	pin, err := captureColdFiles(destination, []coldBackupInput{{"store-inventory.json", metadataPath}, {"store/file", source}}, check)
	if err != nil {
		t.Fatal(err)
	}
	backup, err := verifyColdBackup(destination, pin, check)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.close()
	if result, err := readStoreRestoreInventory(backup); err != nil || len(result.Entries) != 2 {
		t.Fatal(result, err)
	}
	backup.close()
	if _, err = readStoreRestoreInventory(backup); err == nil {
		t.Fatal("accepted released backup")
	}
}

func TestColdStoreRejectsAlternateStreams(t *testing.T) {
	for _, directory := range []bool{false, true} {
		root := t.TempDir()
		target := root
		if !directory {
			target = filepath.Join(root, "file")
			if err := os.WriteFile(target, []byte("data"), 0600); err != nil {
				t.Fatal(err)
			}
		}
		if err := os.WriteFile(target+":extra", []byte("must not disappear"), 0600); err != nil {
			t.Fatal(err)
		}
		if _, err := inventoryColdStore(root, func() error { return nil }); err == nil {
			t.Fatal("silently omitted named stream")
		}
	}
}
