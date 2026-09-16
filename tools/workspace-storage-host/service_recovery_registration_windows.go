//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type serviceRecoveryRegistration struct {
	TransactionSHA256 string `json:"transactionSha256"`
	ContextSHA256     string `json:"contextSha256"`
	Executable        string `json:"executable"`
	ExecutableSHA256  string `json:"executableSha256"`
}

func (r serviceRecoveryRegistration) name() string {
	return "HoneyBeeStorageRecovery-" + r.TransactionSHA256
}
func (r serviceRecoveryRegistration) arguments() []string {
	return []string{"service-recovery-run", "--transaction", r.TransactionSHA256, "--context-sha256", r.ContextSHA256}
}
func (r serviceRecoveryRegistration) command() string {
	return windows.ComposeCommandLine(append([]string{r.Executable}, r.arguments()...))
}
func (r serviceRecoveryRegistration) validate(areaPath string) error {
	if !migrationDigest(r.TransactionSHA256) || !migrationDigest(r.ContextSHA256) || !migrationDigest(r.ExecutableSHA256) {
		return errors.New("pinned boot recovery identity required")
	}
	if !filepath.IsAbs(r.Executable) || filepath.Clean(r.Executable) != r.Executable || filepath.Base(r.Executable) != "host.exe" || filepath.Dir(filepath.Dir(r.Executable)) != areaPath || !strings.HasPrefix(filepath.Base(filepath.Dir(r.Executable)), "candidate-"+r.TransactionSHA256+"-") {
		return errors.New("boot worker must be the protected admitted candidate")
	}
	return nil
}

func recoveryServiceConfigMatches(config mgr.Config, registration serviceRecoveryRegistration) bool {
	return config.BinaryPathName == registration.command() && config.StartType == mgr.StartAutomatic && config.ServiceType == windows.SERVICE_WIN32_OWN_PROCESS && config.ServiceStartName == "LocalSystem" && config.Password == "" && len(config.Dependencies) == 0 && config.LoadOrderGroup == "" && !config.DelayedAutoStart && config.ErrorControl == mgr.ErrorNormal
}

type recoveryServiceControl interface {
	Config() (mgr.Config, error)
	Query() (svc.Status, error)
	Start(...string) error
}

