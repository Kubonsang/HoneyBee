//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

// Establish the current inheritance model before capturing a positive fixture.
// Hosted runners can inherit legacy ACLs with inherited ACEs but no AI control
// bit. SetSecurityInfo converts those on restoration; production must continue
// refusing that non-exact readback rather than silently rewriting an inventory.
func initializeMetadataFixtureInheritance(t *testing.T, handle windows.Handle) *windows.SECURITY_DESCRIPTOR {
	t.Helper()
	sd, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	dacl, _, err := sd.DACL()
	if err != nil || dacl == nil {
		t.Fatal("fixture DACL missing", err)
	}
	if err = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.UNPROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		t.Fatal(err)
	}
	sd, err = windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		t.Fatal(err)
	}
	control, _, err := sd.Control()
	if err != nil || control&windows.SE_DACL_AUTO_INHERITED == 0 || control&windows.SE_DACL_PROTECTED != 0 {
		t.Fatal("positive fixture did not enter unprotected auto-inheritance model", err)
	}
	return sd
}

func initializeMetadataFixtureDirectory(t *testing.T, name string) {
	t.Helper()
	pointer, err := windows.UTF16PtrFromString(name)
	if err != nil {
		t.Fatal(err)
	}
	handle, err := windows.CreateFile(pointer, windows.READ_CONTROL|windows.WRITE_DAC,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	initializeMetadataFixtureInheritance(t, handle)
}

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
	sd := initializeMetadataFixtureInheritance(t, handle)
	// Only diagnostic data from this test-owned temporary fixture. Keep the
	// handle open until this cleanup runs so hosted-runner inheritance changes
	// can be distinguished from a permissions failure without relaxing readback.
	t.Cleanup(func() {
		if !t.Failed() {
			return
		}
		actual, readErr := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
		if readErr != nil {
			t.Logf("metadata fixture security readback failed: %v", readErr)
			return
		}
		t.Logf("metadata fixture expected SDDL=%q; actual SDDL=%q", sd.String(), actual.String())
	})
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

func TestRestoreMetadataRejectsUnreproducedInheritanceModel(t *testing.T) {
	file, entry := metadataFixture(t)
	sd, err := windows.SecurityDescriptorFromString(entry.Security)
	if err != nil {
		t.Fatal(err)
	}
	if err = sd.SetControl(windows.SE_DACL_AUTO_INHERITED, 0); err != nil {
		t.Fatal(err)
	}
	entry.Security = sd.String()
	before := entry
	persisted := 0
	err = restoreHeldFileMetadata(file, entry, func() error { return nil }, func(got storeInventoryEntry) error {
		if got != before {
			t.Fatal("restore silently normalized recorded inventory")
		}
		persisted++
		return nil
	})
	if err == nil || !strings.Contains(err.Error(), "security descriptor differs") || persisted != 1 {
		t.Fatal("unreproduced inheritance model was not refused", err, persisted)
	}
}

func TestRestoreMetadataProtectedReplayAndDACLReadback(t *testing.T) {
	for _, tamper := range []bool{false, true} {
		name := "exact-protected-replay"
		if tamper {
			name = "changed-permissions-refused"
		}
		t.Run(name, func(t *testing.T) {
			file, entry := metadataFixture(t)
			handle := windows.Handle(file.Fd())
			sd, err := windows.SecurityDescriptorFromString(entry.Security)
			if err != nil {
				t.Fatal(err)
			}
			dacl, _, _ := sd.DACL()
			setDACL := func(acl *windows.ACL) error {
				return windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, acl, nil)
			}
			if err = setDACL(dacl); err != nil {
				t.Fatal(err)
			}
			protected, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
			if err != nil {
				t.Fatal(err)
			}
			entry.Security = protected.String()
			t.Cleanup(func() {
				if err := setDACL(dacl); err != nil {
					t.Error("fixture cleanup DACL", err)
				}
			})
			checks := 0
			check := func() error {
				checks++
				if tamper && checks == 3 { // after SetSecurityInfo, before exact readback
					empty, e := windows.SecurityDescriptorFromString("D:P")
					if e != nil {
						return e
					}
					acl, _, e := empty.DACL()
					if e != nil || acl == nil {
						return errors.New("test requires an empty, not null, DACL")
					}
					return setDACL(acl)
				}
				return nil
			}
			err = restoreHeldFileMetadata(file, entry, check, func(storeInventoryEntry) error { return nil })
			if tamper {
				if err == nil || !strings.Contains(err.Error(), "security descriptor differs") {
					t.Fatal("changed access rights accepted", err)
				}
			} else if err != nil {
				t.Fatal(err)
			}
		})
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
	sd := initializeMetadataFixtureInheritance(t, handle)
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
