//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"io/fs"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// Exact published beta.11 payload, independently matched to the affected host.
// https://github.com/Kubonsang/HoneyBee/releases/tag/v0.1.0-beta.11
// A version label alone never permits skipping the maintenance pause.
const legacyHb12Component = "0.0.0+cfa606fd4143.hb12"
const legacyHb12Executable = "0cad87d53bc974063f4f524a4b05b801cdb00a71eaeedb694414972c6e8438f3"

func exactLegacyHb12Source(source serviceEvidence) bool {
	return source.SchemaVersion == 1 && !source.RecoveryReady &&
		source.Receipt.ComponentVersion == legacyHb12Component &&
		source.ExecutableSHA256 == legacyHb12Executable &&
		source.Receipt.ExecutableSHA256 == legacyHb12Executable
}

// Preserve the observed live topology for the target. The old broker cannot
// restore attachments on startup, so its rollback intent must instead describe
// the same retained children detached. Neither intent modifies lease journals.
func legacyColdTopology(source serviceSourceRecord, topology maintenanceTopology) (serviceSourceRecord, maintenanceTopology, error) {
	if !exactLegacyHb12Source(source.Evidence) || !migrationDigest(source.TransactionSHA256) ||
		topology.SchemaVersion != 1 || topology.TransactionSHA256 != source.TransactionSHA256 ||
		topology.SourceEvidenceSHA256 != source.SourceEvidenceSHA256 || topology.Mounts == nil || len(topology.Mounts) > 10000 {
		return serviceSourceRecord{}, maintenanceTopology{}, errors.New("bound legacy source topology required")
	}
	data, err := json.Marshal(source.Evidence)
	if err != nil || evidenceHash(data) != source.SourceEvidenceSHA256 {
		return serviceSourceRecord{}, maintenanceTopology{}, errors.New("legacy source evidence changed")
	}
	result := topology
	result.TransactionSHA256 = evidenceHash([]byte("legacy-cold-topology:" + source.TransactionSHA256))
	result.Mounts = make([]maintenanceMount, len(topology.Mounts))
	seen := map[string]bool{}
	for i, mount := range topology.Mounts {
		if seen[mount.Lease.LeaseID] {
			return serviceSourceRecord{}, maintenanceTopology{}, errors.New("unique retained legacy workspaces required")
		}
		if err := validateMaintenanceLease(mount.Lease, source.Evidence.Receipt); err != nil {
			return serviceSourceRecord{}, maintenanceTopology{}, err
		}
		seen[mount.Lease.LeaseID] = true
		result.Mounts[i] = maintenanceMount{Lease: mount.Lease, Attached: false}
	}
	source.TransactionSHA256 = result.TransactionSHA256
	return source, result, nil
}

func (area *maintenanceArea) recordLegacyColdTopology(source serviceSourceRecord) error {
	check := area.assertHeld
	records := area.restoreRecordStorage(check, 16<<20)
	topology, err := loadMaintenanceTopology(source.TransactionSHA256, source.SourceEvidenceSHA256, source.Evidence.Receipt, records, check)
	if err != nil {
		return err
	}
	derivedSource, cold, err := legacyColdTopology(source, topology)
	if err != nil {
		return err
	}
	if err := persistServiceSourceRecord(derivedSource, filepath.Dir(area.Path), records, check); err != nil {
		return err
	}
	data, err := json.Marshal(cold)
	if err != nil {
		return err
	}
	return persistRestoreRecord("service-topology-"+cold.TransactionSHA256+".json", data, 16<<20, records, check)
}

func pairTopologyTransaction(transaction string, source, expected serviceEvidence) string {
	if exactLegacyHb12Source(source) && expected == source {
		return evidenceHash([]byte("legacy-cold-topology:" + transaction))
	}
	return transaction
}

