//go:build windows

package main

import (
	"context"
	"errors"
	"strings"
	"testing"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestLegacySourceRequiresPublishedExecutableNotJustVersion(t *testing.T) {
	valid := serviceEvidence{SchemaVersion: 1, ExecutableSHA256: legacyHb12Executable,
		Receipt: installReceipt{ComponentVersion: legacyHb12Component, ExecutableSHA256: legacyHb12Executable}}
	if !exactLegacyHb12Source(valid) {
		t.Fatal("published legacy identity was not recognized")
	}
	for _, change := range []func(*serviceEvidence){
		func(s *serviceEvidence) { s.Receipt.ComponentVersion = "0.0.0+cfa606fd4143.hb13" },
		func(s *serviceEvidence) { s.ExecutableSHA256 = strings.Repeat("a", 64) },
		func(s *serviceEvidence) { s.Receipt.ExecutableSHA256 = strings.Repeat("b", 64) },
		func(s *serviceEvidence) { s.RecoveryReady = true },
		func(s *serviceEvidence) { s.SchemaVersion = 2 },
	} {
		candidate := valid
		change(&candidate)
		if exactLegacyHb12Source(candidate) {
			t.Fatal("unsupported legacy identity received an exception")
		}
	}
}

func TestLegacyDetachedJournalsRejectDynamicDriftAndAdditionalWorkspaces(t *testing.T) {
	_, lease := topologyLeaseFixture(t)
	lease.State = "released"
	topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease}}}
	if err := validateLegacyDetachedJournals(topology, []workspace.LeaseJournal{lease}); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*workspace.LeaseJournal){
		func(l *workspace.LeaseJournal) { l.State = "ready" },
		func(l *workspace.LeaseJournal) { l.ClientPID++ },
		func(l *workspace.LeaseJournal) { l.UpdatedAt = time.Now().UTC() },
		func(l *workspace.LeaseJournal) { l.OwnershipToken = "another-owner" },
	} {
		current := lease
		change(&current)
		if err := validateLegacyDetachedJournals(topology, []workspace.LeaseJournal{current}); err == nil {
			t.Fatal("lease drift was admitted")
		}
	}
	for _, current := range [][]workspace.LeaseJournal{nil, {lease, lease}} {
		if err := validateLegacyDetachedJournals(topology, current); err == nil {
			t.Fatal("changed complete inventory was admitted")
		}
	}
	topology.Mounts[0].Attached = true
	if err := validateLegacyDetachedJournals(topology, []workspace.LeaseJournal{lease}); err == nil {
		t.Fatal("an attached legacy image was admitted")
	}
	topology.Mounts[0].Attached = false
	second := lease
	second.LeaseID = "lease-2"
	topology.Mounts = append(topology.Mounts, maintenanceMount{Lease: second})
	if err := validateLegacyDetachedJournals(topology, []workspace.LeaseJournal{second, lease}); err != nil {
		t.Fatal("directory enumeration order changed a complete snapshot", err)
	}
	if err := validateLegacyDetachedJournals(topology, []workspace.LeaseJournal{lease, lease}); err == nil {
		t.Fatal("duplicate lease identity admitted")
	}
}

func TestLegacyStopRequiresBothProofsAndRechecksBeforeDisruption(t *testing.T) {
	for _, phase := range []string{"missing-before", "missing-after", "before", "changed-before-stop", "after", "success"} {
		t.Run(phase, func(t *testing.T) {
			s, f := maintenanceSCMTestFixture()
			count := 0
			before := func() error {
				count++
				if phase == "before" || (phase == "changed-before-stop" && count == 2) {
					return errors.New("legacy mount/lease changed")
				}
				return nil
			}
			after := func() error {
				if f.status.State != svc.Stopped || !hasMigrationCall(f.calls, "process-exited") {
					t.Fatal("post-stop proof ran before original process exit")
				}
				if phase == "after" {
					return errors.New("late inventory drift")
				}
				return nil
			}
			if phase == "missing-before" {
				before = nil
			}
			if phase == "missing-after" {
				after = nil
			}
			err := s.stopFromState(context.Background(), svc.Running, before, after)
			if (err == nil) != (phase == "success") {
				t.Fatalf("unexpected result: %v", err)
			}
			if phase != "success" && phase != "after" && hasMigrationCall(f.calls, "stop") {
				t.Fatal("source stopped without current detached authority", f.calls)
			}
			if phase == "before" || strings.HasPrefix(phase, "missing-") {
				if f.config.StartType != mgr.StartAutomatic {
					t.Fatal("source startup changed before initial proof")
				}
			}
			if phase == "success" && (count != 2 || f.status.State != svc.Stopped || f.config.StartType != mgr.StartDisabled) {
				t.Fatal("source stop was not bounded by both proofs and restart protection")
			}
		})
	}
}
