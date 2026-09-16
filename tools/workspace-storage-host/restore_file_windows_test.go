//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"golang.org/x/sys/windows"
)

func restoreFileFixture(t *testing.T) restoreFilePaths {
	t.Helper()
	root := t.TempDir()
	for _, name := range []string{"live", "stage", "previous"} {
		if err := os.Mkdir(filepath.Join(root, name), 0700); err != nil {
			t.Fatal(err)
		}
	}
	paths := restoreFilePaths{filepath.Join(root, "live", "broker.exe"), filepath.Join(root, "stage", "broker.exe"), filepath.Join(root, "previous", "broker.exe")}
	if err := os.WriteFile(paths.Target, []byte("new service"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(paths.Candidate, []byte("old service"), 0600); err != nil {
		t.Fatal(err)
	}
	return paths
}

func TestRestoreFileReplaysAfterReadonlyMetadata(t *testing.T) {
	paths := restoreFileFixture(t)
	current, restored := evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))
	_, storage := restoreIntentFixture(t)
	check := func() error { return nil }
	persist := func(p restoreFilePaths, a, b string) error {
		return persistRestoreFileIntent(restoreFileIntent{1, "readonly", p, a, b}, storage, check)
	}
	if err := applyRestoreFile(paths, current, restored, check, persist); err != nil {
		t.Fatal(err)
	}
	pointer, _ := windows.UTF16PtrFromString(paths.Target)
	if err := windows.SetFileAttributes(pointer, windows.FILE_ATTRIBUTE_READONLY); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = windows.SetFileAttributes(pointer, windows.FILE_ATTRIBUTE_NORMAL) })
	if err := applyRestoreFile(paths, current, restored, check, persist); err != nil {
		t.Fatal("readonly replay failed", err)
	}
	attrs, err := windows.GetFileAttributes(pointer)
	if err != nil || attrs&windows.FILE_ATTRIBUTE_READONLY == 0 {
		t.Fatal("replay cleared readonly", err)
	}
}

func TestRestoreFileResumesAfterOriginalWasPreserved(t *testing.T) {
	paths := restoreFileFixture(t)
	current, restored := evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))
	checks := 0
	intentSaved := false
	persist := func(actual restoreFilePaths, a, b string) error {
		if actual != paths || a != current || b != restored {
			t.Fatal("wrong intent")
		}
		intentSaved = true
		return nil
	}
	err := applyRestoreFile(paths, current, restored, func() error {
		checks++
		if checks == 3 {
			return errors.New("interrupted after preservation")
		}
		return nil
	}, persist)
	if err == nil || !intentSaved {
		t.Fatal("ignored interruption")
	}
	if _, err = os.Stat(paths.Target); !os.IsNotExist(err) {
		t.Fatal("unexpected target after interruption")
	}
	if data, err := os.ReadFile(paths.Previous); err != nil || string(data) != "new service" {
		t.Fatal("lost prior file", err)
	}
	if err = applyRestoreFile(paths, current, restored, func() error { return nil }, persist); err != nil {
		t.Fatal(err)
	}
	if err = applyRestoreFile(paths, current, restored, func() error { return nil }, persist); err != nil {
		t.Fatal("replay failed", err)
	}
	if data, err := os.ReadFile(paths.Target); err != nil || string(data) != "old service" {
		t.Fatal("wrong restored file", err)
	}
	if data, err := os.ReadFile(paths.Previous); err != nil || string(data) != "new service" {
		t.Fatal("lost preserved file", err)
	}
}

