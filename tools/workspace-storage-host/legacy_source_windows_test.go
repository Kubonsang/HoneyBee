//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestLegacyTargetTopologyKeepsRollbackSnapshotDetached(t *testing.T) {
	receipt, lease := topologyLeaseFixture(t)
	receipt.ComponentVersion = legacyHb12Component
	receipt.ExecutableSHA256 = legacyHb12Executable
	source := serviceSourceRecord{SchemaVersion: 1, TransactionSHA256: strings.Repeat("a", 64), Evidence: serviceEvidence{
		SchemaVersion: 1, Receipt: receipt, ExecutableSHA256: legacyHb12Executable,
	}}
	data, _ := json.Marshal(source.Evidence)
	source.SourceEvidenceSHA256 = evidenceHash(data)
	topology := maintenanceTopology{SchemaVersion: 1, TransactionSHA256: source.TransactionSHA256,
		SourceEvidenceSHA256: source.SourceEvidenceSHA256, Mounts: []maintenanceMount{{Lease: lease}}}
	originalSource := source
	derived, target, err := legacyTargetTopology(source, topology)
	if err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(source, originalSource) || derived.Evidence != source.Evidence || !reflect.DeepEqual(derived.Original, source.Original) ||
		derived.TransactionSHA256 == source.TransactionSHA256 || derived.TransactionSHA256 != target.TransactionSHA256 ||
		target.SourceEvidenceSHA256 != source.SourceEvidenceSHA256 || !target.Mounts[0].Attached || topology.Mounts[0].Attached ||
		!reflect.DeepEqual(target.Mounts[0].Lease, lease) {
		t.Fatal("target topology changed source ownership or rollback state")
	}
	target.Mounts[0].Lease.OwnershipToken = "changed-target"
	if topology.Mounts[0].Lease.OwnershipToken != lease.OwnershipToken {
		t.Fatal("source and target topology share mutable storage")
	}
	other := source.Evidence
	other.Receipt.ComponentVersion = "0.0.0+cfa606fd4143.hb17"
	if pairTopologyTransaction(source.TransactionSHA256, source.Evidence, source.Evidence) != source.TransactionSHA256 ||
		pairTopologyTransaction(source.TransactionSHA256, source.Evidence, other) != derived.TransactionSHA256 ||
		pairTopologyTransaction(source.TransactionSHA256, other, source.Evidence) != source.TransactionSHA256 {
		t.Fatal("source rollback or ordinary update selected the legacy target topology")
	}
	for _, scenario := range []string{"attached", "duplicate", "nil", "transaction", "evidence", "foreign", "version", "owner"} {
		t.Run(scenario, func(t *testing.T) {
			s, snapshot := source, topology
			snapshot.Mounts = append([]maintenanceMount{}, topology.Mounts...)
			switch scenario {
			case "attached":
				snapshot.Mounts[0].Attached = true
			case "duplicate":
				snapshot.Mounts = append(snapshot.Mounts, snapshot.Mounts[0])
			case "nil":
				snapshot.Mounts = nil
			case "transaction":
				snapshot.TransactionSHA256 = strings.Repeat("b", 64)
			case "evidence":
				s.SourceEvidenceSHA256 = strings.Repeat("c", 64)
				snapshot.SourceEvidenceSHA256 = s.SourceEvidenceSHA256
			case "foreign":
				snapshot.Mounts[0].Lease.UserSID = "S-1-5-18"
			case "version":
				s.Evidence.Receipt.ComponentVersion = other.Receipt.ComponentVersion
			case "owner":
				snapshot.Mounts[0].Lease.OwnershipToken = ""
			}
			if _, _, err := legacyTargetTopology(s, snapshot); err == nil {
				t.Fatal("invalid source topology admitted")
			}
		})
	}
	topology.Mounts = []maintenanceMount{}
	if _, empty, err := legacyTargetTopology(source, topology); err != nil || empty.Mounts == nil {
		t.Fatal("empty inventory lost its complete-snapshot representation", err)
	}
}

func TestLegacySourceRequiresPublishedExecutableNotJustVersion(t *testing.T) {
	valid := serviceEvidence{SchemaVersion: 1, ExecutableSHA256: "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3",
		Receipt: installReceipt{ComponentVersion: "0.0.0+cfa606fd4143.hb12", ExecutableSHA256: "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3"}}
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
