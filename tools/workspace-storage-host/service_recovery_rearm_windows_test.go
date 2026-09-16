//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
	"strings"
	"testing"
)

func TestRetiredRecoveryRegistrationAdmission(t *testing.T) {
	r := serviceRecoveryRegistration{TransactionSHA256: strings.Repeat("a", 64), ContextSHA256: strings.Repeat("b", 64), Executable: `C:\protected\host.exe`}
	for _, scenario := range []string{"retired", "command", "account", "manual", "running", "pid", "dependency"} {
		c := mgr.Config{BinaryPathName: r.command(), StartType: mgr.StartDisabled, ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, ServiceStartName: "LocalSystem", ErrorControl: mgr.ErrorNormal}
		s := svc.Status{State: svc.Stopped}
		switch scenario {
		case "command":
			c.BinaryPathName += " changed"
		case "account":
			c.ServiceStartName = "other"
		case "manual":
			c.StartType = mgr.StartManual
		case "running":
			s.State = svc.Running
		case "pid":
			s.ProcessId = 1
		case "dependency":
			c.Dependencies = []string{"other"}
		}
		err := admitRetiredRecoveryRegistration(c, s, r)
		if (err == nil) != (scenario == "retired") {
			t.Fatalf("%s: %v", scenario, err)
		}
	}
}
