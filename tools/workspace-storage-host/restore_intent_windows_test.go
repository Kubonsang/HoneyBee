//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func restoreIntentFixture(t *testing.T) (string, restoreIntentStorage) {
	t.Helper()
	root := t.TempDir()
	parent, err := openRealDirectory(root, false)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.CloseHandle(parent) })
	return root, restoreIntentStorage{
		read: func(name string) ([]byte, error) { return os.ReadFile(filepath.Join(root, name)) },
		create: func(name string) (*os.File, error) {
			pointer, err := windows.UTF16PtrFromString(filepath.Join(root, name))
			if err != nil {
				return nil, err
			}
			handle, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.GENERIC_WRITE|windows.DELETE, 0, nil, windows.CREATE_NEW, windows.FILE_ATTRIBUTE_NORMAL, 0)
			if err != nil {
				return nil, err
			}
			return os.NewFile(uintptr(handle), name), nil
		},
		publish: func(file *os.File, _, name string) error { return renameRestoreHandle(file, parent, name) },
	}
}

func TestRestoreIntentAtomicPublicationAndConflict(t *testing.T) {
	root, storage := restoreIntentFixture(t)
	paths := restoreFileFixture(t)
	record := restoreFileIntent{1, "transaction-1", paths, evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))}
	check := func() error { return nil }
	broken := storage
	broken.publish = func(*os.File, string, string) error { return errors.New("interrupted publication") }
	if err := persistRestoreFileIntent(record, broken, check); err == nil {
		t.Fatal("ignored publication failure")
	}
	entries, err := os.ReadDir(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(entries) != 1 || !strings.HasSuffix(entries[0].Name(), ".partial") {
		t.Fatal("published interrupted intent", entries)
	}
	if err = persistRestoreFileIntent(record, storage, check); err != nil {
		t.Fatal(err)
	}
	replay := storage
	replay.create = func(string) (*os.File, error) { t.Fatal("rewrote committed intent"); return nil, nil }
	if err = persistRestoreFileIntent(record, replay, check); err != nil {
		t.Fatal(err)
	}
	changed := record
	changed.RestoredSHA256 = evidenceHash([]byte("other"))
	if err = persistRestoreFileIntent(changed, replay, check); err == nil {
		t.Fatal("accepted conflicting hash")
	}
	changed = record
	changed.Paths.Candidate = filepath.Join(filepath.Dir(paths.Candidate), "other.exe")
	if err = persistRestoreFileIntent(changed, replay, check); err == nil {
		t.Fatal("accepted conflicting candidate")
	}
	entries, err = os.ReadDir(root)
	if err != nil || len(entries) != 2 {
		t.Fatal("lost partial evidence or wrote conflicting intent", entries, err)
	}
}

func TestRecordedRestoreIntentBindsNativeFileReplay(t *testing.T) {
	_, storage := restoreIntentFixture(t)
	paths := restoreFileFixture(t)
	current, restored := evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))
	persist := func(p restoreFilePaths, a, b string) error {
		return persistRestoreFileIntent(restoreFileIntent{1, "replay", p, a, b}, storage, func() error { return nil })
	}
	once := true
	check := func() error {
		if _, err := os.Stat(paths.Previous); err == nil && once {
			once = false
			return errors.New("injected interruption")
		}
		return nil
	}
	if err := applyRestoreFile(paths, current, restored, check, persist); err == nil {
		t.Fatal("ignored interruption")
	}
	if err := applyRestoreFile(paths, current, restored, check, persist); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(paths.Target); err != nil || string(data) != "old service" {
		t.Fatal("restore replay failed", err)
	}
}

func TestMaintenanceRestorePathBoundary(t *testing.T) {
	area := `C:\ProgramData\UnityWorkspaceStorage\maintenance`
	valid := restoreFilePaths{`C:\ProgramData\UnityWorkspaceStorage\broker\host.exe`, area + `\candidate\host.exe`, area + `\previous\host.exe`}
	if err := validateMaintenanceRestorePaths(area, valid); err != nil {
		t.Fatal(err)
	}
	for _, target := range []string{`C:\Users\user\project\file`, area + `\operation.lock`, area, `C:\ProgramData\UnityWorkspaceStorage-other\file`} {
		paths := valid
		paths.Target = target
		if err := validateMaintenanceRestorePaths(area, paths); err == nil {
			t.Fatal("accepted outside/protected target", target)
		}
	}
	paths := valid
	paths.Candidate = `C:\Users\user\Downloads\candidate.exe`
	if err := validateMaintenanceRestorePaths(area, paths); err == nil {
		t.Fatal("accepted unprotected input")
	}
}
