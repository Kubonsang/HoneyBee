//go:build windows

package main

import (
	"context"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestMaintenanceBindingRejectsDifferentMachineIdentity(t *testing.T) {
	store := `C:\ProgramData\UnityWorkspaceStorage`
	sid := "S-1-5-21-1-2-3-1001"
	original := mgr.Config{BinaryPathName: `C:\ProgramData\UnityWorkspaceStorage\broker\unity-workspace-storage-host.exe broker-run`, ServiceStartName: "LocalSystem", StartType: mgr.StartAutomatic, ServiceType: windows.SERVICE_WIN32_OWN_PROCESS}
	evidence := serviceEvidence{SchemaVersion: 1, Receipt: installReceipt{ServiceName: workspace.WindowsServiceName, StoreRoot: store, UserSID: sid}, SCM: serviceIdentity{Command: original.BinaryPathName, Account: original.ServiceStartName, StartType: original.StartType, ServiceType: original.ServiceType, State: "running"}}
	if err := validateMaintenanceBinding(store, sid, evidence, original); err != nil {
		t.Fatal(err)
	}
	for _, mutation := range []string{"user", "store", "name", "command", "account", "state", "recovery"} {
		t.Run(mutation, func(t *testing.T) {
			changed := evidence
			switch mutation {
			case "user":
				changed.Receipt.UserSID = "S-1-5-18"
			case "store":
				changed.Receipt.StoreRoot = `C:\Users\user\service`
			case "name":
				changed.Receipt.ServiceName = "AnotherService"
			case "command":
				changed.SCM.Command = `C:\unknown.exe`
			case "account":
				changed.SCM.Account = "user"
			case "state":
				changed.SCM.State = "stopped"
			case "recovery":
				changed.RecoveryReady = true
			}
			if err := validateMaintenanceBinding(store, sid, changed, original); err == nil {
				t.Fatal("mismatched admission accepted")
			}
		})
	}
}

func TestMaintenanceBindingCannotOperateWithoutProtectedOwnership(t *testing.T) {
	if _, err := openBoundMaintenanceService(nil, "", serviceEvidence{}, "", nil); err == nil {
		t.Fatal("unprotected SCM open")
	}
	b := &boundMaintenanceService{}
	b.close()
	b.close()
	if err := b.stop(context.Background()); err == nil {
		t.Fatal("released stop")
	}
	if err := b.resume(context.Background()); err == nil {
		t.Fatal("released resume")
	}
}
