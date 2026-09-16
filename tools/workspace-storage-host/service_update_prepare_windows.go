//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func loadRecoverySource(area *maintenanceArea, record serviceRecoveryContext) (serviceSourceRecord, error) {
	return loadServiceSourceRecord(filepath.Dir(area.Path), record.TransactionSHA256, record.SourceEvidenceSHA256, area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld)
}

func loadRecoveryReplacement(area *maintenanceArea, record serviceRecoveryContext, source serviceEvidence) (serviceReplacementRecord, error) {
	var result serviceReplacementRecord
	data, err := area.restoreRecordStorage(area.assertHeld, 64<<10).read("service-replacement-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return result, err
	}
	if err = decodeMaintenanceRecord(data, &result); err != nil {
		return result, err
	}
	if result.TransactionSHA256 != record.TransactionSHA256 || result.SourceEvidenceSHA256 != record.SourceEvidenceSHA256 || result.Source != source {
		return result, errors.New("replacement differs from protected recovery source")
	}
	return result, nil
}

func stoppedServiceProof(ctx context.Context, area *maintenanceArea, bound *boundMaintenanceService) error {
	if err := ctx.Err(); err != nil {
		return err
	}
	if err := area.assertHeld(); err != nil {
		return err
	}
	config, err := bound.handle.Config()
	if err != nil {
		return err
	}
	if !maintenanceConfigMatches(config, bound.service.original) || config.StartType != mgr.StartDisabled {
		return errors.New("stopped service startup/configuration changed")
	}
	status, err := bound.handle.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Stopped || status.ProcessId != 0 {
		return errInstalledServiceProcessAlive
	}
	return assertInstalledServiceProcessExited(bound.evidence.Receipt.Executable)
}

func resumeInstalledPair(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext, source serviceSourceRecord, expected serviceEvidence, automatic bool, arm func(serviceSourceRecord) error) error {
	tx := record.TransactionSHA256
	if expected != source.Evidence {
		tx = evidenceHash([]byte("target-recovery:" + tx))
	}
	bound, err := openMaintenanceServiceFromOriginal(area, source.InitiatingSID, expected, &source.Original, tx, arm)
	if err != nil {
		return err
	}
	defer bound.close()
	_, err = area.restoreRecordStorage(area.assertHeld, 16<<20).read("service-topology-" + record.TransactionSHA256 + ".json")
	if os.IsNotExist(err) {
		status, err := bound.handle.Query()
		if err != nil {
			return err
		}
		if expected != source.Evidence || (status.State != svc.Running && status.State != svc.Paused) {
			return errors.New("stopped service has no original topology")
		}
		return bound.resume(ctx)
	}
	if err != nil {
		return err
	}
	return bound.resumeRecordedTopology(ctx, area, record.TransactionSHA256, source.Evidence, automatic)
}

