package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func journalFixture(t *testing.T, states ...string) (string, string) {
	t.Helper()
	root := t.TempDir()
	source := addVersion(t, root, "0.1.0-beta.12", []byte("node"))
	target := addVersion(t, root, "0.1.0-beta.13", []byte("node"))
	target.Generation = 2
	activate(t, root, target)
	dir := filepath.Join(root, "update", "activations", "activation-QA1234")
	a, _ := json.Marshal(source)
	b, _ := json.Marshal(target)
	intent, _ := json.Marshal(activationIntent{1, "app-pointer-v1", digest(a), digest(b)})
	write(t, filepath.Join(dir, "source.json"), a)
	write(t, filepath.Join(dir, "target.json"), b)
	write(t, filepath.Join(dir, "intent.json"), intent)
	for _, state := range states {
		data, _ := json.Marshal(activationState{1, state, digest(intent)})
		write(t, filepath.Join(dir, state+".state.json"), data)
	}
	return root, dir
}

func TestLaunchRejectsInterruptedOrConflictingHistory(t *testing.T) {
	for _, states := range [][]string{nil, {"Switching"}, {"Switching", "Switched"}, {"RollingBack"}, {"Committed"}, {"Switching", "Switched", "Committed", "RollingBack", "RolledBack"}} {
		t.Run("history", func(t *testing.T) {
			root, _ := journalFixture(t, states...)
			before, _ := os.ReadFile(filepath.Join(root, "current.json"))
			for _, name := range []string{"HoneyBeeLauncher.exe", filepath.Join("bin", "honeybee.exe")} {
				if _, err := resolveLaunch(filepath.Join(root, name), nil); err == nil {
					t.Fatal("interrupted launch allowed")
				}
			}
			after, _ := os.ReadFile(filepath.Join(root, "current.json"))
			if string(before) != string(after) {
				t.Fatal("launch guard changed pointer")
			}
		})
	}
}
func TestLaunchAcceptsValidatedTerminalHistories(t *testing.T) {
	for _, states := range [][]string{{"Switching", "Switched", "Committed"}, {"Switching", "RollingBack", "RolledBack"}} {
		root, dir := journalFixture(t, states...)
		if states[len(states)-1] == "RolledBack" {
			data, _ := os.ReadFile(filepath.Join(dir, "source.json"))
			write(t, filepath.Join(root, "current.json"), data)
		}
		if err := requireCompletedActivations(root); err != nil {
			t.Fatal(err)
		}
	}
}
func TestRolledBackTargetCannotLaunch(t *testing.T) {
	root, _ := journalFixture(t, "Switching", "RollingBack", "RolledBack")
	if err := requireCompletedActivations(root); err == nil {
		t.Fatal("rolled-back target accepted")
	}
}
func TestJournalVersionOrdering(t *testing.T) {
	for _, pair := range [][2]string{{"0.1.0-beta.12", "0.1.0-beta.13"}, {"0.1.0-beta.13", "0.1.0"}} {
		if !newerJournalVersion(pair[0], pair[1]) || newerJournalVersion(pair[1], pair[0]) {
			t.Fatal("invalid version ordering")
		}
	}
	if newerJournalVersion("0.1.0", "0.1.0") || newerJournalVersion("0.1.0", "0.2.0-unsupported") {
		t.Fatal("unsupported transition accepted")
	}
}
func TestLaunchRejectsTamperedTerminalBinding(t *testing.T) {
	root, dir := journalFixture(t, "Switching", "Switched", "Committed")
	for _, name := range []string{"Committed.state.json", "source.json", "intent.json"} {
		file := filepath.Join(dir, name)
		original, _ := os.ReadFile(file)
		write(t, file, []byte("{}"))
		if err := requireCompletedActivations(root); err == nil {
			t.Fatal("tampered record accepted")
		}
		write(t, file, original)
	}
}
func TestIncompleteDirectoryAndUnknownEntryBlockLaunch(t *testing.T) {
	root := t.TempDir()
	dir := filepath.Join(root, "update", "activations", "activation-QA1234")
	if err := os.MkdirAll(dir, 0700); err != nil {
		t.Fatal(err)
	}
	if err := requireCompletedActivations(root); err == nil {
		t.Fatal("incomplete journal accepted")
	}
	root = t.TempDir()
	write(t, filepath.Join(root, "update", "activations", "unexpected"), []byte("x"))
	if err := requireCompletedActivations(root); err == nil {
		t.Fatal("unknown entry accepted")
	}
}
func TestRedirectedUpdateDirectoryBlocksLaunch(t *testing.T) {
	root := t.TempDir()
	other := t.TempDir()
	if err := os.Symlink(other, filepath.Join(root, "update")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}
	if err := requireCompletedActivations(root); err == nil {
		t.Fatal("redirected directory accepted")
	}
}
