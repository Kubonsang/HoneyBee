package main

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func recoveryFixture(t *testing.T, root string, node, script []byte) {
	t.Helper()
	files := map[string][]byte{"runtime/node.exe": node, "scripts/recovery/startup.mjs": script,
		"approved-source.json": []byte("{}"), "output/update-tools/honeybee-update-package.exe": []byte("fixture helper")}
	manifest := recoveryInventory{1, map[string]string{}}
	for name, bytes := range files {
		write(t, filepath.Join(root, "recovery", "v1", filepath.FromSlash(name)), bytes)
		manifest.Files[name] = digest(bytes)
	}
	data, _ := json.Marshal(manifest)
	write(t, filepath.Join(root, "recovery", "v1", "manifest.json"), data)
	prior := recoveryManifestSHA256
	recoveryManifestSHA256 = digest(data)
	t.Cleanup(func() { recoveryManifestSHA256 = prior })
}
func TestRecoveryRuntimeRejectsTamperingAndMissingPin(t *testing.T) {
	root, _ := journalFixture(t, "Switching")
	recoveryFixture(t, root, []byte("node"), []byte("script"))
	if _, _, err := recoveryCommand(root, "activation-QA1234"); err != nil {
		t.Fatal(err)
	}
	file := filepath.Join(root, "recovery", "v1", "scripts", "recovery", "startup.mjs")
	write(t, file, []byte("changed"))
	if _, _, err := recoveryCommand(root, "activation-QA1234"); err == nil {
		t.Fatal("modified executable accepted")
	}
	recoveryManifestSHA256 = ""
	if _, err := resolveWithRecovery(filepath.Join(root, "HoneyBeeLauncher.exe"), nil); err == nil {
		t.Fatal("missing approval allowed recovery")
	}
}
func TestSuccessfulHandoffRevalidatesAndPreservesArguments(t *testing.T) {
	node, err := os.ReadFile(filepath.Join("..", "..", "output", "node-runtime", "node.exe"))
	if err != nil {
		t.Skip("private Node runtime required")
	}
	root, _ := journalFixture(t, "Switching", "Switched")
	script := []byte(`import fs from 'node:fs'; import path from 'node:path'; import crypto from 'node:crypto';
const [root,name]=process.argv.slice(2); const dir=path.join(root,'update/activations',name);
const intentSha256=crypto.createHash('sha256').update(fs.readFileSync(path.join(dir,'intent.json'))).digest('hex');
for(const state of ['RollingBack','RolledBack'])fs.writeFileSync(path.join(dir,state+'.state.json'),JSON.stringify({schemaVersion:1,state,intentSha256}));
fs.writeFileSync(path.join(root,'current.json'),fs.readFileSync(path.join(dir,'source.json')));`)
	recoveryFixture(t, root, node, script)
	plan, err := resolveWithRecovery(filepath.Join(root, "HoneyBeeLauncher.exe"), []string{"--example", "a b"})
	if err != nil {
		t.Fatal(err)
	}
	if filepath.Base(filepath.Dir(filepath.Dir(plan.Executable))) != "0.1.0-beta.12" || len(plan.Arguments) != 2 || plan.Arguments[1] != "a b" {
		t.Fatalf("wrong recovered plan: %#v", plan)
	}
}
func TestZeroExitWithoutRecoveryDoesNotLaunch(t *testing.T) {
	node, err := os.ReadFile(filepath.Join("..", "..", "output", "node-runtime", "node.exe"))
	if err != nil {
		t.Skip("private Node runtime required")
	}
	root, _ := journalFixture(t, "Switching")
	recoveryFixture(t, root, node, []byte("process.exit(0);"))
	if _, err := resolveWithRecovery(filepath.Join(root, "HoneyBeeLauncher.exe"), nil); err == nil {
		t.Fatal("zero exit bypassed journal validation")
	}
}
