//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type restoreMetadataIntent struct {
	SchemaVersion         int                 `json:"schemaVersion"`
	Transaction           string              `json:"transaction"`
	Target                string              `json:"target"`
	FileIdentity          string              `json:"fileIdentity"`
	SourceInventorySHA256 string              `json:"sourceInventorySha256"`
	Entry                 storeInventoryEntry `json:"entry"`
}

func (area *maintenanceArea) restoreRecordedMetadata(record storeRestoreRecord, entry storeInventoryEntry, assertStopped func() error) error {
	if err := area.checkRestoreRecord(record, assertStopped); err != nil {
		return err
	}
	admitted := false
	for _, candidate := range record.Plan.Metadata {
		if candidate == entry {
			admitted = true
			break
		}
	}
	if !admitted {
		return errors.New("metadata entry is not admitted")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	target := filepath.Join(record.Identity.StoreRoot, filepath.FromSlash(entry.Name))
	parents := &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	defer parents.close()
	if err := parents.holdDirectory(filepath.Dir(target)); err != nil {
		return err
	}
	name, err := windows.NewNTUnicodeString(filepath.Base(target))
	if err != nil {
		return err
	}
	attrs := windows.OBJECT_ATTRIBUTES{RootDirectory: parents.directories[strings.ToLower(filepath.Dir(target))], ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	options := uint32(windows.FILE_OPEN_REPARSE_POINT | windows.FILE_SYNCHRONOUS_IO_NONALERT | windows.FILE_NON_DIRECTORY_FILE)
	share := uint32(windows.FILE_SHARE_READ)
	if entry.Directory {
		options &^= windows.FILE_NON_DIRECTORY_FILE
		options |= windows.FILE_DIRECTORY_FILE
		share |= windows.FILE_SHARE_WRITE
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES|windows.SYNCHRONIZE, &attrs, &status, nil, 0, share, windows.FILE_OPEN, options, 0, 0)
	// Read-only files can still accept metadata-only replay. Compression changes
	// require write access and fail closed if this fallback cannot perform them.
	if errors.Is(err, windows.STATUS_ACCESS_DENIED) {
		err = windows.NtCreateFile(&handle, windows.GENERIC_READ|windows.WRITE_DAC|windows.WRITE_OWNER|windows.FILE_WRITE_ATTRIBUTES|windows.SYNCHRONIZE, &attrs, &status, nil, 0, share, windows.FILE_OPEN, options, 0, 0)
	}
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), target)
	defer file.Close()
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	identity := fmt.Sprintf("%08x:%08x%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow)
	persist := func(actual storeInventoryEntry) error {
		intent := restoreMetadataIntent{1, record.Identity.Transaction, target, identity, record.Plan.SourceInventorySHA256, actual}
		data, err := json.Marshal(intent)
		if err != nil {
			return err
		}
		key, _ := json.Marshal([]string{record.Identity.Transaction, strings.ToLower(target)})
		return persistRestoreRecord("restore-metadata-"+evidenceHash(key)+".json", data, 1<<20, area.restoreRecordStorage(check, 1<<20), check)
	}
	if entry.Directory {
		return restoreHeldDirectoryMetadata(file, entry, check, persist)
	}
	return restoreHeldFileMetadata(file, entry, check, persist)
}
