//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func coldVerificationFixture(t *testing.T) (string, string) {
	t.Helper()
	root := t.TempDir()
	if err := os.WriteFile(filepath.Join(root, "child.vhdx"), []byte("disk"), 0600); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(coldBackupManifest{1, []coldBackupFile{{"child.vhdx", 4, evidenceHash([]byte("disk"))}}})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(root, "manifest.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	return root, evidenceHash(data)
}

func TestColdVerificationHoldsBytesUntilClosed(t *testing.T) {
	root, pin := coldVerificationFixture(t)
	backup, err := verifyColdBackup(root, pin, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer backup.close()
	if err = os.WriteFile(filepath.Join(root, "child.vhdx"), []byte("edit"), 0600); err == nil {
		t.Fatal("changed verified bytes while held")
	}
	if err = os.Rename(filepath.Join(root, "manifest.json"), filepath.Join(root, "moved.json")); err == nil {
		t.Fatal("replaced held manifest")
	}
	backup.close()
	if err = os.WriteFile(filepath.Join(root, "child.vhdx"), []byte("edit"), 0600); err != nil {
		t.Fatal("handles leaked", err)
	}
}

func TestColdVerificationRejectsChangedOrIncompleteBackup(t *testing.T) {
	for _, scenario := range []string{"hash", "size", "missing", "extra-file", "extra-dir", "manifest", "pin", "ownership"} {
		t.Run(scenario, func(t *testing.T) {
			root, pin := coldVerificationFixture(t)
			var err error
			assertHeld := func() error { return nil }
			switch scenario {
			case "hash":
				err = os.WriteFile(filepath.Join(root, "child.vhdx"), []byte("edit"), 0600)
			case "size":
				err = os.WriteFile(filepath.Join(root, "child.vhdx"), []byte("truncated"), 0600)
			case "missing":
				err = os.Remove(filepath.Join(root, "child.vhdx"))
			case "extra-file":
				err = os.WriteFile(filepath.Join(root, "unexpected"), nil, 0600)
			case "extra-dir":
				err = os.Mkdir(filepath.Join(root, "unexpected"), 0700)
			case "manifest":
				err = os.WriteFile(filepath.Join(root, "manifest.json"), []byte("{}"), 0600)
			case "pin":
				pin = evidenceHash([]byte("other"))
			case "ownership":
				assertHeld = func() error { return errors.New("lost lock") }
			}
			if err != nil {
				t.Fatal(err)
			}
			backup, err := verifyColdBackup(root, pin, assertHeld)
			if backup != nil {
				backup.close()
				t.Fatal("returned rejected backup")
			}
			if err == nil {
				t.Fatal("accepted changed backup")
			}
		})
	}
}
