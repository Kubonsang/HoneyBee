//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func metadataFixture(t *testing.T) (*os.File, storeInventoryEntry) {
	t.Helper()
	path := filepath.Join(t.TempDir(), "restored.bin")
	data := []byte("verified source bytes")
	if err := os.WriteFile(path, data, 0600); err != nil {
		t.Fatal(err)
	}
	pointer, _ := windows.UTF16PtrFromString(path)
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(handle), path)
	t.Cleanup(func() { _ = file.Close(); _ = windows.SetFileAttributes(pointer, windows.FILE_ATTRIBUTE_NORMAL) })
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	hash := sha256.Sum256(data)
	return file, storeInventoryEntry{Name: "restored.bin", Size: int64(len(data)), SHA256: hex.EncodeToString(hash[:]), Security: sd.String(), Attributes: windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_READONLY | windows.FILE_ATTRIBUTE_HIDDEN}
}

func TestRestoreMetadataNativeReplay(t *testing.T) {
	file, entry := metadataFixture(t)
	// Change actual inheritance protection first, so this exercises restoration
	// of security rather than merely setting an already identical descriptor.
	sd, err := windows.SecurityDescriptorFromString(entry.Security)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, _ := sd.DACL()
	if err = windows.SetSecurityInfo(windows.Handle(file.Fd()), windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	persisted := 0
	intent := func(got storeInventoryEntry) error {
		if got != entry {
			t.Fatal("intent did not bind full metadata")
		}
		persisted++
		return nil
	}
	for i := 0; i < 2; i++ {
		if err := restoreHeldFileMetadata(file, entry, func() error { return nil }, intent); err != nil {
			t.Fatal(err)
		}
	}
	if persisted != 2 {
		t.Fatal("replay skipped durable authority")
	}
}

func TestRestoreMetadataRejectsBeforeMutation(t *testing.T) {
	for _, scenario := range []string{"hash", "intent", "stopped", "directory", "sacl"} {
		t.Run(scenario, func(t *testing.T) {
			file, entry := metadataFixture(t)
			handle := windows.Handle(file.Fd())
			var before windows.ByHandleFileInformation
			if err := windows.GetFileInformationByHandle(handle, &before); err != nil {
				t.Fatal(err)
			}
			stopped := func() error { return nil }
			intent := func(storeInventoryEntry) error { return nil }
			switch scenario {
			case "hash":
				entry.SHA256 = hex.EncodeToString(make([]byte, 32))
			case "intent":
				intent = func(storeInventoryEntry) error { return errors.New("disk full") }
			case "stopped":
				stopped = func() error { return errors.New("service running") }
			case "directory":
				entry.Directory = true
			case "sacl":
				entry.Security += "S:(AU;SA;FA;;;WD)"
			}
			if err := restoreHeldFileMetadata(file, entry, stopped, intent); err == nil {
				t.Fatal("unsafe metadata accepted")
			}
			var after windows.ByHandleFileInformation
			if err := windows.GetFileInformationByHandle(handle, &after); err != nil {
				t.Fatal(err)
			}
			if before.FileAttributes != after.FileAttributes {
				t.Fatal("attributes changed on rejected operation")
			}
		})
	}
}

func TestRestoreMetadataSparseFlagAndReplay(t *testing.T) {
	file, entry := metadataFixture(t)
	entry.Attributes |= windows.FILE_ATTRIBUTE_SPARSE_FILE
	check := func() error { return nil }
	persist := func(storeInventoryEntry) error { return nil }
	for i := 0; i < 2; i++ {
		if err := restoreHeldFileMetadata(file, entry, check, persist); err != nil {
			t.Fatal(err)
		}
	}
	entry.Attributes &^= windows.FILE_ATTRIBUTE_SPARSE_FILE
	if err := restoreHeldFileMetadata(file, entry, check, persist); err == nil {
		t.Fatal("unexpected sparse flag cleared")
	}
}

func TestRestoreMetadataInterruptionAfterSecurity(t *testing.T) {
	file, entry := metadataFixture(t)
	calls := 0
	interrupted := errors.New("interrupted after security")
	check := func() error {
		calls++
		if calls == 3 {
			return interrupted
		}
		return nil
	}
	intent := func(storeInventoryEntry) error { return nil }
	if err := restoreHeldFileMetadata(file, entry, check, intent); !errors.Is(err, interrupted) {
		t.Fatalf("unexpected interruption: %v", err)
	}
	if err := restoreHeldFileMetadata(file, entry, func() error { return nil }, intent); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreDirectoryMetadataNativeReplay(t *testing.T) {
	path := t.TempDir()
	pointer, _ := windows.UTF16PtrFromString(path)
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	file := os.NewFile(uintptr(handle), path)
	t.Cleanup(func() { _ = file.Close(); _ = windows.SetFileAttributes(pointer, windows.FILE_ATTRIBUTE_DIRECTORY) })
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	entry := storeInventoryEntry{Name: ".", Directory: true, Security: sd.String(), Attributes: windows.FILE_ATTRIBUTE_DIRECTORY | windows.FILE_ATTRIBUTE_HIDDEN}
	dacl, _, _ := sd.DACL()
	if err = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	for i := 0; i < 2; i++ {
		if err = restoreHeldDirectoryMetadata(file, entry, func() error { return nil }, func(storeInventoryEntry) error { return nil }); err != nil {
			t.Fatal(err)
		}
	}
}
