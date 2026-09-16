//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type storeInventoryEntry struct {
	Name       string `json:"name"`
	Directory  bool   `json:"directory"`
	Size       int64  `json:"size"`
	SHA256     string `json:"sha256,omitempty"`
	Security   string `json:"security"`
	Attributes uint32 `json:"attributes"`
}
type storeInventory struct {
	SchemaVersion int                   `json:"schemaVersion"`
	Entries       []storeInventoryEntry `json:"entries"`
}

// Caller must keep the service stopped, disks detached and maintenance ownership
// held across inventory, capture and comparison. This reads only the store tree;
// it never follows Workspace/project mount points or enumerates the maintenance
// subtree into its own backup. SACL audit policy is not captured or modified.
func inventoryColdStore(root string, assertQuiet func() error) (storeInventory, error) {
	result := storeInventory{SchemaVersion: 1}
	if !filepath.IsAbs(root) || assertQuiet == nil {
		return result, errors.New("absolute store and quiescence authority required")
	}
	if err := assertQuiet(); err != nil {
		return result, err
	}
	held := &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	defer held.close()
	if err := held.holdDirectory(root); err != nil {
		return result, err
	}
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, walkErr error) (resultErr error) {
		defer func() {
			if resultErr != nil && resultErr != filepath.SkipDir {
				resultErr = fmt.Errorf("inventory store entry %q: %w", path, resultErr)
			}
		}()
		if walkErr != nil {
			return walkErr
		}
		if err := assertQuiet(); err != nil {
			return err
		}
		relative, err := filepath.Rel(root, path)
		if err != nil {
			return err
		}
		name := filepath.ToSlash(relative)
		if strings.EqualFold(name, "maintenance") {
			if !entry.IsDir() {
				return errors.New("maintenance exclusion is not a directory")
			}
			return filepath.SkipDir
		}
		if name != "." {
			if err = validateColdBackupName(name); err != nil {
				return err
			}
		}
		if len(result.Entries) >= 20000 {
			return errors.New("store inventory exceeds bound")
		}
		record := storeInventoryEntry{Name: name, Directory: entry.IsDir()}
		var handle windows.Handle
		if entry.IsDir() {
			if err = held.holdDirectory(path); err != nil {
				return err
			}
			pointer, err := windows.UTF16PtrFromString(path)
			if err != nil {
				return err
			}
			handle, err = windows.CreateFile(pointer, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
			if err != nil {
				return err
			}
			defer windows.CloseHandle(handle)
		} else {
			if len(held.files) >= 10000 {
				return errors.New("store file count exceeds bound")
			}
			file, size, err := held.openFile(path)
			if err != nil {
				return err
			}
			handle = windows.Handle(file.Fd())
			record.Size = size
			hash := sha256.New()
			if _, err = io.Copy(hash, io.NewSectionReader(file, 0, size)); err != nil {
				return err
			}
			record.SHA256 = hex.EncodeToString(hash.Sum(nil))
		}
		var info windows.ByHandleFileInformation
		if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
			return err
		}
		if info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
			return errors.New("redirected store inventory entry")
		}
		record.Attributes = info.FileAttributes
		if err = inspectStoreFilePolicy(handle, info.FileAttributes, entry.IsDir()); err != nil {
			return err
		}
		sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if err != nil {
			return err
		}
		record.Security = sd.String()
		if record.Security == "" {
			return errors.New("store security descriptor unavailable")
		}
		result.Entries = append(result.Entries, record)
		return nil
	})
	if err != nil {
		return storeInventory{}, err
	}
	if err = assertQuiet(); err != nil {
		return storeInventory{}, err
	}
	return result, nil
}

// Bind copied store bytes to the inventory observed before capture. Metadata is
// carried separately in the backup; it must be protected and pinned as well.
func matchStoreBackup(inventory storeInventory, manifest coldBackupManifest) error {
	if inventory.SchemaVersion != 1 || manifest.SchemaVersion != 1 {
		return errors.New("unsupported store backup schema")
	}
	wanted := map[string]storeInventoryEntry{}
	for _, entry := range inventory.Entries {
		if entry.Directory {
			continue
		}
		if err := validateColdBackupName(entry.Name); err != nil {
			return err
		}
		key := strings.ToLower("store/" + entry.Name)
		if _, ok := wanted[key]; ok {
			return errors.New("duplicate store inventory entry")
		}
		wanted[key] = entry
	}
	for _, file := range manifest.Files {
		if file.Name == "store-inventory.json" {
			continue
		}
		key := strings.ToLower(file.Name)
		entry, ok := wanted[key]
		if !ok || file.Size != entry.Size || file.SHA256 != entry.SHA256 {
			return errors.New("captured store differs from inventory")
		}
		delete(wanted, key)
	}
	if len(wanted) != 0 {
		return errors.New("captured store is incomplete")
	}
	return nil
}
