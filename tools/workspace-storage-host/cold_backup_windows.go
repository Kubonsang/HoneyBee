//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type coldBackupFile struct {
	Name   string `json:"name"`
	Size   int64  `json:"size"`
	SHA256 string `json:"sha256"`
}
type coldBackupManifest struct {
	SchemaVersion int              `json:"schemaVersion"`
	Files         []coldBackupFile `json:"files"`
}
type coldBackupInput struct{ Name, Source string }

func validateColdBackupName(name string) error {
	if name == "" || strings.ContainsAny(name, `\:`) || !filepath.IsLocal(filepath.FromSlash(name)) {
		return errors.New("invalid backup entry")
	}
	for _, part := range strings.Split(name, "/") {
		base := strings.ToUpper(strings.SplitN(part, ".", 2)[0])
		reserved := base == "CON" || base == "PRN" || base == "AUX" || base == "NUL" || len(base) == 4 && (strings.HasPrefix(base, "COM") || strings.HasPrefix(base, "LPT")) && base[3] >= '1' && base[3] <= '9'
		if part == "" || part == "." || part == ".." || strings.TrimRight(part, " .") != part || reserved || strings.ContainsAny(part, "<>\"|?*\x00\x01\x02\x03\x04\x05\x06\x07\x08\x09\x0a\x0b\x0c\x0d\x0e\x0f\x10\x11\x12\x13\x14\x15\x16\x17\x18\x19\x1a\x1b\x1c\x1d\x1e\x1f") {
			return errors.New("invalid backup path component")
		}
	}
	return nil
}

// File-copy primitive only. The privileged caller must enumerate the entire recovery
// unit, hold application/service exclusion and confirm all virtual disks detached.
// It does not itself grant recoveryReady or stop/restore a service.
func captureColdFiles(destination string, inputs []coldBackupInput, assertQuiet func() error) (string, error) {
	return captureColdFilesTo(destination, inputs, assertQuiet, coldBackupOutput{
		createRoot: func() error { return os.Mkdir(destination, 0700) },
		prepareParent: func(name string) error {
			return os.MkdirAll(filepath.Dir(filepath.Join(destination, filepath.FromSlash(name))), 0700)
		},
		createFile: func(name string) (*os.File, error) {
			target := filepath.Join(destination, filepath.FromSlash(name))
			return os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		},
	})
}

type coldBackupOutput struct {
	admitSource   func(string, int64) error // optional signed size admission under exclusive source handle
	createRoot    func() error
	prepareParent func(string) error
	createFile    func(string) (*os.File, error)
}

