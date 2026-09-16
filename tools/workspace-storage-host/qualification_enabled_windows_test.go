//go:build windows && honeybee_qualification

package main

import (
	"golang.org/x/sys/windows"
	"os"
	"strings"
	"testing"
)

func TestQualificationAdmissionRejectsArbitraryActions(t *testing.T) {
	if _, handled, err := qualificationCommand([]string{"qualification-capabilities"}); !handled || err != nil {
		t.Fatal(handled, err)
	}
	for _, args := range [][]string{
		{"qualification-arm", strings.Repeat("a", 64), strings.Repeat("b", 64), "Committed", "halt"},
		{"qualification-arm", strings.Repeat("a", 64), strings.Repeat("b", 64), "Stopped", "execute"},
		{"qualification-interrupt", "1234"},
		{"qualification-status", "../../outside"},
		{"qualification-capabilities", "extra"},
	} {
		if _, handled, err := qualificationCommand(args); !handled || err == nil {
			t.Fatalf("accepted invalid QA request: %v", args)
		}
	}
	if _, handled, _ := qualificationCommand([]string{"broker-run"}); handled {
		t.Fatal("QA intercepted product operation")
	}
}

func TestQualificationProcessHandleRequiresCreationAndImageIdentity(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	identity, err := captureServiceRecoveryOwner(uint32(os.Getpid()), sid)
	if err != nil {
		t.Fatal(err)
	}
	stale := identity
	stale.Created--
	if h, err := qualificationHeldProcess(stale, executable); err == nil {
		windows.CloseHandle(h)
		t.Fatal("accepted stale process identity")
	}
	if h, err := qualificationHeldProcess(identity, executable+".different"); err == nil {
		windows.CloseHandle(h)
		t.Fatal("accepted unrelated image")
	}
	h, err := qualificationHeldProcess(identity, executable)
	if err != nil {
		t.Fatal(err)
	}
	windows.CloseHandle(h)
}
