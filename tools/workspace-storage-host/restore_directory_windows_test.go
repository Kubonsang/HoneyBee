//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestRestoreDirectoryPreservesAndReplaysHierarchy(t *testing.T) {
	root := t.TempDir()
	parent := filepath.Join(root, "obsolete")
	child := filepath.Join(parent, "child")
	if err := os.MkdirAll(child, 0700); err != nil {
		t.Fatal(err)
	}
	previousRoot := t.TempDir()
	_, storage := restoreIntentFixture(t)
	check := func() error { return nil }
	for i := 0; i < 2; i++ {
		for _, pair := range [][2]string{{child, filepath.Join(previousRoot, "child")}, {parent, filepath.Join(previousRoot, "parent")}} {
			if err := preserveRestoreDirectory("txn", pair[0], pair[1], storage, check); err != nil {
				t.Fatal(err)
			}
		}
	}
	if _, err := os.Stat(parent); !os.IsNotExist(err) {
		t.Fatal("obsolete parent remains", err)
	}
}

func TestRestoreDirectoryRefusesContentsAndMissingIntent(t *testing.T) {
	for _, scenario := range []string{"contents", "occupied", "unrecorded-replay", "intent-failure"} {
		t.Run(scenario, func(t *testing.T) {
			target := filepath.Join(t.TempDir(), "target")
			previous := filepath.Join(t.TempDir(), "previous")
			if err := os.Mkdir(target, 0700); err != nil {
				t.Fatal(err)
			}
			_, storage := restoreIntentFixture(t)
			switch scenario {
			case "contents":
				if err := os.WriteFile(filepath.Join(target, "user-data"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			case "occupied":
				if err := os.Mkdir(previous, 0700); err != nil {
					t.Fatal(err)
				}
			case "unrecorded-replay":
				if err := os.Rename(target, previous); err != nil {
					t.Fatal(err)
				}
			case "intent-failure":
				storage.publish = func(*os.File, string, string) error { return errors.New("disk full") }
			}
			if err := preserveRestoreDirectory("txn", target, previous, storage, func() error { return nil }); err == nil {
				t.Fatal("unsafe directory preservation accepted")
			}
			if scenario != "unrecorded-replay" {
				if _, err := os.Stat(target); err != nil {
					t.Fatal("directory lost on refusal", err)
				}
			}
		})
	}
}

func TestRestoreDirectoryInterruptedMoveAndIdentityRefusal(t *testing.T) {
	target := filepath.Join(t.TempDir(), "target")
	previous := filepath.Join(t.TempDir(), "previous")
	if err := os.Mkdir(target, 0700); err != nil {
		t.Fatal(err)
	}
	_, storage := restoreIntentFixture(t)
	interrupted := errors.New("interrupted after rename")
	err := preserveRestoreDirectory("txn", target, previous, storage, func() error {
		if _, err := os.Stat(previous); err == nil {
			return interrupted
		}
		return nil
	})
	if !errors.Is(err, interrupted) {
		t.Fatal("wrong interruption", err)
	}
	if err = preserveRestoreDirectory("txn", target, previous, storage, func() error { return nil }); err != nil {
		t.Fatal(err)
	}
	// Retain the real directory and substitute another empty one. Path and
	// emptiness are insufficient; replay must match the recorded native identity.
	if err = os.Rename(previous, previous+"-retained"); err != nil {
		t.Fatal(err)
	}
	if err = os.Mkdir(previous, 0700); err != nil {
		t.Fatal(err)
	}
	if err = preserveRestoreDirectory("txn", target, previous, storage, func() error { return nil }); err == nil {
		t.Fatal("substituted directory accepted")
	}
}

func TestRestoreDirectoryPublicationReplaysPopulatedTarget(t *testing.T) {
	candidate := filepath.Join(t.TempDir(), "candidate")
	target := filepath.Join(t.TempDir(), "target")
	if err := os.Mkdir(candidate, 0700); err != nil {
		t.Fatal(err)
	}
	_, storage := restoreIntentFixture(t)
	check := func() error { return nil }
	if err := publishRestoreDirectory("txn", candidate, target, storage, check); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(target, "restored"), []byte("keep"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := publishRestoreDirectory("txn", candidate, target, storage, check); err != nil {
		t.Fatal(err)
	}
	if err := preserveRestoreDirectory("txn", candidate, target, storage, check); err == nil {
		t.Fatal("publication intent reused for preservation")
	}
	data, err := os.ReadFile(filepath.Join(target, "restored"))
	if err != nil || string(data) != "keep" {
		t.Fatal("published contents changed", err)
	}
}
