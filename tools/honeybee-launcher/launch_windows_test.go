package main

import (
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

func TestRejectIntermediateJunction(t *testing.T) {
	root := t.TempDir()
	current := addVersion(t, root, "0.1.0", []byte("node"))
	activate(t, root, current)
	versions := filepath.Join(root, "versions")
	out := filepath.Join(root, "payloads")
	if err := os.Rename(versions, out); err != nil {
		t.Fatal(err)
	}
	// Generated fixture paths only. No user-provided shell arguments.
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", versions, out).CombinedOutput(); err != nil {
		t.Fatalf("junction fixture: %v: %s", err, output)
	}
	if _, err := resolveLaunch(filepath.Join(root, "bin", "honeybee.exe"), nil); err == nil {
		t.Fatal("junction was accepted")
	}
}
