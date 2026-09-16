//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Internal held-file primitive. The caller owns path admission, a pinned inventory,
// an exclusive file handle with WRITE_DAC/WRITE_OWNER/FILE_WRITE_ATTRIBUTES (and
// data write access when compression changes), and
// durable intent binding this entry to the target before any mutation. No pathname
// is reopened after verification. Directory inheritance needs separate ordering.
func restoreHeldFileMetadata(file *os.File, entry storeInventoryEntry, assertStopped func() error, persistIntent func(storeInventoryEntry) error) error {
	if entry.Directory {
		return errors.New("file metadata required")
	}
	return restoreHeldMetadata(file, entry, assertStopped, persistIntent)
}

func restoreHeldDirectoryMetadata(file *os.File, entry storeInventoryEntry, assertStopped func() error, persistIntent func(storeInventoryEntry) error) error {
	if !entry.Directory {
		return errors.New("directory metadata required")
	}
	return restoreHeldMetadata(file, entry, assertStopped, persistIntent)
}

func restoreHeldMetadata(file *os.File, entry storeInventoryEntry, assertStopped func() error, persistIntent func(storeInventoryEntry) error) error {
	if file == nil || assertStopped == nil || persistIntent == nil {
		return errors.New("held file and durable metadata authority required")
	}
	// Reuse the strict inventory validator, including the no-SACL policy.
	root := storeInventoryEntry{Name: ".", Directory: true, Security: entry.Security, Attributes: windows.FILE_ATTRIBUTE_DIRECTORY}
	validation := entry
	validation.Name = "file"
	if err := validateStoreInventory(storeInventory{SchemaVersion: 1, Entries: []storeInventoryEntry{root, validation}}); err != nil {
		return err
	}
	if err := validateColdBackupName(entry.Name); err != nil && !(entry.Directory && entry.Name == ".") {
		return err
	}
	if err := assertStopped(); err != nil {
		return err
	}
	handle := windows.Handle(file.Fd())
	var before windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &before); err != nil {
		return err
	}
	if (!entry.Directory && before.NumberOfLinks != 1) || (before.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY != 0) != entry.Directory {
		return errors.New("ordinary single-link restore file required")
	}
	if err := inspectStoreFilePolicy(handle, before.FileAttributes, entry.Directory); err != nil {
		return err
	}
	// Setting the sparse flag preserves logical bytes, but does not reconstruct
	// allocation holes. Never clear an unexpected sparse flag during restoration.
	if before.FileAttributes&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0 && entry.Attributes&windows.FILE_ATTRIBUTE_SPARSE_FILE == 0 {
		return errors.New("unexpected sparse allocation cannot be cleared by restoration")
	}
	if !entry.Directory {
		stat, err := file.Stat()
		if err != nil {
			return err
		}
		hash := sha256.New()
		if _, err = io.Copy(hash, io.NewSectionReader(file, 0, stat.Size())); err != nil {
			return err
		}
		if stat.Size() != entry.Size || hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			return errors.New("restored bytes do not match pinned metadata")
		}
	}
	sd, _ := windows.SecurityDescriptorFromString(entry.Security)
	owner, _, _ := sd.Owner()
	group, _, _ := sd.Group()
	dacl, _, _ := sd.DACL()
	control, _, err := sd.Control()
	if err != nil {
		return err
	}
	flags := windows.OWNER_SECURITY_INFORMATION | windows.GROUP_SECURITY_INFORMATION | windows.DACL_SECURITY_INFORMATION
	if control&windows.SE_DACL_PROTECTED != 0 {
		flags |= windows.PROTECTED_DACL_SECURITY_INFORMATION
	} else {
		flags |= windows.UNPROTECTED_DACL_SECURITY_INFORMATION
	}
	if err = persistIntent(entry); err != nil {
		return err
	}
	if err = assertStopped(); err != nil {
		return err
	}
	if (before.FileAttributes^entry.Attributes)&windows.FILE_ATTRIBUTE_COMPRESSED != 0 {
		if err = setStoreCompression(handle, entry.Attributes&windows.FILE_ATTRIBUTE_COMPRESSED != 0); err != nil {
			return err
		}
		if err = assertStopped(); err != nil {
			return err
		}
	}
	if before.FileAttributes&windows.FILE_ATTRIBUTE_SPARSE_FILE == 0 && entry.Attributes&windows.FILE_ATTRIBUTE_SPARSE_FILE != 0 {
		var returned uint32
		if err = windows.DeviceIoControl(handle, windows.FSCTL_SET_SPARSE, nil, 0, nil, 0, &returned, nil); err != nil {
			return err
		}
		if err = assertStopped(); err != nil {
			return err
		}
	}
	if err = windows.SetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.SECURITY_INFORMATION(flags), owner, group, dacl, nil); err != nil {
		return err
	}
	if err = assertStopped(); err != nil {
		return err
	}
	// Zero timestamps mean leave them unchanged. Sparse and compression use FSCTLs.
	basic := struct {
		Creation, Access, Write, Change int64
		Attributes                      uint32
	}{Attributes: entry.Attributes &^ (windows.FILE_ATTRIBUTE_SPARSE_FILE | windows.FILE_ATTRIBUTE_COMPRESSED)}
	if basic.Attributes == 0 {
		basic.Attributes = windows.FILE_ATTRIBUTE_NORMAL
	}
	if err = windows.SetFileInformationByHandle(handle, windows.FileBasicInfo, (*byte)(unsafe.Pointer(&basic)), uint32(unsafe.Sizeof(basic))); err != nil {
		return err
	}
	actual, err := windows.GetSecurityInfo(handle, windows.SE_FILE_OBJECT, windows.OWNER_SECURITY_INFORMATION|windows.GROUP_SECURITY_INFORMATION|windows.DACL_SECURITY_INFORMATION)
	if err != nil {
		return err
	}
	// Exact readback deliberately fails closed if Windows changes inheritance.
	if actual.String() != sd.String() {
		return errors.New("restored security descriptor differs from inventory")
	}
	var after windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &after); err != nil {
		return err
	}
	if after.FileAttributes != entry.Attributes {
		return errors.New("restored file attributes differ from inventory")
	}
	return assertStopped()
}
