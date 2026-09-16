//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestProtectedBackupRequiresHeldMaintenanceArea(t *testing.T) {
	area := &maintenanceArea{Path: t.TempDir()}
	if _, err := area.captureBackup("backup", []coldBackupInput{{"source", filepath.Join(area.Path, "source")}}, func() error { return nil }); err == nil {
		t.Fatal("created privileged output without maintenance ownership")
	}
	entries, err := os.ReadDir(area.Path)
	if err != nil || len(entries) != 0 {
		t.Fatal("changed rejected destination", entries, err)
	}
}

func TestColdBackupUsesOutputFactoryForManifest(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	if err := os.WriteFile(source, []byte("data"), 0600); err != nil {
		t.Fatal(err)
	}
	destination := filepath.Join(root, "backup")
	manifestAttempted := false
	_, err := captureColdFilesTo(destination, []coldBackupInput{{"source", source}}, func() error { return nil }, coldBackupOutput{
		createRoot:    func() error { return os.Mkdir(destination, 0700) },
		prepareParent: func(string) error { return nil },
		createFile: func(name string) (*os.File, error) {
			if name == "manifest.json" {
				manifestAttempted = true
				return nil, errors.New("protected creation denied")
			}
			return os.OpenFile(filepath.Join(destination, name), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		},
	})
	if err == nil || !manifestAttempted {
		t.Fatal("manifest bypassed output factory", err)
	}
	if _, err = os.Stat(filepath.Join(destination, "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("published manifest after creation failure")
	}
	if data, err := os.ReadFile(filepath.Join(destination, "source")); err != nil || string(data) != "data" {
		t.Fatal("lost partial backup", err)
	}
}

func TestColdBackupSignedSizeAdmissionPrecedesOutputAndHoldsSource(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "host.exe")
	if err := os.WriteFile(source, []byte("host"), 0600); err != nil {
		t.Fatal(err)
	}
	created := false
	_, err := captureColdFilesTo(filepath.Join(root, "candidate"), []coldBackupInput{{"host.exe", source}}, func() error { return nil }, coldBackupOutput{
		admitSource: func(name string, size int64) error {
			if name != "host.exe" || size != 4 {
				t.Fatal("wrong source identity")
			}
			if err := os.WriteFile(source, []byte("changed"), 0600); err == nil {
				t.Fatal("source changed during admission")
			}
			return errors.New("signed size mismatch")
		},
		createRoot:    func() error { created = true; return nil },
		prepareParent: func(string) error { return nil },
		createFile:    func(string) (*os.File, error) { t.Fatal("wrote unadmitted candidate"); return nil, nil },
	})
	if err == nil || created {
		t.Fatal("published before signed admission", err)
	}
}
