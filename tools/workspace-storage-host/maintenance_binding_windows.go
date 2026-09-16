//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

// Scoped SCM connection for an already admitted protected migration. Opening
// does not stop, reconfigure or start the service. The initiating SID is taken
// from protected admission, not the identity of an over-the-shoulder administrator.
type boundMaintenanceService struct {
	service  *maintenanceService
	evidence serviceEvidence
	manager  *mgr.Mgr
	handle   *mgr.Service
}

func (b *boundMaintenanceService) close() {
	if b.handle != nil {
		_ = b.handle.Close()
		b.handle = nil
	}
	if b.manager != nil {
		_ = b.manager.Disconnect()
		b.manager = nil
	}
	b.service = nil
}

func validateMaintenanceBinding(store, initiatingSID string, expected serviceEvidence, original mgr.Config) error {
	if !filepath.IsAbs(store) || initiatingSID == "" || initiatingSID != expected.Receipt.UserSID {
		return errors.New("protected initiating user and store binding required")
	}
	if _, err := windows.StringToSid(initiatingSID); err != nil {
		return err
	}
	r := expected.Receipt
	if expected.SchemaVersion != 1 || expected.RecoveryReady || r.ServiceName != workspace.WindowsServiceName || !strings.EqualFold(filepath.Clean(r.StoreRoot), filepath.Clean(store)) {
		return errors.New("source evidence belongs to another service or store")
	}
	if original.BinaryPathName != expected.SCM.Command || original.ServiceStartName != expected.SCM.Account || original.ServiceType != expected.SCM.ServiceType || original.StartType != expected.SCM.StartType || expected.SCM.State != "running" {
		return errors.New("source SCM snapshot differs from protected admission")
	}
	return nil
}

func openBoundMaintenanceService(area *maintenanceArea, initiatingSID string, expected serviceEvidence, transaction string, armRecovery func(serviceSourceRecord) error) (*boundMaintenanceService, error) {
	return openMaintenanceServiceFromOriginal(area, initiatingSID, expected, nil, transaction, armRecovery)
}

func openMaintenanceServiceFromOriginal(area *maintenanceArea, initiatingSID string, expected serviceEvidence, recorded *mgr.Config, transaction string, armRecovery func(serviceSourceRecord) error) (*boundMaintenanceService, error) {
	if area == nil || armRecovery == nil || !migrationDigest(transaction) {
		return nil, errors.New("protected maintenance and boot recovery required")
	}
	if err := area.assertHeld(); err != nil {
		return nil, err
	}
	managerHandle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	b := &boundMaintenanceService{manager: &mgr.Mgr{Handle: managerHandle}, evidence: expected}
	reject := func(err error) (*boundMaintenanceService, error) { b.close(); return nil, err }
	name, err := windows.UTF16PtrFromString(workspace.WindowsServiceName)
	if err != nil {
		return reject(err)
	}
	// No create/delete rights and no arbitrary service name from caller input.
	handle, err := windows.OpenService(managerHandle, name, windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS|windows.SERVICE_START|windows.SERVICE_STOP|windows.SERVICE_PAUSE_CONTINUE|windows.SERVICE_CHANGE_CONFIG)
	if err != nil {
		return reject(err)
	}
	b.handle = &mgr.Service{Name: workspace.WindowsServiceName, Handle: handle}
	original, err := b.handle.Config()
	if err != nil {
		return reject(err)
	}
	if recorded != nil {
		if !maintenanceConfigMatches(original, *recorded) {
			return reject(errors.New("SCM differs from protected original configuration"))
		}
		original = *recorded
	}
	if err = validateMaintenanceBinding(filepath.Dir(area.Path), initiatingSID, expected, original); err != nil {
		return reject(err)
	}
	b.service = &maintenanceService{
		control: nativeMaintenanceService{b.handle}, original: original,
		assertHeld: func() error {
			if b.handle == nil {
				return errors.New("SCM binding released")
			}
			return area.assertHeld()
		},
		armRecovery: func(config mgr.Config) error {
			data, err := json.Marshal(expected)
			if err != nil {
				return err
			}
			record := serviceSourceRecord{1, transaction, evidenceHash(data), initiatingSID, expected, config}
			if err := area.recordServiceSource(record); err != nil {
				return err
			}
			return armRecovery(record)
		},
		holdProcess: func(pid uint32) (func(context.Context) error, func(), error) {
			return holdMaintenanceProcess(expected.Receipt.Executable, pid)
		},
	}
	// Source files stay locked only while operating, never across cold backup.
	if err = b.service.withSourceEvidence(expected, func(s *maintenanceService) error { return s.check() }); err != nil {
		return reject(err)
	}
	return b, nil
}