// Registration is not ready merely because CreateService returned successfully.
// The handler must reach Running, retain the same executable identity, and keep
// the exact registered boot policy before the caller may Pause the source.
func awaitRecoveryService(ctx context.Context, service recoveryServiceControl, registration serviceRecoveryRegistration, check func() error, verifyProcess func(uint32) error) error {
	if service == nil || check == nil || verifyProcess == nil {
		return errors.New("complete recovery readiness proof required")
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := check(); err != nil {
		return err
	}
	config, err := service.Config()
	if err != nil {
		return err
	}
	if !recoveryServiceConfigMatches(config, registration) {
		return errors.New("conflicting boot recovery registration")
	}
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Stopped {
		if err = service.Start(); err != nil {
			return err
		}
	} else if status.State != svc.StartPending && status.State != svc.Running {
		return errors.New("boot recovery service is not startable")
	}
	ticker := time.NewTicker(100 * time.Millisecond)
	defer ticker.Stop()
	for {
		if err = ctx.Err(); err != nil {
			return err
		}
		if err = check(); err != nil {
			return err
		}
		config, err = service.Config()
		if err != nil {
			return err
		}
		if !recoveryServiceConfigMatches(config, registration) {
			return errors.New("boot recovery registration changed")
		}
		status, err = service.Query()
		if err != nil {
			return err
		}
		if status.State == svc.Running && status.ProcessId != 0 {
			if err = verifyProcess(status.ProcessId); err != nil {
				return err
			}
			after, err := service.Query()
			if err != nil {
				return err
			}
			if after.State != svc.Running || after.ProcessId != status.ProcessId {
				return errors.New("boot recovery process changed")
			}
			return check()
		}
		if status.State != svc.StartPending {
			return errors.New("boot recovery stopped before becoming ready")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
		}
	}
}

// Only call after the immutable worker context has been published and the
// candidate's bytes/signature have been verified under held private handles.
// It never changes an existing mismatched service, even on a retry.
func registerNativeRecoveryService(ctx context.Context, area *maintenanceArea, registration serviceRecoveryRegistration, assertWorker func() error) error {
	return registerRecoveryService(ctx, area, registration, assertWorker, false)
}

// Rearming is only for an existing authenticated protected context. Ordinary
// first registration continues to refuse any mismatched existing service.
func rearmNativeRecoveryService(ctx context.Context, area *maintenanceArea, registration serviceRecoveryRegistration, assertWorker func() error) error {
	return registerRecoveryService(ctx, area, registration, assertWorker, true)
}

func admitRetiredRecoveryRegistration(config mgr.Config, status svc.Status, registration serviceRecoveryRegistration) error {
	if config.StartType != mgr.StartDisabled || status.State != svc.Stopped || status.ProcessId != 0 {
		return errors.New("only a stopped retired recovery service can be rearmed")
	}
	config.StartType = mgr.StartAutomatic
	if !recoveryServiceConfigMatches(config, registration) {
		return errors.New("retired recovery registration belongs to another context")
	}
	return nil
}

func registerRecoveryService(ctx context.Context, area *maintenanceArea, registration serviceRecoveryRegistration, assertWorker func() error, allowRetired bool) error {
	if area == nil || assertWorker == nil {
		return errors.New("protected boot worker required")
	}
	if err := registration.validate(area.Path); err != nil {
		return err
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertWorker()
	}
	if err := check(); err != nil {
		return err
	}
	handle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT|windows.SC_MANAGER_CREATE_SERVICE)
	if err != nil {
		return err
	}
	manager := &mgr.Mgr{Handle: handle}
	defer manager.Disconnect()
	service, err := manager.OpenService(registration.name())
	if errors.Is(err, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		service, err = manager.CreateService(registration.name(), registration.Executable, mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: mgr.StartAutomatic, ErrorControl: mgr.ErrorNormal, ServiceStartName: "LocalSystem", DisplayName: "HoneyBee Storage Recovery"}, registration.arguments()...)
		if err != nil {
			return err
		}
		// A partial registration is retained and can only be retried by the same
		// immutable context. No source-service control has occurred at this point.
	} else if err != nil {
		return err
	}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return err
	}
	if !recoveryServiceConfigMatches(config, registration) {
		if !allowRetired {
			return errors.New("existing recovery service belongs to another context")
		}
		status, err := service.Query()
		if err != nil {
			return err
		}
		if err = admitRetiredRecoveryRegistration(config, status, registration); err != nil {
			return err
		}
		if err = check(); err != nil {
			return err
		}
		if err = (nativeMaintenanceService{service}).setStartType(mgr.StartAutomatic); err != nil {
			return err
		}
	}
	// Explicitly deny ordinary users mutation of the privileged worker service.
	sd, err := windows.SecurityDescriptorFromString("O:BAG:BAD:P(A;;GA;;;SY)(A;;GA;;;BA)")
	if err != nil {
		return err
	}
	dacl, _, err := sd.DACL()
	if err != nil {
		return err
	}
	if err = windows.SetSecurityInfo(service.Handle, windows.SE_SERVICE, windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION, nil, nil, dacl, nil); err != nil {
		return err
	}
	actions := []mgr.RecoveryAction{{Type: mgr.ServiceRestart, Delay: 5 * time.Second}, {Type: mgr.ServiceRestart, Delay: 30 * time.Second}, {Type: mgr.NoAction}}
	if err = service.SetRecoveryActions(actions, 3600); err != nil {
		return err
	}
	if err = service.SetRecoveryActionsOnNonCrashFailures(true); err != nil {
		return err
	}
	return awaitRecoveryService(ctx, service, registration, check, func(pid uint32) error {
		_, closeProcess, err := holdMaintenanceProcess(registration.Executable, pid)
		if err != nil {
			return err
		}
		defer closeProcess()
		return check()
	})
}
