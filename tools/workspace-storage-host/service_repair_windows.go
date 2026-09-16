//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type serviceRepairRequest struct {
	ApplicationRoot  string `json:"applicationRoot"`
	ComponentVersion string `json:"componentVersion"`
	ExecutableSHA256 string `json:"executableSha256"`
}

// Repairing a stopped, byte-identical component is a retry of normal service
// startup, not a replacement/migration. Disabled services, mismatched packages
// and pending maintenance are refused; no receipt or startup policy is rewritten.
func repairInstalledServiceStartup(ctx context.Context, area *maintenanceArea, request serviceRepairRequest) (serviceUpdateResult, error) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	result := serviceUpdateResult{SchemaVersion: 1}
	if !filepath.IsAbs(request.ApplicationRoot) || filepath.Clean(request.ApplicationRoot) != request.ApplicationRoot || !nativeComponentID.MatchString(request.ComponentVersion) || !migrationDigest(request.ExecutableSHA256) {
		return result, errors.New("invalid service repair identity")
	}
	if err := assertNoOtherServiceUpdate(area, ""); err != nil {
		return result, err
	}
	store := filepath.Dir(area.Path)
	receiptPath := filepath.Join(store, "install-receipt.json")
	receipt, err := loadReceipt(receiptPath)
	if err != nil {
		return result, err
	}
	if receipt.WorkspaceRoot != filepath.Join(request.ApplicationRoot, "Workspaces") || receipt.ComponentVersion != request.ComponentVersion || receipt.ExecutableSHA256 != request.ExecutableSHA256 {
		return result, errors.New("Repair package differs from installed component")
	}
	manager, err := mgr.Connect()
	if err != nil {
		return result, err
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(workspace.WindowsServiceName)
	if err != nil {
		return result, err
	}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return result, err
	}
	if config.StartType != mgr.StartAutomatic || config.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS || config.ServiceStartName != "LocalSystem" {
		return result, errors.New("Repair will not override the service startup policy")
	}
	// This is static package/configuration evidence, not a claim about live state.
	// Running is established separately by Query and the native startup wait below.
	identity := serviceIdentity{Command: config.BinaryPathName, Account: config.ServiceStartName, StartType: config.StartType, ServiceType: config.ServiceType, State: "running"}
	expected, err := inspectServiceEvidence(receiptPath, receipt.UserSID, identity)
	if err != nil {
		return result, err
	}
	held, err := holdMaintenanceSource(expected, area.assertHeld)
	if err != nil {
		return result, err
	}
	defer held.close()
	status, err := service.Query()
	if err != nil {
		return result, err
	}
	if status.State != svc.Stopped && status.State != svc.Running {
		return result, errors.New("service transition or maintenance is still active")
	}
	if status.State == svc.Stopped {
		if err = assertInstalledServiceProcessExited(receipt.Executable); err != nil {
			return result, err
		}
		if err = ctx.Err(); err != nil {
			return result, err
		}
		if err = area.assertHeld(); err != nil {
			return result, err
		}
		if err = service.Start(); err != nil && !errors.Is(err, windows.ERROR_SERVICE_ALREADY_RUNNING) {
			return result, err
		}
	}
	control := &maintenanceService{control: nativeMaintenanceService{service}, original: config, assertHeld: area.assertHeld, verifySourceFiles: held.verify, armRecovery: func(mgr.Config) error { return errors.New("Repair cannot initiate service replacement") }, holdProcess: func(pid uint32) (func(context.Context) error, func(), error) {
		return holdMaintenanceProcess(receipt.Executable, pid)
	}}
	if err = control.waitState(ctx, svc.Running); err != nil {
		return result, err
	}
	status, err = service.Query()
	if err != nil {
		return result, err
	}
	_, closeProcess, err := holdMaintenanceProcess(receipt.Executable, status.ProcessId)
	if err != nil {
		return result, err
	}
	defer closeProcess()
	if err = held.verify(); err != nil {
		return result, err
	}
	result.OK = true
	result.State = "Running"
	return result, nil
}
