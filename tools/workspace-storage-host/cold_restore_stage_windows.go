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

	"golang.org/x/sys/windows"
)

// Prepare a separate protected copy before touching any installed service file.
// Backup handles stay held while consuming verified bytes. SCM/ACL/mount restore
// and publication are deliberately not implied by a successful staging result.
func (area *maintenanceArea) stageRestore(sourceName, pin, candidateName string, assertQuiet func() error) (string, error) {
	if err := validateColdBackupName(sourceName); err != nil {
		return "", err
	}
	if strings.Contains(sourceName, "/") {
		return "", errors.New("backup source must be one maintenance child")
	}
	output, closeOutput, check, err := area.backupOutput(candidateName, assertQuiet)
	if err != nil {
		return "", err
	}
	defer closeOutput()
	backup, err := verifyColdBackup(filepath.Join(area.Path, sourceName), pin, check)
	if err != nil {
		return "", err
	}
	defer backup.close()
	if _, err = readStoreRestoreInventory(backup); err != nil {
		return "", err
	}
	return stageColdRestoreTo(backup, filepath.Join(area.Path, candidateName), check, output)
}

func stageColdRestoreTo(backup *verifiedColdBackup, destination string, assertQuiet func() error, output coldBackupOutput) (string, error) {
	if backup == nil || len(backup.files) == 0 || !migrationDigest(backup.pin) || assertQuiet == nil || !filepath.IsAbs(destination) || pathsOverlap(backup.directory, destination) {
		return "", errors.New("held backup and separate restore destination required")
	}
	if output.createRoot == nil || output.prepareParent == nil || output.createFile == nil {
		return "", errors.New("restore output factory required")
	}
	if err := assertQuiet(); err != nil {
		return "", err
	}
	if _, err := os.Lstat(destination); err == nil {
		// A completed candidate is reusable only after full revalidation. Partial
		// or mismatched attempts are retained; retry with a fresh candidate name.
		existing, err := verifyColdBackup(destination, backup.pin, assertQuiet)
		if err != nil {
			return "", err
		}
		existing.close()
		return backup.pin, nil
	} else if !os.IsNotExist(err) {
		return "", err
	}
	manifestFile := backup.files[filepath.Join(backup.directory, "manifest.json")]
	if manifestFile == nil {
		return "", errors.New("held backup manifest missing")
	}
	stat, err := manifestFile.Stat()
	if err != nil {
		return "", err
	}
	if stat.Size() <= 0 || stat.Size() > 8<<20 {
		return "", errors.New("invalid backup manifest length")
	}
	required := uint64(64<<20) + uint64(stat.Size())
	for _, entry := range backup.manifest.Files {
		if entry.Size < 0 || required > ^uint64(0)-uint64(entry.Size) {
			return "", errors.New("restore size overflow")
		}
		required += uint64(entry.Size)
	}
	parent := filepath.Dir(destination)
	if err = backup.holdDirectory(parent); err != nil {
		return "", err
	}
	volume, err := windows.UTF16PtrFromString(parent)
	if err != nil {
		return "", err
	}
	var available uint64
	if err = windows.GetDiskFreeSpaceEx(volume, &available, nil, nil); err != nil {
		return "", err
	}
	if available < required {
		return "", errors.New("insufficient space to stage complete restore")
	}
	if err = assertQuiet(); err != nil {
		return "", err
	}
	if err = output.createRoot(); err != nil {
		return "", err
	}
	copyEntry := func(name string, source *os.File, size int64, expected string) error {
		if source == nil {
			return errors.New("verified backup file handle missing")
		}
		if err := assertQuiet(); err != nil {
			return err
		}
		if err := output.prepareParent(name); err != nil {
			return err
		}
		if err := backup.holdDirectory(filepath.Dir(filepath.Join(destination, filepath.FromSlash(name)))); err != nil {
			return err
		}
		file, err := output.createFile(name)
		if err != nil {
			return err
		}
		hash := sha256.New()
		count, copyErr := io.Copy(io.MultiWriter(file, hash), io.NewSectionReader(source, 0, size))
		syncErr := file.Sync()
		closeErr := file.Close()
		if err = errors.Join(copyErr, syncErr, closeErr); err != nil {
			return err
		}
		if count != size || hex.EncodeToString(hash.Sum(nil)) != expected {
			return errors.New("restore staging bytes differ from backup")
		}
		return nil
	}
	for _, entry := range backup.manifest.Files {
		if err = copyEntry(entry.Name, backup.files[filepath.Join(backup.directory, filepath.FromSlash(entry.Name))], entry.Size, entry.SHA256); err != nil {
			return "", err
		}
	}
	if err = copyEntry("manifest.json", manifestFile, stat.Size(), backup.pin); err != nil {
		return "", err
	}
	verified, err := verifyColdBackup(destination, backup.pin, assertQuiet)
	if err != nil {
		return "", err
	}
	verified.close()
	return backup.pin, nil
}
