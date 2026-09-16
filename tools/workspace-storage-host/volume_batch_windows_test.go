//go:build windows

package main

import (
	"errors"
	"strings"
	"testing"
)

type batchVolumeFixture struct {
	name  string
	calls *[]string
	fail  string
}

func quiesceMaintenanceVolumes(volumes []maintenanceVolumeOperation, persistResume, assertHeld func() error) error {
	r, err := reserveMaintenanceVolumes(volumes, persistResume, assertHeld)
	if err != nil {
		return err
	}
	return r.quiesce(func() error { return nil })
}

func TestMaintenanceReservationSpansServiceStop(t *testing.T) {
	calls := []string{}
	r, err := reserveMaintenanceVolumes([]maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}}, func() error { return nil }, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	if strings.Join(calls, ",") != "a:lock" {
		t.Fatal("reservation released before stop", calls)
	}
	if err = r.quiesce(func() error { return errors.New("service still running") }); err == nil {
		t.Fatal("detached before stop")
	}
	if strings.Join(calls, ",") != "a:lock,a:close" {
		t.Fatal(calls)
	}
}

func (v *batchVolumeFixture) action(name string) error {
	*v.calls = append(*v.calls, v.name+":"+name)
	if v.fail == name {
		return errors.New("injected " + name)
	}
	return nil
}
func (v *batchVolumeFixture) lock() error   { return v.action("lock") }
func (v *batchVolumeFixture) detach() error { return v.action("detach") }
func (v *batchVolumeFixture) close() error  { return v.action("close") }

func TestMaintenanceBatchLocksAllVolumesBeforeDetach(t *testing.T) {
	calls := []string{}
	volumes := []maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}, &batchVolumeFixture{"b", &calls, ""}}
	err := quiesceMaintenanceVolumes(volumes, func() error { calls = append(calls, "persist"); return nil }, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if strings.Join(calls, ",") != "persist,a:lock,b:lock,a:detach,b:detach,b:close,a:close" {
		t.Fatal(calls)
	}
}

func TestMaintenanceBatchBusyVolumeNeverDetachesAnother(t *testing.T) {
	calls := []string{}
	volumes := []maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}, &batchVolumeFixture{"b", &calls, "lock"}}
	err := quiesceMaintenanceVolumes(volumes, func() error { return nil }, func() error { return nil })
	if err == nil {
		t.Fatal("ignored busy volume")
	}
	if strings.Join(calls, ",") != "a:lock,b:lock,b:close,a:close" {
		t.Fatal(calls)
	}
}

func TestMaintenanceBatchPreservesResumeEvidenceOnPartialDetach(t *testing.T) {
	calls := []string{}
	volumes := []maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}, &batchVolumeFixture{"b", &calls, "detach"}}
	persisted := false
	err := quiesceMaintenanceVolumes(volumes, func() error { persisted = true; return nil }, func() error { return nil })
	if err == nil || !persisted {
		t.Fatal("lost recovery requirement")
	}
	if strings.Join(calls, ",") != "a:lock,b:lock,a:detach,b:detach,b:close,a:close" {
		t.Fatal(calls)
	}
}

func TestMaintenanceBatchCannotProceedWithoutDurableResume(t *testing.T) {
	calls := []string{}
	volumes := []maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}}
	err := quiesceMaintenanceVolumes(volumes, func() error { return errors.New("disk full") }, func() error { return nil })
	if err == nil || strings.Join(calls, ",") != "a:close" {
		t.Fatal(err, calls)
	}
}
