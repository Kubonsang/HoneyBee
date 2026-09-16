//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

type restoreFilePaths struct {
	Target    string `json:"target"`
	Candidate string `json:"candidate"`
	Previous  string `json:"previous"`
}
type restoreFileHandles struct {
	files       map[string]*os.File
	parents     *verifiedColdBackup
	inspectOnly map[string]bool
}

func (h *restoreFileHandles) close() {
	for _, file := range h.files {
		_ = file.Close()
	}
	h.parents.close()
}

func (h *restoreFileHandles) open(path string) (string, error) {
	parent := filepath.Dir(path)
	if err := h.parents.holdDirectory(parent); err != nil {
		if os.IsNotExist(err) {
			return "", nil
		}
		return "", err
	}
	name, err := windows.NewNTUnicodeString(filepath.Base(path))
	if err != nil {
		return "", err
	}
	attrs := windows.OBJECT_ATTRIBUTES{RootDirectory: h.parents.directories[strings.ToLower(parent)], ObjectName: name, Attributes: windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE}
	attrs.Length = uint32(unsafe.Sizeof(attrs))
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	err = windows.NtCreateFile(&handle, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE|windows.SYNCHRONIZE, &attrs, &status, nil, 0, windows.FILE_SHARE_READ, windows.FILE_OPEN, windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
	if errors.Is(err, windows.STATUS_ACCESS_DENIED) {
		// Metadata may already have restored READONLY. Permit verification-only
		// replay without clearing attributes or weakening access rights.
		err = windows.NtCreateFile(&handle, windows.GENERIC_READ|windows.SYNCHRONIZE, &attrs, &status, nil, 0, windows.FILE_SHARE_READ, windows.FILE_OPEN, windows.FILE_NON_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_SYNCHRONOUS_IO_NONALERT, 0, 0)
		if err == nil {
			if h.inspectOnly == nil {
				h.inspectOnly = map[string]bool{}
			}
			h.inspectOnly[path] = true
		}
	}
	if errors.Is(err, windows.STATUS_OBJECT_NAME_NOT_FOUND) {
		return "", nil
	}
	if err != nil {
		return "", err
	}
	file := os.NewFile(uintptr(handle), path)
	h.files[path] = file
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return "", err
	}
	if info.NumberOfLinks != 1 || info.FileAttributes&(windows.FILE_ATTRIBUTE_REPARSE_POINT|windows.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return "", errors.New("restore requires an ordinary unlinked file")
	}
	if err = inspectStoreFilePolicy(handle, info.FileAttributes, false); err != nil {
		return "", err
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func renameRestoreHandle(file *os.File, parent windows.Handle, name string) error {
	if file == nil || parent == 0 || strings.ContainsAny(name, `/\`) || validateColdBackupName(name) != nil {
		return errors.New("held rename target required")
	}
	encoded, err := windows.UTF16FromString(name)
	if err != nil {
		return err
	}
	type renameInfo struct {
		Replace uint32
		Root    windows.Handle
		Length  uint32
		Name    [1]uint16
	}
	var layout renameInfo
	length := (len(encoded) - 1) * 2
	buffer := make([]byte, int(unsafe.Offsetof(layout.Name))+length)
	info := (*renameInfo)(unsafe.Pointer(&buffer[0]))
	info.Root = parent
	info.Length = uint32(length)
	copy(unsafe.Slice(&info.Name[0], len(encoded)-1), encoded[:len(encoded)-1])
	var status windows.IO_STATUS_BLOCK
	if err = windows.NtSetInformationFile(windows.Handle(file.Fd()), &status, &buffer[0], uint32(len(buffer)), windows.FileRenameInformation); err != nil {
		return err
	}
	return file.Sync()
}

// Internal file-content step only. Caller supplies admitted fixed-store paths,
// a stopped service and protected, idempotent intent persistence binding ALL paths
// and hashes below. Candidate must already be protected. Permissions and mount/SCM
// restoration still follow before any service restart. No CLI exposes this.
func applyRestoreFile(paths restoreFilePaths, currentHash, restoredHash string, assertStopped func() error, persistIntent func(restoreFilePaths, string, string) error) error {
	if !validRestoreHashes(currentHash, restoredHash) || assertStopped == nil || persistIntent == nil {
		return errors.New("restore identities and durable authority required")
	}
	seen := map[string]bool{}
	for _, path := range []string{paths.Target, paths.Candidate, paths.Previous} {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path || validateColdBackupName(filepath.Base(path)) != nil {
			return errors.New("canonical restore paths required")
		}
		key := strings.ToLower(path)
		if seen[key] {
			return errors.New("restore paths must be distinct")
		}
		seen[key] = true
	}
	if err := assertStopped(); err != nil {
		return err
	}
	held := &restoreFileHandles{files: map[string]*os.File{}, parents: &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}}
	defer held.close()
	target, err := held.open(paths.Target)
	if err != nil {
		return err
	}
	candidate, err := held.open(paths.Candidate)
	if err != nil {
		return err
	}
	previous, err := held.open(paths.Previous)
	if err != nil {
		return err
	}
	initial := target == currentHash && candidate == restoredHash && previous == ""
	interrupted := target == "" && candidate == restoredHash && previous == currentHash
	applied := target == restoredHash && candidate == "" && previous == currentHash
	if currentHash == restoredHash {
		// No move is needed, but require the staged copy and absence of unexpected
		// preservation evidence. Metadata restoration remains a separate step.
		interrupted = false
		applied = initial
	}
	if !initial && !interrupted && !applied {
		return errors.New("restore file identities do not match a recoverable state")
	}
	// On replay this must verify the existing protected intent, never authorize
	// an unrelated state from hashes alone. No rename precedes durable intent.
	if err = persistIntent(paths, currentHash, restoredHash); err != nil {
		return err
	}
	if err = assertStopped(); err != nil {
		return err
	}
	if applied {
		return nil
	}
	if (initial && currentHash != "" && held.inspectOnly[paths.Target]) || (restoredHash != "" && held.inspectOnly[paths.Candidate]) {
		return errors.New("restore mutation requires writable admitted files; verification-only handle cannot rename")
	}
	if initial && currentHash != "" {
		if err = renameRestoreHandle(held.files[paths.Target], held.parents.directories[strings.ToLower(filepath.Dir(paths.Previous))], filepath.Base(paths.Previous)); err != nil {
			return err
		}
	}
	if err = assertStopped(); err != nil {
		return err
	}
	if restoredHash != "" {
		if err = renameRestoreHandle(held.files[paths.Candidate], held.parents.directories[strings.ToLower(filepath.Dir(paths.Target))], filepath.Base(paths.Target)); err != nil {
			return err
		}
	}
	return assertStopped()
}

// Empty means inventory-proven absence, not an unknown identity. Removing a
// post-backup file preserves it in maintenance storage rather than deleting it.
func validRestoreHashes(current, restored string) bool {
	return (current != "" || restored != "") && (current == "" || migrationDigest(current)) && (restored == "" || migrationDigest(restored))
}
