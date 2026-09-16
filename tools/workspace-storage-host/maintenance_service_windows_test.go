//go:build windows

package main

import (
	"context"
	"errors"
	"os"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type maintenanceSCMFixture struct {
	startErr  error
	startArgs []string
	config    mgr.Config
	status    svc.Status
	calls     []string
	swapPID   bool
}

func (f *maintenanceSCMFixture) Config() (mgr.Config, error) { return f.config, nil }
func (f *maintenanceSCMFixture) Query() (svc.Status, error)  { return f.status, nil }
func (f *maintenanceSCMFixture) Control(cmd svc.Cmd) (svc.Status, error) {
	if cmd == svc.Pause {
		f.calls = append(f.calls, "pause")
		f.status.State = svc.Paused
		return f.status, nil
	}
	if cmd == svc.Continue {
		f.calls = append(f.calls, "continue")
		f.status.State = svc.Running
		return f.status, nil
	}
	if cmd != svc.Stop {
		return svc.Status{}, errors.New("unexpected control")
	}
	f.calls = append(f.calls, "stop")
	f.status = svc.Status{State: svc.Stopped}
	return f.status, nil
}
func (f *maintenanceSCMFixture) Start(args ...string) error {
	f.startArgs = append([]string(nil), args...)
	f.calls = append(f.calls, "start")
	if f.startErr != nil {
		return f.startErr
	}
	f.status = svc.Status{State: svc.Running, ProcessId: 42}
	return nil
}

func TestMaintenanceResumePassesProtectedIdentityOnlyToStoppedBroker(t *testing.T) {
	s, f := maintenanceSCMTestFixture()
	f.status.State = svc.Stopped
	f.config.StartType = mgr.StartDisabled
	args := []string{"maintenance-resume", strings.Repeat("a", 64), strings.Repeat("b", 64)}
	if err := s.resumeWithArguments(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	if strings.Join(f.startArgs, ",") != strings.Join(args, ",") {
		t.Fatal("SCM resume identity missing")
	}
	f.startArgs = nil
	f.status.State = svc.Paused
	if err := s.resumeWithArguments(context.Background(), args); err != nil {
		t.Fatal(err)
	}
	if f.startArgs != nil || f.status.State != svc.Running {
		t.Fatal("paused broker restarted instead of continued")
	}
	f.calls = nil
	if err := s.resumeWithArguments(context.Background(), []string{"maintenance-resume", `C:\user\record.json`, args[2]}); err == nil {
		t.Fatal("path accepted as transaction")
	}
	if len(f.calls) != 0 {
		t.Fatal("mutated SCM for invalid resume arguments")
	}
}
func (f *maintenanceSCMFixture) setStartType(start uint32) error {
	if start == mgr.StartDisabled {
		f.calls = append(f.calls, "disable")
	} else if start == mgr.StartManual {
		f.calls = append(f.calls, "demand-start")
	} else {
		f.calls = append(f.calls, "restore-start")
	}
	f.config.StartType = start
	if f.swapPID {
		f.status.ProcessId++
	}
	return nil
}

func TestMaintenancePauseArmsRecoveryBeforeAnyDisruption(t *testing.T) {
	s, f := maintenanceSCMTestFixture()
	f.status.Accepts = svc.AcceptPauseAndContinue
	if err := s.pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, ","); got != "verify,hold-process,arm,pause,close-process" {
		t.Fatal(got)
	}
	for _, scenario := range []string{"registration-failed", "cancelled", "process-changed"} {
		t.Run(scenario, func(t *testing.T) {
			s, f := maintenanceSCMTestFixture()
			f.status.Accepts = svc.AcceptPauseAndContinue
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			s.armRecovery = func(mgr.Config) error {
				switch scenario {
				case "registration-failed":
					return errors.New("boot recovery registration failed")
				case "cancelled":
					cancel()
				case "process-changed":
					f.status.ProcessId++
				}
				return nil
			}
			if err := s.pause(ctx); err == nil {
				t.Fatal("unsafe pause accepted")
			}
			if hasMigrationCall(f.calls, "pause") || hasMigrationCall(f.calls, "disable") || f.status.State != svc.Running {
				t.Fatal("service disrupted without recovery authority", f.calls)
			}
		})
	}
}

func TestMaintenanceResumeDoesNotEnableAutomaticStartupBeforeValidation(t *testing.T) {
	for _, failStart := range []bool{false, true} {
		s, f := maintenanceSCMTestFixture()
		f.status = svc.Status{State: svc.Stopped}
		f.config.StartType = mgr.StartDisabled
		if failStart {
			f.startErr = errors.New("service startup failed")
		}
		args := []string{"maintenance-resume", strings.Repeat("a", 64), strings.Repeat("b", 64)}
		err := s.resumeWithArguments(context.Background(), args)
		if (err != nil) != failStart {
			t.Fatalf("unexpected startup result: %v", err)
		}
		if f.config.StartType != mgr.StartManual || hasMigrationCall(f.calls, "restore-start") {
			t.Fatal("automatic startup restored before mount validation", f.calls)
		}
		if got := strings.Join(f.calls, ","); got != "verify,arm,demand-start,start" {
			t.Fatal(got)
		}
		if !failStart {
			if err := s.restoreStartup(); err != nil {
				t.Fatal(err)
			}
			if f.config.StartType != mgr.StartAutomatic {
				t.Fatal("validated startup policy not restored")
			}
		} else if err := s.restoreStartup(); err == nil {
			t.Fatal("enabled automatic startup for failed service")
		}
	}
}
func maintenanceSCMTestFixture() (*maintenanceService, *maintenanceSCMFixture) {
	f := &maintenanceSCMFixture{config: mgr.Config{ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, StartType: mgr.StartAutomatic, ServiceStartName: "LocalSystem", BinaryPathName: `C:\service\host.exe`}, status: svc.Status{State: svc.Running, ProcessId: 42}}
	s := &maintenanceService{control: f, original: f.config, assertHeld: func() error { return nil }, verifySourceFiles: func() error { f.calls = append(f.calls, "verify"); return nil }, armRecovery: func(mgr.Config) error { f.calls = append(f.calls, "arm"); return nil }, holdProcess: func(uint32) (func(context.Context) error, func(), error) {
		f.calls = append(f.calls, "hold-process")
		return func(context.Context) error { f.calls = append(f.calls, "process-exited"); return nil }, func() { f.calls = append(f.calls, "close-process") }, nil
	}}
	return s, f
}

func TestMaintenanceServiceStopArmsRecoveryBeforeDisableAndWaitsForProcess(t *testing.T) {
	s, f := maintenanceSCMTestFixture()
	f.status.State = svc.Paused
	if err := s.stop(context.Background()); err != nil {
		t.Fatal(err)
	}
	if got := strings.Join(f.calls, ","); got != "verify,hold-process,arm,disable,stop,process-exited,close-process" {
		t.Fatal(got)
	}
	if f.config.StartType != mgr.StartDisabled {
		t.Fatal("service can restart during backup")
	}
	if err := s.resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.config.StartType != mgr.StartAutomatic || f.status.State != svc.Running {
		t.Fatal("source not resumed")
	}
	f.calls = nil
	if err := s.resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if strings.Contains(strings.Join(f.calls, ","), ",start") {
		t.Fatal("started already running service")
	}
}

func TestMaintenanceServiceRejectsUnsafeStop(t *testing.T) {
	for _, kind := range []string{"recovery", "source", "configuration", "process-swap", "process-exit"} {
		t.Run(kind, func(t *testing.T) {
			s, f := maintenanceSCMTestFixture()
			f.status.State = svc.Paused
			switch kind {
			case "recovery":
				s.armRecovery = func(mgr.Config) error { return errors.New("journal unavailable") }
			case "source":
				s.verifySourceFiles = func() error { return errors.New("source changed") }
			case "configuration":
				f.config.BinaryPathName = `C:\unknown.exe`
			case "process-swap":
				f.swapPID = true
			case "process-exit":
				s.holdProcess = func(uint32) (func(context.Context) error, func(), error) {
					return func(context.Context) error { return context.DeadlineExceeded }, func() {}, nil
				}
			}
			if err := s.stop(context.Background()); err == nil {
				t.Fatal("accepted unsafe stop")
			}
			if kind != "process-exit" && hasMigrationCall(f.calls, "stop") {
				t.Fatal("stopped without authority", f.calls)
			}
			if kind == "recovery" && f.config.StartType != mgr.StartAutomatic {
				t.Fatal("disabled before recovery was armed")
			}
		})
	}
}

func TestMaintenanceServiceCannotResumeChangedSource(t *testing.T) {
	s, f := maintenanceSCMTestFixture()
	f.status = svc.Status{State: svc.Stopped}
	f.config.StartType = mgr.StartDisabled
	s.verifySourceFiles = func() error { return errors.New("receipt or binary changed") }
	if err := s.resume(context.Background()); err == nil {
		t.Fatal("started unverified executable")
	}
	if len(f.calls) != 0 || f.config.StartType != mgr.StartDisabled {
		t.Fatal("changed rejected service")
	}
}

func TestMaintenanceProcessHandleChecksImageAndCancellation(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	wait, closeProcess, err := holdMaintenanceProcess(executable, uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer closeProcess()
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if err = wait(ctx); !errors.Is(err, context.Canceled) {
		t.Fatal(err)
	}
	closeProcess()
	if err = wait(context.Background()); err == nil {
		t.Fatal("used closed process handle")
	}
	if _, closeWrong, err := holdMaintenanceProcess(`C:\wrong.exe`, uint32(os.Getpid())); err == nil {
		closeWrong()
		t.Fatal("accepted wrong image")
	}
}
