//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestColdBackupCopiesAndPinsFiles(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source.vhdx")
	_ = os.WriteFile(source, []byte("fixture disk bytes"), 0600)
	destination := filepath.Join(root, "backup")
	digest, err := captureColdFiles(destination, []coldBackupInput{{"disks/child.vhdx", source}}, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	data, err := os.ReadFile(filepath.Join(destination, "manifest.json"))
	if err != nil {
		t.Fatal(err)
	}
	if evidenceHash(data) != digest {
		t.Fatal("manifest pin mismatch")
	}
	var manifest coldBackupManifest
	if err = json.Unmarshal(data, &manifest); err != nil {
		t.Fatal(err)
	}
	if len(manifest.Files) != 1 || manifest.Files[0].SHA256 != evidenceHash([]byte("fixture disk bytes")) {
		t.Fatal(manifest)
	}
	if data, err = os.ReadFile(source); err != nil || string(data) != "fixture disk bytes" {
		t.Fatal("source changed")
	}
}
func TestColdBackupRefusesBusySource(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	_ = os.WriteFile(source, []byte("data"), 0600)
	writer, err := os.OpenFile(source, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer writer.Close()
	if _, err = captureColdFiles(filepath.Join(root, "backup"), []coldBackupInput{{"source", source}}, func() error { return nil }); err == nil {
		t.Fatal("copied a busy source")
	}
}
func TestColdBackupRefusesUnsafeInventory(t *testing.T) {
	for _, name := range []string{"../outside", "folder/../outside", "manifest.json", "file.", "disk:stream", "NUL", "COM1.txt", "bad*name"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			source := filepath.Join(root, "source")
			_ = os.WriteFile(source, []byte("data"), 0600)
			destination := filepath.Join(root, "backup")
			if _, err := captureColdFiles(destination, []coldBackupInput{{name, source}}, func() error { return nil }); err == nil {
				t.Fatal("accepted invalid entry")
			}
			if _, err := os.Stat(destination); !os.IsNotExist(err) {
				t.Fatal("created output on rejected inventory")
			}
		})
	}
}
func TestColdBackupLostQuiescencePreservesPartialWithoutManifest(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	_ = os.WriteFile(source, []byte("data"), 0600)
	destination := filepath.Join(root, "backup")
	calls := 0
	_, err := captureColdFiles(destination, []coldBackupInput{{"source", source}}, func() error {
		calls++
		if calls == 4 {
			return errors.New("writer exclusion lost")
		}
		return nil
	})
	if err == nil {
		t.Fatal("ignored quiescence loss")
	}
	if _, err = os.Stat(filepath.Join(destination, "source")); err != nil {
		t.Fatal("partial evidence missing")
	}
	if _, err = os.Stat(filepath.Join(destination, "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("marked incomplete copy complete")
	}
}