// The original hb12 broker cannot consume maintenance-resume instructions.
// Its rollback baseline is already detached; start it normally and verify that
// protected snapshot before restoring automatic startup. New brokers still
// consume the full protected topology to restore their attachments.
func topologyResumeArguments(selected, original serviceEvidence, topology maintenanceTopology, transaction, sourcePin string) ([]string, error) {
	args := []string{"maintenance-resume", transaction, sourcePin}
	if _, _, err := brokerResumeArguments(append([]string{workspace.WindowsServiceName}, args...)); err != nil {
		return nil, err
	}
	if selected != original || !exactLegacyHb12Source(original) {
		return args, nil
	}
	if topology.SchemaVersion != 1 || topology.TransactionSHA256 != transaction || topology.SourceEvidenceSHA256 != sourcePin || topology.Mounts == nil {
		return nil, errors.New("protected detached legacy rollback topology required")
	}
	for _, mount := range topology.Mounts {
		if mount.Attached {
			return nil, errors.New("legacy rollback cannot restore attached workspaces")
		}
	}
	return nil, nil
}

func validateLegacyRetainedJournals(topology maintenanceTopology, leases []workspace.LeaseJournal) error {
	if len(leases) != len(topology.Mounts) {
		return errors.New("legacy workspace inventory changed before cold maintenance")
	}
	current := make(map[string]workspace.LeaseJournal, len(leases))
	for _, lease := range leases {
		if _, exists := current[lease.LeaseID]; exists {
			return errors.New("duplicate legacy lease identity")
		}
		current[lease.LeaseID] = lease
	}
	for _, mount := range topology.Mounts {
		lease, exists := current[mount.Lease.LeaseID]
		if !exists || !reflect.DeepEqual(mount.Lease, lease) {
			return errors.New("legacy lease changed during volume reservation")
		}
		delete(current, mount.Lease.LeaseID)
	}
	return nil
}

// Every originally attached child needs its own still-owned kernel lock. A
// same-length reservation for a different image is not authority to stop hb12.
func validateLegacyReservedVolumes(topology maintenanceTopology, reservation *maintenanceVolumeReservation, verifyDevices bool) (map[string]bool, error) {
	if reservation == nil || reservation.closed || reservation.assertHeld == nil || reservation.releaseGuards == nil || reservation.legacySourcePID == 0 {
		return nil, errors.New("live legacy reservation and path/process guards required")
	}
	if err := reservation.assertHeld(); err != nil {
		return nil, err
	}
	children := map[string]bool{}
	for _, mount := range topology.Mounts {
		if mount.Attached {
			key := strings.ToLower(mount.Lease.ChildPath)
			if children[key] {
				return nil, errors.New("duplicate reserved legacy image")
			}
			children[key] = true
		}
	}
	if len(children) != len(reservation.volumes) {
		return nil, errors.New("legacy volume reservation does not cover the original topology")
	}
	seen := map[string]bool{}
	for _, operation := range reservation.volumes {
		volume, ok := operation.(*maintenanceVolume)
		if !ok || volume == nil || !volume.locked || volume.volume == 0 || volume.volume == windows.InvalidHandle || volume.image == 0 || volume.image == windows.InvalidHandle {
			return nil, errors.New("owned exclusive legacy volume lock required")
		}
		key := strings.ToLower(volume.imagePath)
		if !children[key] || seen[key] {
			return nil, errors.New("legacy reservation image identity differs from original topology")
		}
		seen[key] = true
		if verifyDevices {
			if err := volume.verifyIdentity(); err != nil {
				return nil, err
			}
		}
	}
	return children, nil
}