// Concrete forward transaction. Only a previously authenticated, armed native
// admission can reach Pause. The app pointer stays on source until this returns.
func prepareInstalledServiceUpdate(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext, pin string) error {
	if err := requireServiceUpdateOwner(area, record, pin); err != nil {
		return err
	}
	source, err := loadRecoverySource(area, record)
	if err != nil {
		return err
	}
	replacement, err := loadRecoveryReplacement(area, record, source.Evidence)
	if err != nil {
		return err
	}
	keys, _, err := installedReleaseTrust()
	if err != nil {
		return err
	}
	registration := record.registration(pin)
	arm := func(serviceSourceRecord) error { return verifyNativeRecoveryRegistration(registration) }
	if err = arm(source); err != nil {
		return err
	}
	journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
	if err != nil {
		return err
	}
	defer journal.closePrivate()
	if journal.state() == "ReadyForAppCommit" {
		return resumeInstalledPair(ctx, area, record, source, targetReplacementEvidence(replacement), false, arm)
	}
	if journal.state() != "Prepared" {
		return errors.New("interrupted service preparation requires recovery")
	}
	bound, err := openMaintenanceServiceFromOriginal(area, source.InitiatingSID, source.Evidence, &source.Original, record.TransactionSHA256, arm)
	if err != nil {
		return err
	}
	defer bound.close()
	var reservation *maintenanceVolumeReservation
	release := func() error {
		if reservation == nil {
			return nil
		}
		err := reservation.close()
		reservation = nil
		return err
	}
	defer release()
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return area.assertHeld()
	}
	quiet := func() error { return stoppedServiceProof(ctx, area, bound) }
	resumeSource := func() error {
		if err := release(); err != nil {
			return err
		}
		return resumeInstalledPair(ctx, area, record, source, source.Evidence, true, arm)
	}
	validateSource := func() error {
		held, err := holdMaintenanceSource(source.Evidence, check)
		if err != nil {
			return err
		}
		defer held.close()
		config, err := bound.handle.Config()
		if err != nil {
			return err
		}
		if !maintenanceConfigMatches(config, source.Original) {
			return errors.New("source service configuration changed")
		}
		status, err := bound.handle.Query()
		if err != nil {
			return err
		}
		if status.State != svc.Running || status.ProcessId == 0 {
			return errors.New("source service is not running")
		}
		return check()
	}
	hooks := migrationHooks{
		AssertHeld: check, ValidateSource: validateSource,
		AppSelection: func() (string, error) { return recoveryApplicationSelection(record) },
		PauseSource:  func() error { return bound.pause(ctx) },
		ReserveDisks: func() error {
			var err error
			reservation, err = bound.reserve(area, record.TransactionSHA256)
			return err
		},
		StopSource: func() error { return bound.stop(ctx) },
		QuiesceDisks: func() error {
			if reservation == nil {
				return errors.New("pre-stop reservation missing")
			}
			err := reservation.quiesce(quiet)
			reservation = nil
			return err
		},
		CaptureBackup: func() error {
			nonce, err := newServiceTransactionID()
			if err != nil {
				return err
			}
			name := "service-backup-" + record.TransactionSHA256 + "-" + nonce
			backupPin, err := area.captureStoreBackup(name, quiet)
			if err != nil {
				return err
			}
			data, err := json.Marshal(serviceBackupRecord{1, record.TransactionSHA256, record.SourceEvidenceSHA256, name, backupPin})
			if err != nil {
				return err
			}
			return persistRestoreRecord("service-backup-"+record.TransactionSHA256+".json", data, 64<<10, area.restoreRecordStorage(quiet, 64<<10), quiet)
		},
		VerifyBackup: func() error { return verifyRecoveryBackup(area, record, source.Evidence) },
		ResumeSource: resumeSource,
		Replace: func() error {
			if err := quiet(); err != nil {
				return err
			}
			if err := verifyRecoveryBackup(area, record, source.Evidence); err != nil {
				return err
			}
			return area.replaceServiceFiles(replacement, record.ReleaseSource, keys, func() error {
				if err := quiet(); err != nil {
					return err
				}
				return arm(source)
			})
		},
		ValidateTarget: func() error {
			return resumeInstalledPair(ctx, area, record, source, targetReplacementEvidence(replacement), false, arm)
		},
		RestoreSource: func() error {
			if err := release(); err != nil {
				return err
			}
			if held, err := holdMaintenanceSource(source.Evidence, check); err == nil {
				held.close()
				return resumeSource()
			}
			assertQuiet, closeControl, err := quiesceRecoveryService(ctx, area, record, source, replacement, arm)
			if err != nil {
				return err
			}
			defer closeControl()
			if err = area.rollbackServiceFiles(replacement, record.ReleaseSource, keys, assertQuiet); err != nil {
				return err
			}
			return resumeSource()
		},
	}
	if err = journal.run(hooks); err != nil {
		// Let the already running worker finish after this command releases the
		// lock, even if the unelevated coordinator is still alive awaiting outcome.
		return errors.Join(err, releaseServiceUpdateOwner(area, record, pin))
	}
	return nil
}
