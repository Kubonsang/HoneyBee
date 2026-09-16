//go:build windows

package main

import (
	"errors"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"testing"
)

func TestDetachedBrokerRestartAdmission(t *testing.T) {
	for _, scenario := range []string{"detached", "attached", "wrong-image", "wrong-owner", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			r, lease := topologyLeaseFixture(t)
			recordResumeLease(t, r, lease)
			topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}
			if scenario == "wrong-owner" {
				topology.Mounts[0].Lease.OwnershipToken = "foreign"
			}
			err := verifyDetachedBrokerRestart(topology, r, func() error {
				if scenario == "cancelled" {
					return errors.New("cancelled")
				}
				return nil
			}, func(string) (bool, error) { return scenario == "attached", nil }, func(string) (string, error) {
				if scenario == "wrong-image" {
					return "wrong", nil
				}
				return lease.FileIdentity.FileID, nil
			})
			if (err == nil) != (scenario == "detached") {
				t.Fatalf("unexpected admission: %v", err)
			}
			if !topology.Mounts[0].Attached {
				t.Fatal("original restore authority mutated")
			}
		})
	}
}

func TestMissingBrokerAttachmentIsDistinctFromOtherHealthFailures(t *testing.T) {
	r, lease := topologyLeaseFixture(t)
	recordResumeLease(t, r, lease)
	topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}
	check := func() error { return nil }
	identity := func(string) (string, error) { return lease.FileIdentity.FileID, nil }
	paths := func(workspace.LeaseJournal) ([]string, error) {
		t.Fatal("missing disk should not query volume")
		return nil, nil
	}
	err := verifyBrokerMounts(topology, r, check, func(string) (bool, error) { return false, nil }, identity, paths)
	if !errors.Is(err, errRestoredAttachmentMissing) {
		t.Fatal(err)
	}
	err = verifyBrokerMounts(topology, r, check, func(string) (bool, error) { return false, errors.New("unknown disk status") }, identity, paths)
	if err == nil || errors.Is(err, errRestoredAttachmentMissing) {
		t.Fatal("unknown status admitted for restart", err)
	}
	topology.Mounts[0].Attached = false
	err = verifyBrokerMounts(topology, r, check, func(string) (bool, error) { return true, nil }, identity, paths)
	if err == nil || errors.Is(err, errRestoredAttachmentMissing) {
		t.Fatal("foreign attachment admitted for restart", err)
	}
}
