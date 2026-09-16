//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

func validateStoreInventory(inventory storeInventory) error {
	if inventory.SchemaVersion != 1 || len(inventory.Entries) == 0 || len(inventory.Entries) > 20000 {
		return errors.New("invalid store recovery inventory")
	}
	entries := map[string]storeInventoryEntry{}
	for _, entry := range inventory.Entries {
		key := strings.ToLower(entry.Name)
		if key != "." {
			if err := validateColdBackupName(entry.Name); err != nil {
				return err
			}
		}
		if key == "maintenance" || strings.HasPrefix(key, "maintenance/") {
			return errors.New("restore cannot overwrite maintenance evidence")
		}
		if _, exists := entries[key]; exists {
			return errors.New("duplicate store recovery path")
		}
		if err := validateStoreAttributes(entry.Attributes, entry.Directory); err != nil {
			return fmt.Errorf("validate recorded store entry %q: %w", entry.Name, err)
		}
		if entry.Directory {
			if entry.Size != 0 || entry.SHA256 != "" {
				return errors.New("directory contains unexpected file metadata")
			}
		} else if entry.Size < 0 || !migrationDigest(entry.SHA256) {
			return errors.New("invalid recovered file identity")
		}
		if len(entry.Security) == 0 || len(entry.Security) > 64<<10 {
			return errors.New("invalid recovery permissions length")
		}
		sd, err := windows.SecurityDescriptorFromString(entry.Security)
		if err != nil {
			return err
		}
		owner, _, err := sd.Owner()
		if err != nil || owner == nil {
			return errors.New("recovery owner missing")
		}
		group, _, err := sd.Group()
		if err != nil || group == nil {
			return errors.New("recovery group missing")
		}
		acl, _, err := sd.DACL()
		if err != nil || acl == nil {
			return errors.New("recovery DACL missing or unrestricted")
		}
		if _, _, err = sd.SACL(); !errors.Is(err, windows.ERROR_OBJECT_NOT_FOUND) {
			return errors.New("SACL restoration is outside this backup format")
		}
		entries[key] = entry
	}
	if root, exists := entries["."]; !exists || !root.Directory {
		return errors.New("store recovery root missing")
	}
	for key := range entries {
		if key == "." {
			continue
		}
		parent := filepath.ToSlash(filepath.Dir(filepath.FromSlash(key)))
		if directory, exists := entries[parent]; !exists || !directory.Directory {
			return errors.New("recovery parent directory missing or conflicting")
		}
	}
	return nil
}

// This accepts only an already pinned, held backup. User JSON alone is never
// restore authority. Entries remain relative to the admitted fixed store root.
func readStoreRestoreInventory(backup *verifiedColdBackup) (storeInventory, error) {
	var inventory storeInventory
	if backup == nil || len(backup.files) == 0 {
		return inventory, errors.New("held store backup required")
	}
	file := backup.files[filepath.Join(backup.directory, "store-inventory.json")]
	if file == nil {
		return inventory, errors.New("store recovery metadata missing")
	}
	stat, err := file.Stat()
	if err != nil {
		return inventory, err
	}
	if stat.Size() <= 0 || stat.Size() > 16<<20 {
		return inventory, errors.New("store recovery metadata exceeds bound")
	}
	decoder := json.NewDecoder(io.NewSectionReader(file, 0, stat.Size()))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&inventory); err != nil {
		return storeInventory{}, err
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF {
		return storeInventory{}, errors.New("trailing store recovery metadata")
	}
	if err = validateStoreInventory(inventory); err != nil {
		return storeInventory{}, err
	}
	if err = matchStoreBackup(inventory, backup.manifest); err != nil {
		return storeInventory{}, err
	}
	return inventory, nil
}
