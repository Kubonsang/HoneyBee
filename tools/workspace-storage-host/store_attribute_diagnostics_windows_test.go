//go:build windows

package main

import (
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestStoreAttributeDiagnosticsDistinguishTypeAndFlags(t *testing.T) {
	for _, tc := range []struct {
		name       string
		attributes uint32
		directory  bool
		want       string
	}{
		{"encrypted", windows.FILE_ATTRIBUTE_ENCRYPTED | windows.FILE_ATTRIBUTE_ARCHIVE, false, "unsupported=0x00004000"},
		{"directory-as-file", windows.FILE_ATTRIBUTE_DIRECTORY, false, "expectedDirectory=false actualDirectory=true"},
		{"file-as-directory", windows.FILE_ATTRIBUTE_ARCHIVE, true, "expectedDirectory=true actualDirectory=false"},
	} {
		t.Run(tc.name, func(t *testing.T) {
			inventory := validRestoreInventory()
			inventory.Entries[1].Name = "child.vhdx"
			inventory.Entries[1].Attributes = tc.attributes
			inventory.Entries[1].Directory = tc.directory
			err := validateStoreInventory(inventory)
			if err == nil || !strings.Contains(err.Error(), tc.want) || !strings.Contains(err.Error(), `"child.vhdx"`) {
				t.Fatalf("missing entry/type/attribute diagnosis: %v", err)
			}
		})
	}
	if err := validateStoreAttributes(windows.FILE_ATTRIBUTE_ARCHIVE|windows.FILE_ATTRIBUTE_SPARSE_FILE, false); err != nil {
		t.Fatal(err)
	}
}

func TestStoreInventoryErrorRetainsPathAndCause(t *testing.T) {
	root := t.TempDir()
	want := errors.New("quiescence authority lost")
	calls := 0
	_, err := inventoryColdStore(root, func() error {
		calls++
		if calls > 1 {
			return want
		}
		return nil
	})
	if !errors.Is(err, want) || !strings.Contains(err.Error(), "inventory store entry") || !strings.Contains(err.Error(), "quiescence authority lost") {
		t.Fatalf("lost path or wrapped cause: %v", err)
	}
}