func (b *boundMaintenanceService) reserveLegacyRetained(area *maintenanceArea, transaction string) (*maintenanceVolumeReservation, error) {
	if b.service == nil || b.handle == nil || !exactLegacyHb12Source(b.evidence) {
		return nil, errors.New("exact published legacy source required")
	}
	before, err := b.handle.Query()
	if err != nil {
		return nil, err
	}
	if before.State != svc.Running || before.ProcessId == 0 {
		return nil, errors.New("running legacy source required")
	}
	var reservation *maintenanceVolumeReservation
	err = b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error {
		if err := s.check(); err != nil {
			return err
		}
		wait, closeProcess, err := s.holdProcess(before.ProcessId)
		if err != nil {
			return err
		}
		if wait == nil || closeProcess == nil {
			if closeProcess != nil {
				closeProcess()
			}
			return errors.New("original legacy process ownership required")
		}
		transferred := false
		defer func() {
			if !transferred {
				closeProcess()
			}
		}()
		check := func() error {
			if err := s.check(); err != nil {
				return err
			}
			now, err := b.handle.Query()
			if err != nil {
				return err
			}
			if now.State != svc.Running || now.ProcessId != before.ProcessId {
				return errors.New("legacy source process changed during retained reservation")
			}
			return nil
		}
		reservation, err = area.reserveTopology(b.evidence, transaction, check)
		if err == nil {
			release := reservation.releaseGuards
			reservation.releaseGuards = func() error {
				defer closeProcess()
				return release()
			}
			reservation.legacySourcePID = before.ProcessId
			transferred = true
		}
		return err
	})
	return reservation, err
}

// Compare complete journals, including state/PID/time fields. An intervening
// attach, heartbeat or release is a refusal even if immutable ownership matches.
// Source startup remains protected by the already armed recovery registration.
func (area *maintenanceArea) assertLegacyReservedSnapshot(ctx context.Context, source serviceEvidence, transaction string, reservation *maintenanceVolumeReservation, stopped bool) error {
	if area == nil || !exactLegacyHb12Source(source) {
		return errors.New("protected legacy source required")
	}
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return area.assertHeld()
	}
	data, err := json.Marshal(source)
	if err != nil {
		return err
	}
	topology, err := loadMaintenanceTopology(transaction, evidenceHash(data), source.Receipt, area.restoreRecordStorage(check, 16<<20), check)
	if err != nil {
		return err
	}
	coldTransaction := pairTopologyTransaction(transaction, source, source)
	cold, err := loadMaintenanceTopology(coldTransaction, evidenceHash(data), source.Receipt, area.restoreRecordStorage(check, 16<<20), check)
	if err != nil {
		return err
	}
	expectedCold := topology
	expectedCold.TransactionSHA256 = coldTransaction
	expectedCold.Mounts = make([]maintenanceMount, len(topology.Mounts))
	for i, mount := range topology.Mounts {
		expectedCold.Mounts[i] = maintenanceMount{Lease: mount.Lease}
	}
	if !reflect.DeepEqual(cold, expectedCold) {
		return errors.New("durable legacy rollback topology differs from reserved workspaces")
	}
	leases, err := readMaintenanceLeases(source.Receipt.StoreRoot, source.Receipt.UserSID, check)
	if err != nil {
		return err
	}
	if err := validateLegacyRetainedJournals(topology, leases); err != nil {
		return err
	}
	lockedChildren, err := validateLegacyReservedVolumes(topology, reservation, !stopped)
	if err != nil {
		return err
	}
	parents := map[string]bool{}
	for _, lease := range leases {
		if err := validateMaintenanceOwnership(lease, source.Receipt); err != nil {
			return err
		}
		if lockedChildren[strings.ToLower(lease.ChildPath)] {
			parents[strings.ToLower(lease.ParentPath)] = true
		}
	}
	// Include orphan/parent images and other users' images, not just valid leases.
	count := 0
	return filepath.WalkDir(source.Receipt.StoreRoot, func(name string, entry fs.DirEntry, walkErr error) error {
		if walkErr != nil {
			return walkErr
		}
		if err := check(); err != nil {
			return err
		}
		if strings.EqualFold(name, area.Path) {
			return filepath.SkipDir
		}
		count++
		if count > 100000 {
			return errors.New("legacy store inventory exceeds bound")
		}
		if err := inspectLocalPath(name); err != nil {
			return err
		}
		if entry.IsDir() || !strings.EqualFold(filepath.Ext(name), ".vhdx") {
			return nil
		}
		loaded, err := maintenanceImageLoaded(name)
		if err != nil {
			return err
		}
		if loaded {
			if lockedChildren[strings.ToLower(name)] {
				return nil
			}
			return admitLoadedBackingImage(name, parents[strings.ToLower(name)], maintenanceImageDirectlyAttached)
		}
		if !stopped && lockedChildren[strings.ToLower(name)] {
			return errors.New("reserved legacy child detached before source stop")
		}
		return nil
	})
}

