//go:build windows

package main

import (
	"context"
	"golang.org/x/sys/windows/svc"
	"os"
	"testing"
)

func TestMaintenanceSourceHoldsComponentBytes(t *testing.T) {
	path, receipt, scm := evidenceFixture(t)
	evidence, err := inspectServiceEvidence(path, receipt.UserSID, scm)
	if err != nil {
		t.Fatal(err)
	}
	guard, err := holdMaintenanceSource(evidence, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer guard.close()
	for _, path := range []string{path, receipt.ConfigPath, receipt.Executable} {
		if err = os.WriteFile(path, []byte("changed"), 0600); err == nil {
			t.Fatal("changed held source", path)
		}
	}
	if err = guard.verify(); err != nil {
		t.Fatal(err)
	}
	guard.close()
	if err = guard.verify(); err == nil {
		t.Fatal("accepted released source guard")
	}
	if err = os.WriteFile(receipt.Executable, []byte("changed"), 0600); err != nil {
		t.Fatal("leaked source handle", err)
	}
	if next, err := holdMaintenanceSource(evidence, func() error { return nil }); err == nil {
		next.close()
		t.Fatal("accepted changed original")
	}
}

func TestMaintenanceSourceBindingPreventsResumeOfChangedFiles(t *testing.T) {
	path, receipt, scm := evidenceFixture(t)
	evidence, err := inspectServiceEvidence(path, receipt.UserSID, scm)
	if err != nil {
		t.Fatal(err)
	}
	s, control := maintenanceSCMTestFixture()
	control.status.State = svc.Paused
	if err = s.withSourceEvidence(evidence, func(*maintenanceService) error { t.Fatal("bound unrelated SCM configuration"); return nil }); err == nil {
		t.Fatal("accepted unrelated SCM identity")
	}
	control.config.BinaryPathName = scm.Command
	s.original = control.config
	if err = s.withSourceEvidence(evidence, func(bound *maintenanceService) error { return bound.stop(context.Background()) }); err != nil {
		t.Fatal(err)
	}
	// Stop scope released its read handles, allowing the later replacement phase.
	if err = os.WriteFile(receipt.Executable, []byte("replacement"), 0600); err != nil {
		t.Fatal(err)
	}
	control.calls = nil
	if err = s.withSourceEvidence(evidence, func(bound *maintenanceService) error { return bound.resume(context.Background()) }); err == nil {
		t.Fatal("resumed changed original")
	}
	if len(control.calls) != 0 {
		t.Fatal("mutated service after source admission failed", control.calls)
	}
}
