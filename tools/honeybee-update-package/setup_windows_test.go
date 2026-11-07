//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestSetupReadLeasePreventsReplacementAndWrite(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "HoneyBeeSetup.exe")
	if err := os.WriteFile(file, []byte("fixture; never executed"), 0600); err != nil {
		t.Fatal(err)
	}
	lease, err := openSetupReadLease(file)
	if err != nil {
		t.Fatal(err)
	}
	defer lease.Close()
	if err := os.WriteFile(file, []byte("changed"), 0600); err == nil {
		t.Fatal("write succeeded under Setup read lease")
	}
	if err := os.Rename(file, filepath.Join(root, "moved.exe")); err == nil {
		t.Fatal("rename succeeded under Setup read lease")
	}
	if err := os.Remove(file); err == nil {
		t.Fatal("delete succeeded under Setup read lease")
	}
}

func TestSetupChangedDigestNeverExecutes(t *testing.T) {
	root := t.TempDir()
	file := filepath.Join(root, "HoneyBeeSetup.exe")
	if err := os.WriteFile(file, []byte("fixture"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := runVerifiedSetup(file, "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa", "7", root, "repair"); err == nil {
		t.Fatal("unverified Setup accepted")
	}
}
