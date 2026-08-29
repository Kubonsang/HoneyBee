//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
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
