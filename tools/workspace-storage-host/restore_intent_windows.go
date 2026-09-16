//go:build windows

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type restoreFileIntent struct {
	SchemaVersion  int              `json:"schemaVersion"`
	Transaction    string           `json:"transaction"`
	Paths          restoreFilePaths `json:"paths"`
	CurrentSHA256  string           `json:"currentSha256"`
	RestoredSHA256 string           `json:"restoredSha256"`
}

type restoreIntentStorage struct {
	read    func(string) ([]byte, error)
	create  func(string) (*os.File, error)
	publish func(*os.File, string, string) error
}

func persistRestoreFileIntent(record restoreFileIntent, storage restoreIntentStorage, assertHeld func() error) error {
	if record.SchemaVersion != 1 || validateColdBackupName(record.Transaction) != nil || strings.Contains(record.Transaction, "/") || !validRestoreHashes(record.CurrentSHA256, record.RestoredSHA256) {
		return errors.New("invalid restore intent")
	}
	if storage.read == nil || storage.create == nil || storage.publish == nil || assertHeld == nil {
		return errors.New("protected intent storage required")
	}
	if err := assertHeld(); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if len(data) > 64<<10 {
		return errors.New("restore intent exceeds bound")
	}
	identity, err := json.Marshal([]string{record.Transaction, strings.ToLower(record.Paths.Target)})
	if err != nil {
		return err
	}
	name := "restore-" + evidenceHash(identity) + ".json"
	return persistRestoreRecord(name, data, 64<<10, storage, assertHeld)
}

func persistRestoreRecord(name string, data []byte, limit int, storage restoreIntentStorage, assertHeld func() error) error {
	if validateColdBackupName(name) != nil || strings.Contains(name, "/") || len(data) == 0 || len(data) > limit || limit > 64<<20 || storage.read == nil || storage.create == nil || storage.publish == nil || assertHeld == nil {
		return errors.New("invalid bounded restore record storage")
	}
	if err := assertHeld(); err != nil {
		return err
	}
	existing, err := storage.read(name)
	if err == nil {
		if !bytes.Equal(existing, data) {
			return errors.New("restore intent conflicts with recorded paths or hashes")
		}
		return assertHeld()
	}
	if !os.IsNotExist(err) {
		return err
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return err
	}
	temporary := "restore-" + hex.EncodeToString(nonce[:]) + ".partial"
	file, err := storage.create(temporary)
	if err != nil {
		return err
	}
	_, writeErr := file.Write(data)
	syncErr := file.Sync()
	if err = errors.Join(writeErr, syncErr); err != nil {
		_ = file.Close()
		return err
	}
	if err = assertHeld(); err != nil {
		_ = file.Close()
		return err
	}
	publishErr := storage.publish(file, temporary, name)
	closeErr := file.Close()
	if err = errors.Join(publishErr, closeErr); err != nil {
		return err
	}
	existing, err = storage.read(name)
	if err != nil {
		return err
	}
	if !bytes.Equal(existing, data) {
		return errors.New("published restore intent changed")
	}
	return assertHeld()
}

func validateMaintenanceRestorePaths(areaPath string, paths restoreFilePaths) error {
	inside := func(root, path string) bool {
		if !filepath.IsAbs(path) || filepath.Clean(path) != path {
			return false
		}
		rel, err := filepath.Rel(root, path)
		return err == nil && rel != "." && filepath.IsLocal(rel)
	}
	if !inside(filepath.Dir(areaPath), paths.Target) || inside(areaPath, paths.Target) || strings.EqualFold(paths.Target, areaPath) {
		return errors.New("restore target is outside the service store")
	}
	if !inside(areaPath, paths.Candidate) || !inside(areaPath, paths.Previous) {
		return errors.New("restore inputs must remain in protected maintenance storage")
	}
	return nil
}

func (area *maintenanceArea) applyRecordedRestoreFile(transaction string, paths restoreFilePaths, currentHash, restoredHash string, assertStopped func() error) error {
	if assertStopped == nil {
		return errors.New("stopped-service authority required")
	}
	if err := validateMaintenanceRestorePaths(area.Path, paths); err != nil {
		return err
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertStopped()
	}
	storage := area.restoreRecordStorage(check, 64<<10)
	return applyRestoreFile(paths, currentHash, restoredHash, check, func(p restoreFilePaths, a, b string) error {
		return persistRestoreFileIntent(restoreFileIntent{1, transaction, p, a, b}, storage, check)
	})
}

func (area *maintenanceArea) restoreRecordStorage(check func() error, limit int) restoreIntentStorage {
	return privateRecordStorage(area.directory, func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		if check == nil {
			return errors.New("record authority required")
		}
		return check()
	}, limit)
}

func privateRecordStorage(parent windows.Handle, check func() error, limit int) restoreIntentStorage {
	guard := func() error {
		if check == nil || limit <= 0 || limit > 64<<20 {
			return errors.New("invalid protected record boundary")
		}
		if parent == 0 {
			return errors.New("protected record directory required")
		}
		return check()
	}
	return restoreIntentStorage{
		read: func(name string) ([]byte, error) {
			if err := guard(); err != nil {
				return nil, err
			}
			handle, err := privateMaintenanceChild(parent, name, false, windows.FILE_OPEN)
			if errors.Is(err, windows.STATUS_OBJECT_NAME_NOT_FOUND) {
				return nil, os.ErrNotExist
			}
			if err != nil {
				return nil, err
			}
			file := os.NewFile(uintptr(handle), name)
			defer file.Close()
			data, err := io.ReadAll(io.LimitReader(file, int64(limit)+1))
			if err != nil {
				return nil, err
			}
			if len(data) > limit {
				return nil, errors.New("stored restore intent exceeds bound")
			}
			return data, nil
		},
		create: func(name string) (*os.File, error) {
			if err := guard(); err != nil {
				return nil, err
			}
			handle, err := privateMaintenanceChildAccess(parent, name, false, windows.FILE_CREATE, windows.DELETE)
			if err != nil {
				return nil, err
			}
			return os.NewFile(uintptr(handle), name), nil
		},
		publish: func(file *os.File, _, name string) error {
			if err := guard(); err != nil {
				return err
			}
			return renameRestoreHandle(file, parent, name)
		},
	}
}
