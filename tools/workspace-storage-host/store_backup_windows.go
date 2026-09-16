//go:build windows

package main

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"reflect"

	"golang.org/x/sys/windows"
)

// Captures the fixed store associated with this maintenance area. The coordinator
// still supplies detached-disk/stopped-service admission and separate SCM/mount
// recovery records. Project sources outside the store are never copied or changed.
func (area *maintenanceArea) captureStoreBackup(name string, assertQuiet func() error) (string, error) {
	if assertQuiet == nil {
		return "", errors.New("store quiescence authority required")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertQuiet()
	}
	if err := check(); err != nil {
		return "", err
	}
	root := filepath.Dir(area.Path)
	inventory, err := inventoryColdStore(root, check)
	if err != nil {
		return "", fmt.Errorf("before store backup: %w", err)
	}
	if err = validateStoreInventory(inventory); err != nil {
		return "", err
	}
	metadata, err := json.Marshal(inventory)
	if err != nil {
		return "", err
	}
	if len(metadata) > 16<<20 {
		return "", errors.New("store inventory metadata exceeds bound")
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return "", err
	}
	metadataName := "inventory-" + hex.EncodeToString(nonce[:]) + ".json"
	if err = check(); err != nil {
		return "", err
	}
	handle, err := privateMaintenanceChild(area.directory, metadataName, false, windows.FILE_CREATE)
	if err != nil {
		return "", err
	}
	metadataPath := filepath.Join(area.Path, metadataName)
	file := os.NewFile(uintptr(handle), metadataPath)
	_, writeErr := file.Write(metadata)
	syncErr := file.Sync()
	closeErr := file.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return "", err
	}
	// The metadata original is retained as transaction evidence even if capture
	// fails. It lives under the excluded protected maintenance subtree.
	inputs := []coldBackupInput{{Name: "store-inventory.json", Source: metadataPath}}
	for _, entry := range inventory.Entries {
		if !entry.Directory {
			inputs = append(inputs, coldBackupInput{Name: "store/" + entry.Name, Source: filepath.Join(root, filepath.FromSlash(entry.Name))})
		}
	}
	pin, err := area.captureBackup(name, inputs, assertQuiet)
	if err != nil {
		return "", err
	}
	verified, err := verifyColdBackup(filepath.Join(area.Path, name), pin, check)
	if err != nil {
		return "", err
	}
	defer verified.close()
	if err = matchStoreBackup(inventory, verified.manifest); err != nil {
		return "", err
	}
	metadataMatches := false
	for _, entry := range verified.manifest.Files {
		if entry.Name == "store-inventory.json" {
			metadataMatches = entry.Size == int64(len(metadata)) && entry.SHA256 == evidenceHash(metadata)
		}
	}
	if !metadataMatches {
		return "", errors.New("captured restore metadata changed")
	}
	// Catch additions, removals and permission changes that file-by-file copy
	// alone cannot detect. A mismatch is a failed backup, never recovery-ready.
	after, err := inventoryColdStore(root, check)
	if err != nil {
		return "", fmt.Errorf("after store backup: %w", err)
	}
	if !reflect.DeepEqual(inventory, after) {
		return "", errors.New("store inventory changed during backup")
	}
	return pin, check()
}
