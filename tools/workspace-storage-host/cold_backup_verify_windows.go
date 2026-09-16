//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Holds verified bytes against modification/replacement until the caller has
// finished consuming them. It does not establish service/store completeness.
type verifiedColdBackup struct {
	directory   string
	pin         string
	manifest    coldBackupManifest
	files       map[string]*os.File
	directories map[string]windows.Handle
}

func (b *verifiedColdBackup) close() {
	for _, file := range b.files {
		_ = file.Close()
	}
	for _, handle := range b.directories {
		_ = windows.CloseHandle(handle)
	}
	b.files = nil
	b.directories = nil
}

func (b *verifiedColdBackup) holdDirectory(directory string) error {
	key := strings.ToLower(directory)
	if _, ok := b.directories[key]; ok {
		return nil
	}
	parent := filepath.Dir(directory)
	if parent != directory {
		if err := b.holdDirectory(parent); err != nil {
			return err
		}
	}
	handle, err := openRealDirectory(directory, false)
	if err != nil {
		return err
	}
	b.directories[key] = handle
	return nil
}

func (b *verifiedColdBackup) openFile(path string) (*os.File, int64, error) {
	if err := b.holdDirectory(filepath.Dir(path)); err != nil {
		return nil, 0, err
	}
	pointer, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return nil, 0, err
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT|windows.FILE_FLAG_SEQUENTIAL_SCAN, 0)
	if err != nil {
		return nil, 0, err
	}
	file := os.NewFile(uintptr(handle), path)
	reject := func(err error) (*os.File, int64, error) { _ = file.Close(); return nil, 0, err }
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return reject(err)
	}
	if info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 || info.NumberOfLinks != 1 {
		return reject(errors.New("backup entry must be an ordinary unlinked file"))
	}
	size := uint64(info.FileSizeHigh)<<32 | uint64(info.FileSizeLow)
	if size > 1<<63-1 {
		return reject(errors.New("backup entry too large"))
	}
	b.files[path] = file
	return file, int64(size), nil
}

func verifyColdBackup(directory, pin string, assertHeld func() error) (*verifiedColdBackup, error) {
	if !filepath.IsAbs(directory) || !migrationDigest(pin) || assertHeld == nil {
		return nil, errors.New("backup identity and ownership required")
	}
	if err := assertHeld(); err != nil {
		return nil, err
	}
	b := &verifiedColdBackup{directory: directory, pin: pin, files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	reject := func(err error) (*verifiedColdBackup, error) { b.close(); return nil, err }
	manifestFile, size, err := b.openFile(filepath.Join(directory, "manifest.json"))
	if err != nil {
		return reject(err)
	}
	if size <= 0 || size > 8<<20 {
		return reject(errors.New("backup manifest exceeds bound"))
	}
	data, err := io.ReadAll(io.NewSectionReader(manifestFile, 0, size))
	if err != nil {
		return reject(err)
	}
	if evidenceHash(data) != pin {
		return reject(errors.New("backup manifest changed"))
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&b.manifest); err != nil {
		return reject(err)
	}
	if err = decoder.Decode(&struct{}{}); err != io.EOF {
		return reject(errors.New("trailing backup manifest content"))
	}
	if b.manifest.SchemaVersion != 1 || len(b.manifest.Files) == 0 || len(b.manifest.Files) > 10000 {
		return reject(errors.New("invalid backup manifest"))
	}
	wantedFiles := map[string]bool{"manifest.json": true}
	wantedDirs := map[string]bool{}
	for _, entry := range b.manifest.Files {
		if err = validateColdBackupName(entry.Name); err != nil {
			return reject(err)
		}
		key := strings.ToLower(entry.Name)
		if wantedFiles[key] || entry.Size < 0 || !migrationDigest(entry.SHA256) {
			return reject(errors.New("invalid or duplicate backup entry"))
		}
		wantedFiles[key] = true
		for parent := filepath.Dir(filepath.FromSlash(key)); parent != "."; parent = filepath.Dir(parent) {
			wantedDirs[filepath.ToSlash(parent)] = true
		}
	}
	// Walk an exact inventory, never following a reparse directory. The protected
	// maintenance owner remains responsible for excluding new entries during use.
	count := 0
	err = filepath.WalkDir(directory, func(path string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := assertHeld(); err != nil {
			return err
		}
		if path == directory {
			return nil
		}
		count++
		if count > 20000 {
			return errors.New("backup tree exceeds bound")
		}
		relative, err := filepath.Rel(directory, path)
		if err != nil {
			return err
		}
		key := strings.ToLower(filepath.ToSlash(relative))
		if entry.IsDir() {
			if !wantedDirs[key] {
				return errors.New("unexpected backup directory")
			}
			return b.holdDirectory(path)
		}
		if !wantedFiles[key] {
			return errors.New("unexpected backup file")
		}
		return nil
	})
	if err != nil {
		return reject(err)
	}
	for _, entry := range b.manifest.Files {
		if err = assertHeld(); err != nil {
			return reject(err)
		}
		file, size, err := b.openFile(filepath.Join(directory, filepath.FromSlash(entry.Name)))
		if err != nil {
			return reject(err)
		}
		if size != entry.Size {
			return reject(errors.New("backup file size changed"))
		}
		hash := sha256.New()
		if _, err = io.Copy(hash, io.NewSectionReader(file, 0, size)); err != nil {
			return reject(err)
		}
		if hex.EncodeToString(hash.Sum(nil)) != entry.SHA256 {
			return reject(errors.New("backup file hash changed"))
		}
	}
	if err = assertHeld(); err != nil {
		return reject(err)
	}
	return b, nil
}
