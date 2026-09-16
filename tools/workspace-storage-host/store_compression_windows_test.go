//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"testing"
)

func compressStoreFixture(t *testing.T, path string, directory bool) {
	t.Helper()
	ptr, _ := windows.UTF16PtrFromString(path)
	flags := uint32(windows.FILE_FLAG_OPEN_REPARSE_POINT)
	if directory {
		flags |= windows.FILE_FLAG_BACKUP_SEMANTICS
	}
	h, err := windows.CreateFile(ptr, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, flags, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(h)
	if err = setStoreCompression(h, true); err != nil {
		t.Fatal(err)
	}
}

func TestRestoreCompressedMetadataIntentAndReplay(t *testing.T) {
	file, entry := metadataFixture(t)
	entry.Attributes = windows.FILE_ATTRIBUTE_ARCHIVE | windows.FILE_ATTRIBUTE_COMPRESSED
	check := func() error { return nil }
	failed := errors.New("intent write failed")
	if err := restoreHeldMetadata(file, entry, check, func(storeInventoryEntry) error { return failed }); !errors.Is(err, failed) {
		t.Fatal(err)
	}
	if format, err := storeCompressionFormat(windows.Handle(file.Fd())); err != nil || format != 0 {
		t.Fatal("mutated before intent", format, err)
	}
	persist := func(storeInventoryEntry) error { return nil }
	for i := 0; i < 2; i++ {
		if err := restoreHeldMetadata(file, entry, check, persist); err != nil {
			t.Fatal(err)
		}
	}
	entry.Attributes &^= windows.FILE_ATTRIBUTE_COMPRESSED
	if err := restoreHeldMetadata(file, entry, check, persist); err != nil {
		t.Fatal(err)
	}
	if format, err := storeCompressionFormat(windows.Handle(file.Fd())); err != nil || format != 0 {
		t.Fatal(format, err)
	}
	file.Close()
	if data, err := os.ReadFile(file.Name()); err != nil || string(data) != "verified source bytes" {
		t.Fatal("content changed", err)
	}
}
