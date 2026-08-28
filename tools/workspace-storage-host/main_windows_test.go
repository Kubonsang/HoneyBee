//go:build windows

package main

import (
	"errors"
	"os"
	"os/exec"
	"path/filepath"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

func TestServiceWithoutReceiptFailsClosedAsTypedConflict(t *testing.T) {
	err := serviceWithoutReceiptError()
	var typed hostError
	if !errors.As(err, &typed) {
		t.Fatal("service collision did not return a typed host error")
	}
	if typed.code != "workspace-storage.service-conflict" || typed.exitCode != serviceConflictExitCode {
		t.Fatalf("unexpected typed conflict: %#v", typed)
	}
}

func TestMachineReceiptRequiresNeutralServiceIdentity(t *testing.T) {
	root := t.TempDir()
	receiptPath := filepath.Join(root, "receipt.json")
	receipt := installReceipt{
		SchemaVersion:    receiptSchema,
		ServiceName:      "TestPlayStorageBroker",
		PipeName:         `\\.\pipe\testplay-storage-broker-v2`,
		ComponentVersion: "1.0.0",
		StoreRoot:        root,
		WorkspaceRoot:    filepath.Join(root, "workspaces"),
		ConfigPath:       filepath.Join(root, "broker.json"),
		UserSID:          "S-1-5-21-1",
		Executable:       filepath.Join(root, "broker.exe"),
		ExecutableSHA256: string(make([]byte, 64)),
	}
	if err := writeExclusiveJSON(receiptPath, receipt); err != nil {
		t.Fatal(err)
	}
	if _, err := loadReceipt(receiptPath); err == nil {
		t.Fatal("legacy TestPlay service identity was accepted")
	}
	if workspace.WindowsServiceName != "UnityWorkspaceStorage" ||
		workspace.DefaultPipeName != `\\.\pipe\unity-workspace-storage-v2` {
		t.Fatal("host was not built against the neutral upstream identity")
	}
	_ = os.Remove(receiptPath)
}

func TestReceiptVersionSwitchPublishesAndRecoversAtomically(t *testing.T) {
	root := t.TempDir()
	target := filepath.Join(root, "install-receipt.json")
	base := installReceipt{
		SchemaVersion:    receiptSchema,
		ServiceName:      workspace.WindowsServiceName,
		PipeName:         workspace.DefaultPipeName,
		ComponentVersion: "1.0.0",
		StoreRoot:        root,
		WorkspaceRoot:    filepath.Join(root, "workspaces"),
		ConfigPath:       filepath.Join(root, "broker.json"),
		UserSID:          "S-1-5-21-1",
		Executable:       filepath.Join(root, "broker.exe"),
		ExecutableSHA256: "a" + string(make([]byte, 63)),
	}
	if err := writeExclusiveJSON(target, base); err != nil {
		t.Fatal(err)
	}
	next := base
	next.ComponentVersion = "1.1.0"
	next.ExecutableSHA256 = "b" + string(make([]byte, 63))
	if err := replaceReceiptFile(target, next); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadReceipt(target)
	if err != nil {
		t.Fatal(err)
	}
	if err := sameReceipt(loaded, next); err != nil {
		t.Fatal("new receipt was not published")
	}
	_, previous := receiptReplacementPaths(target)
	if err := os.Rename(target, previous); err != nil {
		t.Fatal(err)
	}
	if err := reconcileReceiptFile(target); err != nil {
		t.Fatal(err)
	}
	recovered, err := loadReceipt(target)
	if err != nil || sameReceipt(recovered, next) != nil {
		t.Fatal("interrupted receipt replacement was not recovered")
	}
}

func TestSecureDirectoryTreeRejectsIntermediateJunction(t *testing.T) {
	root := t.TempDir()
	target := t.TempDir()
	alias := filepath.Join(root, "alias")
	if output, err := exec.Command("cmd.exe", "/d", "/c", "mklink", "/J", alias, target).CombinedOutput(); err != nil {
		t.Skipf("junction creation is unavailable: %v: %s", err, output)
	}
	guard, err := secureDirectoryTree(filepath.Join(alias, "child"))
	if guard != nil {
		guard.close()
	}
	if err == nil {
		t.Fatal("intermediate junction was accepted")
	}
	if _, statErr := os.Stat(filepath.Join(target, "child")); !os.IsNotExist(statErr) {
		t.Fatal("privileged directory creation followed the rejected junction")
	}
}

func TestSecureDirectoryTreeCreatesAndHoldsRealComponents(t *testing.T) {
	target := filepath.Join(t.TempDir(), "one", "two")
	guard, err := secureDirectoryTree(target)
	if err != nil {
		t.Fatal(err)
	}
	defer guard.close()
	if guard.final == 0 {
		t.Fatal("final directory handle was not retained")
	}
	info, err := os.Stat(target)
	if err != nil || !info.IsDir() {
		t.Fatal("real directory tree was not created")
	}
}

func TestRelativeDirectoryCreationUsesTheParentHandleNotTheDisplayPath(t *testing.T) {
	anchor := t.TempDir()
	decoy := t.TempDir()
	parent, err := openRealDirectory(anchor, false)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(parent)
	handle, err := openOrCreateRealChildDirectory(parent, "child", filepath.Join(decoy, "child"), true)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(handle)
	if _, err := os.Stat(filepath.Join(anchor, "child")); err != nil {
		t.Fatal("child was not created below the held parent handle")
	}
	if _, err := os.Stat(filepath.Join(decoy, "child")); !os.IsNotExist(err) {
		t.Fatal("display path was used for privileged directory creation")
	}
}
