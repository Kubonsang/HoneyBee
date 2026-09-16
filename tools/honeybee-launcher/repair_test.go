package main

import (
	"encoding/json"
	"errors"
	"path/filepath"
	"testing"
)

func TestApplicationRepairLaunchGate(t *testing.T) {
	root := t.TempDir()
	if err := requireCompletedApplicationRepairs(root); err != nil {
		t.Fatal(err)
	}
	intent, _ := json.Marshal(map[string]any{"schemaVersion": 1, "version": "0.1.0-beta.12", "sourcePointerSha256": digest([]byte("pointer"))})
	directory := filepath.Join(root, "update", "app-repairs", "repair-ABC123")
	write(t, filepath.Join(directory, "intent.json"), intent)
	var pending *pendingApplicationRepair
	if err := requireCompletedApplicationRepairs(root); !errors.As(err, &pending) {
		t.Fatalf("missing recovery gate: %v", err)
	}
	complete, _ := json.Marshal(map[string]any{"schemaVersion": 1, "intentSha256": digest(intent)})
	write(t, filepath.Join(directory, "complete.json"), complete)
	if err := requireCompletedApplicationRepairs(root); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(directory, "complete.json"), []byte(`{}`))
	if err := requireCompletedApplicationRepairs(root); err == nil {
		t.Fatal("invalid completion admitted")
	}
}
