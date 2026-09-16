//go:build windows

package main

import (
	"context"
	"errors"
	"path/filepath"
	"reflect"
	"strings"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// The privileged admission factory must open only the fixed service, verify its
// receipt/package identity and bind this snapshot to its protected transaction.
// No command-line entry currently constructs this adapter.
type maintenanceServiceControl interface {
	Config() (mgr.Config, error)
	Query() (svc.Status, error)
	Control(svc.Cmd) (svc.Status, error)
	Start(...string) error
	setStartType(uint32) error
}

type nativeMaintenanceService struct{ *mgr.Service }

func holdMaintenanceProcess(executable string, pid uint32) (func(context.Context) error, func(), error) {
	if pid == 0 || !filepath.IsAbs(executable) {
		return nil, nil, errors.New("source process identity required")
	}
	handle, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, pid)
	if err != nil {
		return nil, nil, err
	}
	closeProcess := func() {
		if handle != 0 {
			_ = windows.CloseHandle(handle)
			handle = 0
		}
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(handle, 0, &buffer[0], &size); err != nil {
		closeProcess()
		return nil, nil, err
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(executable)) {
		closeProcess()
		return nil, nil, errors.New("source service process image changed")
	}
	wait := func(ctx context.Context) error {
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			if err := ctx.Err(); err != nil {
				return err
			}
			if handle == 0 {
				return errors.New("source process handle released")
			}
			state, err := windows.WaitForSingleObject(handle, 0)
			if err != nil {
				return err
			}
			if state == windows.WAIT_OBJECT_0 {
				return nil
			}
			if state != uint32(windows.WAIT_TIMEOUT) {
				return errors.New("unexpected process wait result")
			}
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-ticker.C:
			}
		}
	}
	return wait, closeProcess, nil
}

func (s nativeMaintenanceService) setStartType(start uint32) error {
	// Change just startup policy. Do not replay a broad configuration update that
	// could alter account, dependencies, service SID or other recovery settings.
	return windows.ChangeServiceConfig(s.Handle, windows.SERVICE_NO_CHANGE, start, windows.SERVICE_NO_CHANGE, nil, nil, nil, nil, nil, nil, nil)
}

type maintenanceService struct {
	control           maintenanceServiceControl
	original          mgr.Config
	assertHeld        func() error
	verifySourceFiles func() error
	// Must persist the original configuration and idempotently arm/verify the
	// protected boot recovery entry before Pause, Stop and demand-start recovery.
	// A log message is not sufficient; retries must not overwrite another owner.
	armRecovery func(mgr.Config) error
	// Capture a process handle before stopping, validate its image identity, then
	// wait for that handle after SCM says Stopped. Never infer exit from PID reuse.
	holdProcess func(uint32) (wait func(context.Context) error, close func(), err error)
}

func maintenanceConfigMatches(current, original mgr.Config) bool {
	if current.StartType != original.StartType && current.StartType != mgr.StartDisabled && current.StartType != mgr.StartManual {
		return false
	}
	current.StartType = original.StartType
	return reflect.DeepEqual(current, original)
}

func (s *maintenanceService) check() error {
	if s.control == nil || s.assertHeld == nil || s.verifySourceFiles == nil || s.armRecovery == nil || s.holdProcess == nil {
		return errors.New("complete service maintenance authorities required")
	}
	if s.original.StartType != mgr.StartAutomatic || s.original.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS || s.original.ServiceStartName != "LocalSystem" || s.original.Password != "" {
		return errors.New("unsupported source service configuration")
	}
	if err := s.assertHeld(); err != nil {
		return err
	}
	current, err := s.control.Config()
	if err != nil {
		return err
	}
	if !maintenanceConfigMatches(current, s.original) {
		return errors.New("service configuration changed outside maintenance")
	}
	return nil
}

func (s *maintenanceService) waitState(ctx context.Context, want svc.State) error {
	timer := time.NewTicker(100 * time.Millisecond)
	defer timer.Stop()
	for {
		if err := ctx.Err(); err != nil {
			return err
		}
		if err := s.check(); err != nil {
			return err
		}
		status, err := s.control.Query()
		if err != nil {
			return err
		}
		if status.State == want {
			return nil
		}
		if want == svc.Running && status.State == svc.Stopped {
			return errors.New("source service stopped before becoming ready")
		}
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
		}
	}
}