func (b *boundMaintenanceService) stopLegacyRetained(ctx context.Context, area *maintenanceArea, transaction string, reservation *maintenanceVolumeReservation) error {
	if b.service == nil || b.handle == nil || !exactLegacyHb12Source(b.evidence) || reservation == nil || reservation.closed || reservation.legacySourcePID == 0 {
		return errors.New("open, exclusively locked legacy reservation required")
	}
	return b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error {
		proof := func() error {
			return area.assertLegacyReservedSnapshot(ctx, b.evidence, transaction, reservation, true)
		}
		before := func() error {
			status, err := b.handle.Query()
			if err != nil {
				return err
			}
			if status.State != svc.Running || status.ProcessId != reservation.legacySourcePID {
				return errors.New("reserved legacy source process changed")
			}
			return area.assertLegacyReservedSnapshot(ctx, b.evidence, transaction, reservation, false)
		}
		return s.stopFromState(ctx, svc.Running, before, proof)
	})
}

// Reservation failure/cancellation can leave the original live topology wholly
// unchanged. Do not try to apply a detached rollback intent to that running
// process. Verify the original topology without any detach/attach operations.
// Missing original attachments fall back to the separate cold rollback proof;
// changed owners, extra attachments and unknown journals always remain errors.
func (b *boundMaintenanceService) resumeLegacyRunningTopology(ctx context.Context, area *maintenanceArea, transaction string, original serviceEvidence, automatic bool) (bool, error) {
	if b.evidence != original || !exactLegacyHb12Source(original) {
		return false, nil
	}
	status, err := b.handle.Query()
	if err != nil {
		return false, err
	}
	if status.State != svc.Running || status.ProcessId == 0 {
		return false, nil
	}
	data, err := json.Marshal(original)
	if err != nil {
		return false, err
	}
	records := area.restoreRecordStorage(area.assertHeld, 16<<20)
	topology, err := loadMaintenanceTopology(transaction, evidenceHash(data), original.Receipt, records, area.assertHeld)
	if errors.Is(err, fs.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	err = b.service.withSourceEvidence(original, func(s *maintenanceService) error {
		check := func() error {
			if err := ctx.Err(); err != nil {
				return err
			}
			if err := s.check(); err != nil {
				return err
			}
			now, err := b.handle.Query()
			if err != nil {
				return err
			}
			if now.State != svc.Running || now.ProcessId != status.ProcessId {
				return errors.New("original legacy process changed during live rollback proof")
			}
			return nil
		}
		if err := verifyBrokerMounts(topology, original.Receipt, check, maintenanceImageLoaded, storage.FileIdentity, func(lease workspace.LeaseJournal) ([]string, error) {
			if err := verifyMaintenanceVolumeReadOnly(lease.ChildPath, lease.VolumeGUID, check); err != nil {
				return nil, err
			}
			return maintenanceMountPaths(lease.VolumeGUID)
		}); err != nil {
			return err
		}
		if automatic {
			return s.restoreStartup()
		}
		return check()
	})
	if errors.Is(err, errRestoredAttachmentMissing) {
		return false, nil
	}
	return err == nil, err
}
