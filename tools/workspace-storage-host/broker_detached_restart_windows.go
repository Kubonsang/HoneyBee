//go:build windows

package main

import (
	"context"
	"crypto/rand"
	"errors"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows/svc"
)

// Admission for the narrow case where a replacement broker is Running but all
// recorded disks are gone. A partially attached set still needs diagnostics.
// All lease/owner/file identities must match before any service disruption.
func verifyDetachedBrokerRestart(topology maintenanceTopology, receipt installReceipt, check func() error, loaded func(string) (bool, error), identity func(string) (string, error)) error {
	detached := topology
	detached.Mounts = append([]maintenanceMount(nil), topology.Mounts...)
	for i := range detached.Mounts {
		detached.Mounts[i].Attached = false
	}
	return verifyBrokerMounts(detached, receipt, check, loaded, identity, func(workspace.LeaseJournal) ([]string, error) {
		return nil, errors.New("attached volume is not eligible for detached restart")
	})
}

func (b *boundMaintenanceService) restartDetachedBroker(ctx context.Context, area *maintenanceArea, transaction string, topology maintenanceTopology, receipt installReceipt) error {
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return area.assertHeld()
	}
	admit := func() error {
		return verifyDetachedBrokerRestart(topology, receipt, check, maintenanceImageLoaded, storage.FileIdentity)
	}
	if err := admit(); err != nil {
		return err
	}
	// Existing pause arms durable recovery and drains pipe/background operations.
	if err := b.pause(ctx); err != nil {
		return err
	}
	if err := admit(); err != nil {
		return err
	}
	var nonce [32]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return err
	}
	// Keep the original desired topology immutable. The new protected reservation
	// records this attempt's observed empty attachment set, never a new baseline.
	reservation, err := b.reserve(area, evidenceHash(append([]byte("detached-resume:"+transaction+":"), nonce[:]...)))
	if err != nil {
		return err
	}
	defer reservation.close()
	if len(reservation.volumes) != 0 {
		return errors.New("attachment appeared before detached broker restart")
	}
	if err = admit(); err != nil {
		return err
	}
	if err = b.stop(ctx); err != nil {
		return err
	}
	return reservation.quiesce(func() error {
		if err := check(); err != nil {
			return err
		}
		status, err := b.handle.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Stopped {
			return errors.New("broker restart requires confirmed process exit")
		}
		return nil
	})
}
