//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type restoreDirectoryIntent struct {
	SchemaVersion int    `json:"schemaVersion"`
	Operation     string `json:"operation"`
	Transaction   string `json:"transaction"`
	Target        string `json:"target"`
	Previous      string `json:"previous"`
	FileIdentity  string `json:"fileIdentity"`
}

// Bound adapter for obsolete directories. Scaffolding is created only inside
// the protected preservation area and must pass the private-directory ACL checks.
func (area *maintenanceArea) preserveRecordedDirectory(record storeRestoreRecord, entry storeInventoryEntry, assertStopped func() error) error {
	if assertStopped == nil || record.Identity.StoreRoot != filepath.Dir(area.Path) {
		return errors.New("fixed stopped store required")
	}
	if err := validateStoreRestoreRecord(record, record.Identity); err != nil {
		return err
	}
	admitted := false
	for _, candidate := range record.Plan.PreserveDirectories {
		if candidate == entry {
			admitted = true
			break
		}
	}
	if !admitted || entry.Name == "." {
		return errors.New("directory is not admitted for preservation")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	storage := area.restoreRecordStorage(check, storeRestoreRecordLimit)
	stored, err := loadStoreRestoreRecord(record.Identity, storage, check)
	if err != nil {
		return err
	}
	if !reflect.DeepEqual(stored, record) {
		return errors.New("directory restore authority changed")
	}
	preservation, err := openPrivateMaintenanceChild(area.directory, record.Identity.PreviousName, true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(preservation)
	directories, err := openPrivateMaintenanceChild(preservation, "directories", true)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(directories)
	target := filepath.Join(record.Identity.StoreRoot, filepath.FromSlash(entry.Name))
	previous := filepath.Join(area.Path, record.Identity.PreviousName, "directories", evidenceHash([]byte(strings.ToLower(entry.Name))))
	return preserveRestoreDirectory(record.Identity.Transaction, target, previous, area.restoreRecordStorage(check, 64<<10), check)
}

func openRestoreDirectory(parent windows.Handle, path string) (*os.File, string, error) {
	name, err := windows.NewNTUnicodeString(filepath.Base(path))
	if err != nil {
		return nil, "", err
	}
	attrs := windows.OBJECT_ATTRIBUTES{RootDirectory: parent, ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE|windows.SYNCHRONIZE, &attrs, &status, nil, 0, windows.FILE_SHARE_READ, windows.FILE_OPEN, windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if errors.Is(err, windows.STATUS_OBJECT_NAME_NOT_FOUND) {
		return nil, "", nil
	}
	if err != nil {
		return nil, "", err
	}
	file := os.NewFile(uintptr(handle), path)
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err == nil {
		err = inspectStoreFilePolicy(handle, info.FileAttributes, true)
	}
	if err != nil {
		_ = file.Close()
		return nil, "", err
	}
	return file, fmt.Sprintf("%08x:%08x%08x", info.VolumeSerialNumber, info.FileIndexHigh, info.FileIndexLow), nil
}

// Preserve only an empty obsolete directory, after its files and children have
// been handled. Previous is a flat, unique slot in protected maintenance storage,
// not the original hierarchy (which would collide with preserved descendants).
// Callers keep all writers excluded; directory sharing alone does not lock children.
func preserveRestoreDirectory(transaction, target, previous string, storage restoreIntentStorage, check func() error) error {
	return moveEmptyRestoreDirectory(transaction, target, previous, storage, check, false)
}

// Newly published directories can contain restored files on replay. The native
// identity and pre-move record, rather than emptiness, authorize that replay.
func publishRestoreDirectory(transaction, candidate, target string, storage restoreIntentStorage, check func() error) error {
	return moveEmptyRestoreDirectory(transaction, candidate, target, storage, check, true)
}

func moveEmptyRestoreDirectory(transaction, target, previous string, storage restoreIntentStorage, check func() error, populatedReplay bool) error {
	if check == nil || validateColdBackupName(transaction) != nil || strings.Contains(transaction, "/") {
		return errors.New("directory restore authority required")
	}
	for _, path := range []string{target, previous} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || validateColdBackupName(filepath.Base(path)) != nil {
			return errors.New("canonical directory restore path required")
		}
	}
	if pathsOverlap(target, previous) {
		return errors.New("directory preservation paths overlap")
	}
	if err := check(); err != nil {
		return err
	}
	parents := &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	defer parents.close()
	if err := parents.holdDirectory(filepath.Dir(previous)); err != nil {
		return err
	}
	missingParent := false
	if err := parents.holdDirectory(filepath.Dir(target)); err != nil {
		if !os.IsNotExist(err) {
			return err
		}
		missingParent = true
	}
	open := func(path string) (*os.File, string, error) {
		return openRestoreDirectory(parents.directories[strings.ToLower(filepath.Dir(path))], path)
	}
	var live *os.File
	var liveID string
	var err error
	if !missingParent {
		live, liveID, err = open(target)
	}
	if err != nil {
		return err
	}
	if live != nil {
		defer live.Close()
	}
	old, oldID, err := open(previous)
	if err != nil {
		return err
	}
	if old != nil {
		defer old.Close()
	}
	if (live == nil) == (old == nil) {
		return errors.New("directory preservation has ambiguous presence")
	}
	held, identity := live, liveID
	if live == nil {
		held, identity = old, oldID
	}
	entries, err := held.Readdirnames(1)
	if err != nil && err != io.EOF {
		return err
	}
	if len(entries) != 0 && !(live == nil && populatedReplay) {
		return errors.New("obsolete restore directory is not empty")
	}
	operation := "preserve"
	if populatedReplay {
		operation = "publish"
	}
	record := restoreDirectoryIntent{2, operation, transaction, target, previous, identity}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	key, _ := json.Marshal([]string{transaction, strings.ToLower(target)})
	name := "restore-directory-" + evidenceHash(key) + ".json"
	// A moved directory is replay evidence only if its original intent exists.
	if live == nil {
		if storage.read == nil {
			return errors.New("directory intent reader required")
		}
		existing, err := storage.read(name)
		if err != nil {
			return err
		}
		if string(existing) != string(data) {
			return errors.New("preserved directory identity changed")
		}
		return check()
	}
	if err = persistRestoreRecord(name, data, 64<<10, storage, check); err != nil {
		return err
	}
	if err = check(); err != nil {
		return err
	}
	if err = renameRestoreHandle(live, parents.directories[strings.ToLower(filepath.Dir(previous))], filepath.Base(previous)); err != nil {
		return err
	}
	return check()
}