func TestRestoreFileRefusesUnknownStateAndFailedIntent(t *testing.T) {
	for _, kind := range []string{"unknown-target", "occupied-previous", "intent-failure", "busy-target"} {
		t.Run(kind, func(t *testing.T) {
			paths := restoreFileFixture(t)
			persist := func(restoreFilePaths, string, string) error { return nil }
			switch kind {
			case "unknown-target":
				if err := os.WriteFile(paths.Target, []byte("unrecognized"), 0600); err != nil {
					t.Fatal(err)
				}
			case "occupied-previous":
				if err := os.WriteFile(paths.Previous, []byte("evidence"), 0600); err != nil {
					t.Fatal(err)
				}
			case "intent-failure":
				persist = func(restoreFilePaths, string, string) error { return errors.New("journal write failed") }
			case "busy-target":
				file, err := os.OpenFile(paths.Target, os.O_RDWR, 0600)
				if err != nil {
					t.Fatal(err)
				}
				defer file.Close()
			}
			err := applyRestoreFile(paths, evidenceHash([]byte("new service")), evidenceHash([]byte("old service")), func() error { return nil }, persist)
			if err == nil {
				t.Fatal("accepted unsafe replacement")
			}
			if _, err = os.Stat(paths.Target); err != nil {
				t.Fatal("lost target on refusal")
			}
			if data, err := os.ReadFile(paths.Candidate); err != nil || string(data) != "old service" {
				t.Fatal("changed candidate on refusal", err)
			}
		})
	}
}

func TestRestoreFileInventoryPresencePolicies(t *testing.T) {
	for _, policy := range []string{"missing", "post-backup", "unchanged"} {
		t.Run(policy, func(t *testing.T) {
			paths := restoreFileFixture(t)
			current, restored := evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))
			switch policy {
			case "missing":
				if err := os.Remove(paths.Target); err != nil {
					t.Fatal(err)
				}
				current = ""
			case "post-backup":
				if err := os.Remove(paths.Candidate); err != nil {
					t.Fatal(err)
				}
				restored = ""
			case "unchanged":
				if err := os.WriteFile(paths.Target, []byte("old service"), 0600); err != nil {
					t.Fatal(err)
				}
				current = restored
			}
			_, storage := restoreIntentFixture(t)
			persist := func(p restoreFilePaths, a, b string) error {
				return persistRestoreFileIntent(restoreFileIntent{1, policy, p, a, b}, storage, func() error { return nil })
			}
			checks := 0
			interruption := errors.New("process interruption")
			err := applyRestoreFile(paths, current, restored, func() error {
				checks++
				if checks == 3 {
					return interruption
				}
				return nil
			}, persist)
			// An unchanged file returns after intent verification without a mutation.
			if policy != "unchanged" && !errors.Is(err, interruption) {
				t.Fatalf("unexpected interruption: %v", err)
			}
			if policy == "unchanged" && err != nil {
				t.Fatal(err)
			}
			for i := 0; i < 2; i++ {
				if err = applyRestoreFile(paths, current, restored, func() error { return nil }, persist); err != nil {
					t.Fatal(err)
				}
			}
			if policy == "post-backup" {
				if _, err = os.Stat(paths.Target); !os.IsNotExist(err) {
					t.Fatal("post-backup file still active")
				}
				data, err := os.ReadFile(paths.Previous)
				if err != nil || string(data) != "new service" {
					t.Fatal("post-backup bytes not preserved", err)
				}
			} else {
				data, err := os.ReadFile(paths.Target)
				if err != nil || string(data) != "old service" {
					t.Fatal("source bytes not restored", err)
				}
			}
		})
	}
}

func TestRestoreFilePresencePolicyRefusesUnexpectedEvidence(t *testing.T) {
	for _, policy := range []string{"missing-but-present", "removed-but-staged", "unchanged-but-different", "unknown-absence"} {
		t.Run(policy, func(t *testing.T) {
			paths := restoreFileFixture(t)
			current, restored := evidenceHash([]byte("new service")), evidenceHash([]byte("old service"))
			switch policy {
			case "missing-but-present":
				current = ""
			case "removed-but-staged":
				restored = ""
			case "unchanged-but-different":
				current = restored
			case "unknown-absence":
				current, restored = "", ""
			}
			intent := false
			err := applyRestoreFile(paths, current, restored, func() error { return nil }, func(restoreFilePaths, string, string) error { intent = true; return nil })
			if err == nil || intent {
				t.Fatal("unexpected filesystem state authorized")
			}
			for path, want := range map[string]string{paths.Target: "new service", paths.Candidate: "old service"} {
				data, err := os.ReadFile(path)
				if err != nil || string(data) != want {
					t.Fatal("refusal changed bytes", err)
				}
			}
		})
	}
}
