package main

import (
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func TestCombinedHistoryContinuesAppOnlyGeneration(t *testing.T) {
	root := t.TempDir()
	pin := strings.Repeat("a", 64)
	source := activation{1, 4, "0.1.0-beta.12", pin}
	target := activation{1, 5, "0.1.0-beta.13", pin}
	sourceBytes, _ := json.Marshal(source)
	targetBytes, _ := json.Marshal(target)
	identity := []byte(fmt.Sprintf(`{"manifestSha256":"%s","sourcePointerSha256":"%s","serviceTransactionSha256":"%s"}`, pin, metadataDigest(sourceBytes), pin))
	id := metadataDigest(identity)
	directory := filepath.Join(root, "update", "combined", id)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	previous := id
	for index, state := range []string{"Prepared", "ServiceReady", "AppSelected", "DesktopReady", "Committing", "Committed"} {
		data, _ := json.Marshal(map[string]any{"schemaVersion": 1, "identitySha256": id, "previousSha256": previous, "state": state})
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("%02d.json", index+1)), data, 0600); err != nil {
			t.Fatal(err)
		}
		previous = metadataDigest(data)
	}
	parent := filepath.Join(root, "update", "combined-contexts")
	if err := os.MkdirAll(parent, 0700); err != nil {
		t.Fatal(err)
	}
	value := map[string]any{"schemaVersion": 1, "identity": json.RawMessage(identity), "identitySha256": id, "sourcePointer": base64.StdEncoding.EncodeToString(sourceBytes), "targetPointer": base64.StdEncoding.EncodeToString(targetBytes), "launcherSha256": pin}
	data, _ := json.Marshal(value)
	file := filepath.Join(parent, id+".json")
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if err := requireCompletedCombinedUpdates(root, false, nil); err != nil {
		t.Fatal(err)
	}
	if ok, err := combinedHistoryContinues(root, source, target); err != nil || !ok {
		t.Fatal("paired update did not continue app-only history", ok, err)
	}
	unrelated := source
	unrelated.ManifestSHA256 = strings.Repeat("b", 64)
	if ok, err := combinedHistoryContinues(root, unrelated, target); err != nil || ok {
		t.Fatal("unrelated history accepted", ok, err)
	}
	value["sourcePointer"] = base64.StdEncoding.EncodeToString([]byte(`{}`))
	data, _ = json.Marshal(value)
	if err := os.WriteFile(file, data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := combinedHistoryContinues(root, source, target); err == nil {
		t.Fatal("changed source context accepted")
	}
}

func TestCombinedLaunchAdmission(t *testing.T) {
	root := t.TempDir()
	id := strings.Repeat("a", 64)
	arg := []string{"--honeybee-update-validation=" + id}
	if err := requireCompletedCombinedUpdates(root, false, nil); err != nil {
		t.Fatal(err)
	}
	if err := requireCompletedCombinedUpdates(root, false, arg); err == nil {
		t.Fatal("unbound validation accepted")
	}
	directory := filepath.Join(root, "update", "combined", id)
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	previous := id
	for index, state := range []string{"Prepared", "ServiceReady", "AppSelected", "DesktopReady", "Committing", "Committed"} {
		data, err := json.Marshal(map[string]any{"schemaVersion": 1, "identitySha256": id, "previousSha256": previous, "state": state})
		if err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(directory, fmt.Sprintf("%02d.json", index+1)), data, 0600); err != nil {
			t.Fatal(err)
		}
		previous = metadataDigest(data)
		ordinary := requireCompletedCombinedUpdates(root, false, nil)
		if (ordinary == nil) != (state == "Committed") {
			t.Fatalf("ordinary at %s: %v", state, ordinary)
		}
		validation := requireCompletedCombinedUpdates(root, false, arg)
		allowed := state == "AppSelected" || state == "DesktopReady" || state == "Committing"
		if (validation == nil) != allowed {
			t.Fatalf("validation at %s: %v", state, validation)
		}
		if err := requireCompletedCombinedUpdates(root, true, arg); err == nil {
			t.Fatal("CLI validation bypass")
		}
	}
	if err := os.WriteFile(filepath.Join(directory, "02.json"), []byte(`{}`), 0600); err != nil {
		t.Fatal(err)
	}
	if err := requireCompletedCombinedUpdates(root, false, nil); err == nil {
		t.Fatal("corrupt history accepted")
	}
}