func captureColdFilesTo(destination string, inputs []coldBackupInput, assertQuiet func() error, outputFiles coldBackupOutput) (string, error) {
	if !filepath.IsAbs(destination) || outputFiles.createRoot == nil || outputFiles.prepareParent == nil || outputFiles.createFile == nil {
		return "", errors.New("absolute backup destination and output factory required")
	}
	if assertQuiet == nil || len(inputs) == 0 || len(inputs) > 10000 {
		return "", errors.New("bounded backup inventory and quiescence authority required")
	}
	if err := assertQuiet(); err != nil {
		return "", err
	}
	if err := inspectLocalPath(filepath.Dir(destination)); err != nil {
		return "", err
	}
	if _, err := os.Lstat(destination); !os.IsNotExist(err) {
		return "", errors.New("backup destination must be new")
	}
	handles := []*os.File{}
	directoryHandles := map[string]windows.Handle{}
	defer func() {
		for _, file := range handles {
			_ = file.Close()
		}
		for _, handle := range directoryHandles {
			_ = windows.CloseHandle(handle)
		}
	}()
	lockParents := func(directory string) error {
		chain := []string{}
		for {
			chain = append(chain, directory)
			parent := filepath.Dir(directory)
			if parent == directory {
				break
			}
			directory = parent
		}
		for index := len(chain) - 1; index >= 0; index-- {
			directory = chain[index]
			if _, ok := directoryHandles[strings.ToLower(directory)]; !ok {
				handle, err := openRealDirectory(directory, false)
				if err != nil {
					return err
				}
				directoryHandles[strings.ToLower(directory)] = handle
			}
		}
		return nil
	}
	seen := map[string]bool{}
	sizes := []int64{}
	required := uint64(64 << 20)
	for _, input := range inputs {
		name := input.Name
		if err := validateColdBackupName(name); err != nil {
			return "", err
		}
		if seen[strings.ToLower(name)] || strings.EqualFold(name, "manifest.json") {
			return "", errors.New("duplicate or reserved backup entry")
		}
		seen[strings.ToLower(name)] = true
		if !filepath.IsAbs(input.Source) || pathsOverlap(destination, input.Source) {
			return "", errors.New("backup source overlaps destination")
		}
		if err := inspectLocalPath(input.Source); err != nil {
			return "", err
		}
		if err := lockParents(filepath.Dir(input.Source)); err != nil {
			return "", err
		}
		pointer, err := windows.UTF16PtrFromString(input.Source)
		if err != nil {
			return "", err
		}
		handle, err := windows.CreateFile(pointer, windows.GENERIC_READ, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
		if err != nil {
			return "", err
		}
		file := os.NewFile(uintptr(handle), input.Source)
		handles = append(handles, file)
		var info windows.ByHandleFileInformation
		if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
			return "", err
		}
		if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks != 1 {
			return "", errors.New("backup source is not an exclusive ordinary file")
		}
		size := uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)
		if size > uint64(1<<63-1) || required > ^uint64(0)-size {
			return "", errors.New("backup size overflow")
		}
		if outputFiles.admitSource != nil {
			if err := outputFiles.admitSource(name, int64(size)); err != nil {
				return "", err
			}
		}
		required += size
		sizes = append(sizes, int64(size))
	}
	if err := lockParents(filepath.Dir(destination)); err != nil {
		return "", err
	}
	volume, err := windows.UTF16PtrFromString(filepath.Dir(destination))
	if err != nil {
		return "", err
	}
	var available uint64
	if err = windows.GetDiskFreeSpaceEx(volume, &available, nil, nil); err != nil {
		return "", err
	}
	if available < required {
		return "", errors.New("insufficient space for cold backup and headroom")
	}
	if err = assertQuiet(); err != nil {
		return "", err
	}
	if err = outputFiles.createRoot(); err != nil {
		return "", err
	}
	if err = lockParents(destination); err != nil {
		return "", err
	}
	manifest := coldBackupManifest{SchemaVersion: 1}
	for index, input := range inputs {
		if err = assertQuiet(); err != nil {
			return "", err
		}
		target := filepath.Join(destination, filepath.FromSlash(input.Name))
		if err = outputFiles.prepareParent(input.Name); err != nil {
			return "", err
		}
		if err = lockParents(filepath.Dir(target)); err != nil {
			return "", err
		}
		output, err := outputFiles.createFile(input.Name)
		if err != nil {
			return "", err
		}
		hash := sha256.New()
		count, copyErr := io.Copy(io.MultiWriter(output, hash), handles[index])
		syncErr := output.Sync()
		closeErr := output.Close()
		if err = errors.Join(copyErr, syncErr, closeErr); err != nil {
			return "", err
		}
		if count != sizes[index] {
			return "", errors.New("backup source size changed")
		}
		expected := hex.EncodeToString(hash.Sum(nil))
		copied, err := os.Open(target)
		if err != nil {
			return "", err
		}
		verified := sha256.New()
		_, readErr := io.Copy(verified, copied)
		closeErr = copied.Close()
		if err = errors.Join(readErr, closeErr); err != nil {
			return "", err
		}
		if hex.EncodeToString(verified.Sum(nil)) != expected {
			return "", errors.New("backup content verification failed")
		}
		manifest.Files = append(manifest.Files, coldBackupFile{input.Name, count, expected})
	}
	if err = assertQuiet(); err != nil {
		return "", err
	}
	bytes, err := json.Marshal(manifest)
	if err != nil {
		return "", err
	}
	manifestFile, err := outputFiles.createFile("manifest.json")
	if err != nil {
		return "", err
	}
	_, writeErr := manifestFile.Write(bytes)
	syncErr := manifestFile.Sync()
	closeErr := manifestFile.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return "", err
	}
	return evidenceHash(bytes), nil
}