func (b *boundMaintenanceService) stop(ctx context.Context) error {
	if b.service == nil {
		return errors.New("SCM binding released")
	}
	return b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error { return s.stop(ctx) })
}

func (b *boundMaintenanceService) pause(ctx context.Context) error {
	if b.service == nil {
		return errors.New("SCM binding released")
	}
	return b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error { return s.pause(ctx) })
}

func (b *boundMaintenanceService) resume(ctx context.Context) error {
	if b.service == nil {
		return errors.New("SCM binding released")
	}
	return b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error { return s.resume(ctx) })
}

// Use after releasing reservation handles. Reattachment executes inside the
// serving broker, which keeps the VHDX sessions alive after this process exits.
// Protected boot recovery must use the same transaction and source pin.
func (b *boundMaintenanceService) resumeTopology(ctx context.Context, area *maintenanceArea, transaction string) error {
	return b.resumeRecordedTopology(ctx, area, transaction, b.evidence, true)
}

// Target startup consumes the original workspace topology while verifying the
// target's own component files. Automatic startup stays disabled until pair commit.
func (b *boundMaintenanceService) resumeRecordedTopology(ctx context.Context, area *maintenanceArea, transaction string, original serviceEvidence, restoreAutomatic bool) error {
	if b.service == nil || area == nil {
		return errors.New("protected SCM binding required")
	}
	data, err := json.Marshal(original)
	if err != nil {
		return err
	}
	pin := evidenceHash(data)
	records := area.restoreRecordStorage(area.assertHeld, 16<<20)
	if _, err = loadServiceSourceRecord(filepath.Dir(area.Path), transaction, pin, records, area.assertHeld); err != nil {
		return err
	}
	topology, err := loadMaintenanceTopology(transaction, pin, original.Receipt, records, area.assertHeld)
	if err != nil {
		return err
	}
	return b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error {
		if err := s.resumeWithArguments(ctx, []string{"maintenance-resume", transaction, pin}); err != nil {
			return err
		}
		verify := func() error {
			before, err := b.handle.Query()
			if err != nil {
				return err
			}
			if before.State != svc.Running || before.ProcessId == 0 {
				return errors.New("restored source process missing")
			}
			check := func() error {
				if err := ctx.Err(); err != nil {
					return err
				}
				if err := s.check(); err != nil {
					return err
				}
				after, err := b.handle.Query()
				if err != nil {
					return err
				}
				if after.State != svc.Running || after.ProcessId != before.ProcessId {
					return errors.New("restored source process changed during validation")
				}
				return nil
			}
			return verifyBrokerMounts(topology, original.Receipt, check, maintenanceImageLoaded, storage.FileIdentity, func(lease workspace.LeaseJournal) ([]string, error) {
				// Read-only identity verification: no lock, dismount or detach.
				if err := verifyMaintenanceVolumeReadOnly(lease.ChildPath, lease.VolumeGUID, check); err != nil {
					return nil, err
				}
				return maintenanceMountPaths(lease.VolumeGUID)
			})
		}
		if err := verify(); err != nil {
			if !errors.Is(err, errRestoredAttachmentMissing) {
				return err
			}
			if err = b.restartDetachedBroker(ctx, area, transaction, topology, original.Receipt); err != nil {
				return err
			}
			if err = s.resumeWithArguments(ctx, []string{"maintenance-resume", transaction, pin}); err != nil {
				return err
			}
			if err = verify(); err != nil {
				return err
			}
		}
		if restoreAutomatic {
			return s.restoreStartup()
		}
		return nil
	})
}

func (b *boundMaintenanceService) reserve(area *maintenanceArea, transaction string) (*maintenanceVolumeReservation, error) {
	if b.service == nil || b.handle == nil {
		return nil, errors.New("SCM binding released")
	}
	before, err := b.handle.Query()
	if err != nil {
		return nil, err
	}
	if before.State != svc.Paused || before.ProcessId == 0 {
		return nil, errors.New("paused source process required for topology capture")
	}
	var reservation *maintenanceVolumeReservation
	err = b.service.withSourceEvidence(b.evidence, func(s *maintenanceService) error {
		check := func() error {
			if err := s.check(); err != nil {
				return err
			}
			// withSourceEvidence already verified and retains read-only handles.
			// Do not rehash the service executable for every enumerated store entry.
			now, err := b.handle.Query()
			if err != nil {
				return err
			}
			if now.State != svc.Paused || now.ProcessId != before.ProcessId {
				return errors.New("source pause ownership changed during topology capture")
			}
			return nil
		}
		var err error
		reservation, err = area.reserveTopology(b.evidence, transaction, check)
		return err
	})
	return reservation, err
}
