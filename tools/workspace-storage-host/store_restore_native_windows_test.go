//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Real temporary-directory operations under the current user, not the elevated
// ProgramData factory. Exercise composition/replay rather than only fake hooks.
func TestStoreRestoreNativeCompositionAndReplay(t *testing.T) {
	root, candidate, previous := t.TempDir(), t.TempDir(), t.TempDir()
	check := func() error { return nil }
	write := func(name, data string) {
		t.Helper()
		p := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(data), 0600); err != nil {
			t.Fatal(err)
		}
	}
	write("original/file", "recover")
	write("changed", "old")
	write("same", "same")
	compressStoreFixture(t, filepath.Join(root, "original"), true)
	compressStoreFixture(t, filepath.Join(root, "original", "file"), false)
	readonly, _ := windows.UTF16PtrFromString(filepath.Join(root, "same"))
	if err := windows.SetFileAttributes(readonly, windows.FILE_ATTRIBUTE_READONLY); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.SetFileAttributes(readonly, windows.FILE_ATTRIBUTE_NORMAL) })
	sparseFile, err := os.OpenFile(filepath.Join(root, "changed"), os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	var returned uint32
	err = windows.DeviceIoControl(windows.Handle(sparseFile.Fd()), windows.FSCTL_SET_SPARSE, nil, 0, nil, 0, &returned, nil)
	closeErr := sparseFile.Close()
	if err != nil || closeErr != nil {
		t.Fatal("sparse fixture", err, closeErr)
	}
	source, err := inventoryColdStore(root, check)
	if err != nil {
		t.Fatal(err)
	}
	for _, entry := range source.Entries {
		if entry.Directory {
			continue
		}
		data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(entry.Name)))
		if err != nil {
			t.Fatal(err)
		}
		p := filepath.Join(candidate, "store", filepath.FromSlash(entry.Name))
		if err = os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(p, data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	if err = os.Remove(filepath.Join(root, "original", "file")); err != nil {
		t.Fatal(err)
	}
	if err = os.Remove(filepath.Join(root, "original")); err != nil {
		t.Fatal(err)
	}
	write("changed", "new")
	write("extra/child/post", "retain")
	current, err := inventoryColdStore(root, check)
	if err != nil {
		t.Fatal(err)
	}
	_, storage := restoreIntentFixture(t)
	identity := restoreRecordIdentity(t)
	identity.StoreRoot = root
	record, err := prepareStoreRestoreRecord(identity, storage, check, func() (storeInventory, storeInventory, error) { return current, source, nil })
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{"files", "directories", "pending"} {
		if err = os.Mkdir(filepath.Join(previous, dir), 0700); err != nil {
			t.Fatal(err)
		}
	}
	slot := func(kind, name string) string {
		return filepath.Join(previous, kind, evidenceHash([]byte(strings.ToLower(name))))
	}
	interrupted := errors.New("crash after first file")
	interrupt := true
	hooks := storeRestoreHooks{
		AssertStopped: check,
		CreateDirectory: func(entry storeInventoryEntry) error {
			target := filepath.Join(root, filepath.FromSlash(entry.Name))
			stage := slot("pending", entry.Name)
			if _, err := os.Stat(target); os.IsNotExist(err) {
				if err = os.Mkdir(stage, 0700); err != nil && !os.IsExist(err) {
					return err
				}
			}
			return publishRestoreDirectory(identity.Transaction, stage, target, storage, check)
		},
		PreserveDirectory: func(entry storeInventoryEntry) error {
			return preserveRestoreDirectory(identity.Transaction, filepath.Join(root, filepath.FromSlash(entry.Name)), slot("directories", entry.Name), storage, check)
		},
		RestoreFile: func(step storeRestoreFileStep) error {
			paths := restoreFilePaths{filepath.Join(root, filepath.FromSlash(step.Name)), filepath.Join(candidate, "store", filepath.FromSlash(step.Name)), slot("files", step.Name)}
			err := applyRestoreFile(paths, step.CurrentSHA256, step.RestoredSHA256, check, func(p restoreFilePaths, a, b string) error {
				return persistRestoreFileIntent(restoreFileIntent{1, identity.Transaction, p, a, b}, storage, check)
			})
			if err == nil && interrupt {
				interrupt = false
				return interrupted
			}
			return err
		},
		RestoreMetadata: func(entry storeInventoryEntry) error {
			p := filepath.Join(root, filepath.FromSlash(entry.Name))
			pointer, _ := windows.UTF16PtrFromString(p)
			flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
			if entry.Directory {
				flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
			}
			h, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
			if errors.Is(err, windows.ERROR_ACCESS_DENIED) {
				h, err = windows.CreateFile(pointer, windows.GENERIC_READ|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
			}
			if err != nil {
				return err
			}
			file := os.NewFile(uintptr(h), p)
			defer file.Close()
			// Identity-bound production metadata persistence is a separate adapter;
			// the durable complete plan remains checked by this coordinator.
			return restoreHeldMetadata(file, entry, check, func(storeInventoryEntry) error { return nil })
		},
		VerifyStore: func(expected storeInventory) error {
			actual, err := inventoryColdStore(root, check)
			if err != nil {
				return err
			}
			if hashStoreInventory(actual) != hashStoreInventory(expected) {
				return errors.New("final source inventory mismatch")
			}
			return nil
		},
	}
	if err = executeRecordedStoreRestore(record, storage, hooks); !errors.Is(err, interrupted) {
		t.Fatal("wrong interruption", err)
	}
	for i := 0; i < 2; i++ {
		if err = executeRecordedStoreRestore(record, storage, hooks); err != nil {
			t.Fatal("restore replay", err)
		}
	}
	data, err := os.ReadFile(slot("files", "extra/child/post"))
	if err != nil || string(data) != "retain" {
		t.Fatal("post-backup data lost", err)
	}
}
