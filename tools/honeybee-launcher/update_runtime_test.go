package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

func updateFixture(t *testing.T, root string, trust bool) {
	t.Helper()
	recoveryFixture(t, root, []byte("node"), []byte("startup"))
	manifestPath := filepath.Join(root, "recovery/v1/manifest.json")
	bytes, err := os.ReadFile(manifestPath)
	if err != nil {
		t.Fatal(err)
	}
	var inventory recoveryInventory
	if err := json.Unmarshal(bytes, &inventory); err != nil {
		t.Fatal(err)
	}
	files := map[string][]byte{"scripts/update/worker.mjs": []byte("worker")}
	if trust {
		files["update-trust.json"] = []byte("policy")
	}
	for name, data := range files {
		write(t, filepath.Join(root, "recovery/v1", name), data)
		inventory.Files[name] = digest(data)
	}
	bytes, _ = json.Marshal(inventory)
	write(t, manifestPath, bytes)
	recoveryManifestSHA256 = digest(bytes)
}

func TestUpdateCommandBindsFixedEntryAndArguments(t *testing.T) {
	root := t.TempDir()
	updateFixture(t, root, true)
	hash := digest([]byte("request"))
	executable, args, err := updateCommand(root, "job-ABC123", hash)
	if err != nil {
		t.Fatal(err)
	}
	expected := []string{filepath.Join(root, "recovery/v1/scripts/update/worker.mjs"), root, "job-ABC123", hash}
	if executable != filepath.Join(root, "recovery/v1/runtime/node.exe") || !reflect.DeepEqual(args, expected) {
		t.Fatalf("unexpected command: %s %#v", executable, args)
	}
	for _, name := range []string{"../job-ABC123", "job-a/b", "job-x --eval", "activation-ABC"} {
		if _, _, err := updateCommand(root, name, hash); err == nil {
			t.Fatalf("accepted %q", name)
		}
	}
	if _, _, err := updateCommand(root, "job-ABC123", "bad"); err == nil {
		t.Fatal("accepted invalid digest")
	}
}

func TestUpdateCommandRequiresPinnedTrustAndWorker(t *testing.T) {
	for _, changed := range []string{"scripts/update/worker.mjs", "update-trust.json"} {
		t.Run(changed, func(t *testing.T) {
			root := t.TempDir()
			updateFixture(t, root, true)
			write(t, filepath.Join(root, "recovery/v1", changed), []byte("tampered"))
			if _, _, err := updateCommand(root, "job-ABC", digest([]byte("request"))); err == nil {
				t.Fatal("accepted changed payload")
			}
		})
	}
	root := t.TempDir()
	updateFixture(t, root, false)
	if _, _, err := updateCommand(root, "job-ABC", digest([]byte("request"))); err == nil {
		t.Fatal("accepted unpinned trust")
	}
}

func TestUpdateJobRefusesPendingRecoveryAndCLI(t *testing.T) {
	root, _ := journalFixture(t, "Switching")
	updateFixture(t, root, true)
	args := []string{"--update-job", "job-ABC", digest([]byte("request"))}
	for _, executable := range []string{filepath.Join(root, "HoneyBeeLauncher.exe"), filepath.Join(root, "bin/honeybee.exe")} {
		if err := runUpdateJob(executable, args); err == nil {
			t.Fatal("accepted unsafe handoff")
		}
	}
	if err := runUpdateJob(filepath.Join(root, "HoneyBeeLauncher.exe"), args[:2]); err == nil {
		t.Fatal("accepted incomplete arguments")
	}
}