func (s *maintenanceService) stop(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.check(); err != nil {
		return err
	}
	if err := s.verifySourceFiles(); err != nil {
		return err
	}
	status, err := s.control.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Paused || status.ProcessId == 0 {
		return errors.New("source service must acknowledge maintenance pause before stop")
	}
	wait, closeProcess, err := s.holdProcess(status.ProcessId)
	if err != nil {
		return err
	}
	if closeProcess == nil || wait == nil {
		if closeProcess != nil {
			closeProcess()
		}
		return errors.New("source process ownership missing")
	}
	defer closeProcess()
	if err = s.armRecovery(s.original); err != nil {
		return err
	}
	if err = ctx.Err(); err != nil {
		return err
	}
	if err = s.check(); err != nil {
		return err
	}
	if err = s.control.setStartType(mgr.StartDisabled); err != nil {
		return err
	}
	if err = s.check(); err != nil {
		return err
	}
	currentStatus, err := s.control.Query()
	if err != nil {
		return err
	}
	if currentStatus.State != svc.Paused || currentStatus.ProcessId != status.ProcessId {
		return errors.New("source service process changed before stop")
	}
	if _, err = s.control.Control(svc.Stop); err != nil {
		return err
	}
	if err = s.waitState(ctx, svc.Stopped); err != nil {
		return err
	}
	if err = wait(ctx); err != nil {
		return err
	}
	return s.check()
}

// Idempotent pre-replacement resume without a topology handoff. The caller must
// first release volume locks and establish that no reattachment is needed.
// Use boundMaintenanceService.resumeTopology after recorded disk detachment.
// This never authorizes partially replaced source files to start as LocalSystem.
func (s *maintenanceService) resume(ctx context.Context) error {
	if err := s.resumeWithArguments(ctx, nil); err != nil {
		return err
	}
	return s.restoreStartup()
}

// Call only after the selected service and its required mount topology have
// passed validation. Until then a reboot must go through the recovery entry.
func (s *maintenanceService) restoreStartup() error {
	if err := s.check(); err != nil {
		return err
	}
	status, err := s.control.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Running || status.ProcessId == 0 {
		return errors.New("running validated service required before restoring automatic startup")
	}
	if err = s.control.setStartType(s.original.StartType); err != nil {
		return err
	}
	return s.check()
}

func (s *maintenanceService) resumeWithArguments(ctx context.Context, args []string) error {
	if len(args) != 0 {
		if _, _, err := brokerResumeArguments(append([]string{"UnityWorkspaceStorage"}, args...)); err != nil {
			return err
		}
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Minute)
	defer cancel()
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.check(); err != nil {
		return err
	}
	if err := s.verifySourceFiles(); err != nil {
		return err
	}
	status, err := s.control.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Stopped && status.State != svc.Running && status.State != svc.Paused {
		return errors.New("source service transition still in progress")
	}
	if err = s.check(); err != nil {
		return err
	}
	if status.State == svc.Stopped {
		// StartService cannot start Disabled services. Demand start permits this
		// attempt without allowing an interrupted attempt to auto-start on reboot.
		if err = s.armRecovery(s.original); err != nil {
			return err
		}
		if err = s.check(); err != nil {
			return err
		}
		if err = s.control.setStartType(mgr.StartManual); err != nil {
			return err
		}
		if err = s.check(); err != nil {
			return err
		}
		if err = s.control.Start(args...); err != nil {
			return err
		}
	}
	if status.State == svc.Paused {
		if _, err = s.control.Control(svc.Continue); err != nil {
			return err
		}
	}
	return s.waitState(ctx, svc.Running)
}

// Complete this before reading/reserving topology. Paused means both the pipe
// worker set and background Recover have drained, while the process remains alive.
func (s *maintenanceService) pause(ctx context.Context) error {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	if err := s.check(); err != nil {
		return err
	}
	if err := s.verifySourceFiles(); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	before, err := s.control.Query()
	if err != nil {
		return err
	}
	if before.State != svc.Running || before.ProcessId == 0 || before.Accepts&svc.AcceptPauseAndContinue == 0 {
		return errors.New("source broker does not support admitted maintenance pause")
	}
	_, closeProcess, err := s.holdProcess(before.ProcessId)
	if err != nil {
		return err
	}
	if closeProcess == nil {
		return errors.New("source process ownership missing")
	}
	defer closeProcess()
	// Pause is already disruptive: a crashed coordinator cannot Continue it.
	// Arm durable recovery before the first control request, not just before Stop.
	if err := s.armRecovery(s.original); err != nil {
		return err
	}
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := s.check(); err != nil {
		return err
	}
	current, err := s.control.Query()
	if err != nil {
		return err
	}
	if current.State != svc.Running || current.ProcessId != before.ProcessId || current.Accepts&svc.AcceptPauseAndContinue == 0 {
		return errors.New("source process changed before maintenance pause")
	}
	if _, err = s.control.Control(svc.Pause); err != nil {
		return err
	}
	if err = s.waitState(ctx, svc.Paused); err != nil {
		return err
	}
	after, err := s.control.Query()
	if err != nil {
		return err
	}
	if after.State != svc.Paused || after.ProcessId != before.ProcessId {
		return errors.New("source process changed during pause")
	}
	return s.check()
}
