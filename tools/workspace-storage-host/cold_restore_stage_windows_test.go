//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func restoreFixtureOutput(destination string) coldBackupOutput {
	return coldBackupOutput{
		createRoot: func() error { return os.Mkdir(destination, 0700) },
		prepareParent: func(name string) error {
			return os.MkdirAll(filepath.Dir(filepath.Join(destination, filepath.FromSlash(name))), 0700)
		},
		createFile: func(name string) (*os.File, error) {
			return os.OpenFile(filepath.Join(destination, filepath.FromSlash(name)), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
		},
	}
}

func TestColdRestoreStageRevalidatesCompletedCandidate(t *testing.T) {
	root, pin := coldVerificationFixture(t)
	check := func() error { return nil }
	backup, err := verifyColdBackup(root, pin, check)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.close()
	destination := filepath.Join(t.TempDir(), "restore")
	output := restoreFixtureOutput(destination)
	if got, err := stageColdRestoreTo(backup, destination, check, output); err != nil || got != pin {
		t.Fatal(got, err)
	}
	output.createRoot = func() error { t.Fatal("recreated complete candidate"); return nil }
	if got, err := stageColdRestoreTo(backup, destination, check, output); err != nil || got != pin {
		t.Fatal(got, err)
	}
	if err = os.WriteFile(filepath.Join(destination, "child.vhdx"), []byte("edit"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = stageColdRestoreTo(backup, destination, check, output); err == nil {
		t.Fatal("reused changed candidate")
	}
	if data, err := os.ReadFile(filepath.Join(root, "child.vhdx")); err != nil || string(data) != "disk" {
		t.Fatal("changed original backup", err)
	}
}

func TestColdRestoreInterruptedCopyPreservedAndFreshRetrySucceeds(t *testing.T) {
	root, pin := coldVerificationFixture(t)
	check := func() error { return nil }
	backup, err := verifyColdBackup(root, pin, check)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.close()
	attempts := t.TempDir()
	first := filepath.Join(attempts, "first")
	output := restoreFixtureOutput(first)
	create := output.createFile
	output.createFile = func(name string) (*os.File, error) {
		if name == "manifest.json" {
			return nil, errors.New("interrupted before completion")
		}
		return create(name)
	}
	if _, err = stageColdRestoreTo(backup, first, check, output); err == nil {
		t.Fatal("ignored interruption")
	}
	if _, err = stageColdRestoreTo(backup, first, check, restoreFixtureOutput(first)); err == nil {
		t.Fatal("overwrote partial attempt")
	}
	second := filepath.Join(attempts, "second")
	if _, err = stageColdRestoreTo(backup, second, check, restoreFixtureOutput(second)); err != nil {
		t.Fatal(err)
	}
	if data, err := os.ReadFile(filepath.Join(first, "child.vhdx")); err != nil || string(data) != "disk" {
		t.Fatal("lost partial evidence", err)
	}
	if _, err = os.Stat(filepath.Join(first, "manifest.json")); !os.IsNotExist(err) {
		t.Fatal("marked partial candidate complete")
	}
}

func TestColdRestoreRefusesSourceOverlapAndClosedBackup(t *testing.T) {
	root, pin := coldVerificationFixture(t)
	check := func() error { return nil }
	backup, err := verifyColdBackup(root, pin, check)
	if err != nil {
		t.Fatal(err)
	}
	defer backup.close()
	if _, err = stageColdRestoreTo(backup, root, check, restoreFixtureOutput(root)); err == nil {
		t.Fatal("accepted source overwrite")
	}
	backup.close()
	destination := filepath.Join(t.TempDir(), "restore")
	if _, err = stageColdRestoreTo(backup, destination, check, restoreFixtureOutput(destination)); err == nil {
		t.Fatal("used released backup")
	}
	if _, err = os.Stat(destination); !os.IsNotExist(err) {
		t.Fatal("wrote rejected candidate")
	}
}
