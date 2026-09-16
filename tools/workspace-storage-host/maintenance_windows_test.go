//go:build windows

package main

import (
	"testing"

	"golang.org/x/sys/windows"
)

func TestMaintenanceChildRejectsPathTraversalBeforeOpening(t *testing.T) {
	for _, name := range []string{"", ".", "..", "../other", `child\other`, `C:\other`, "other:stream", "other.", "other "} {
		handle, err := openPrivateMaintenanceChild(0, name, true)
		if handle != 0 || err == nil || err.Error() != "maintenance name must be one ordinary path component" {
			t.Fatalf("%q: handle=%v error=%v", name, handle, err)
		}
	}
}

func TestMaintenanceSecurityRequiresPrivateProtectedOwnership(t *testing.T) {
	for _, scenario := range []struct {
		sddl  string
		valid bool
	}{
		{maintenanceSDDL, true},
		{"O:SYG:SYD:P(A;OICI;FA;;;BA)(A;OICI;FA;;;SY)", true},
		{"O:BAG:BAD:(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", false},
		{"O:BUG:BUD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)", false},
		{"O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;WD)", false},
		{"O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;FR;;;BU)", false},
		{"O:BAG:BAD:P(A;OICI;FA;;;SY)(A;OICI;FR;;;BA)", false},
	} {
		sd, err := windows.SecurityDescriptorFromString(scenario.sddl)
		if err != nil {
			t.Fatal(err)
		}
		if err = validateMaintenanceSecurity(sd); (err == nil) != scenario.valid {
			t.Fatalf("%s: %v", scenario.sddl, err)
		}
	}
}
func TestClosedMaintenanceAreaHasNoOwnership(t *testing.T) {
	area := &maintenanceArea{}
	if err := area.assertHeld(); err == nil {
		t.Fatal("unopened area claimed ownership")
	}
	area.close()
	area.close()
}
