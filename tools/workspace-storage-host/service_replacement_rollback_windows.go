//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

type serviceFileRollback struct {
	SchemaVersion int              `json:"schemaVersion"`
	Transaction   string           `json:"transaction"`
	Paths         restoreFilePaths `json:"paths"`
	Unchanged     bool             `json:"unchanged"`
	CurrentSHA256 string           `json:"currentSha256"`
	SourceSHA256  string           `json:"sourceSha256"`
}

// Choose a rollback step exactly once, before moving anything. In particular,
// interruption between preserving the old host and publishing its replacement
// has an absent target, not an unknown target and not a reason to install the
// rejected new host just to undo it.
func restoreReplacedServiceFile(transaction string, forward restoreFilePaths, sourceHash, targetHash string, records restoreIntentStorage, check func() error) error {
	if !migrationDigest(transaction) || !migrationDigest(sourceHash) || !migrationDigest(targetHash) || check == nil || records.read == nil {
		return errors.New("protected service rollback required")
	}
	if err := check(); err != nil {
		return err
	}
	paths := restoreFilePaths{forward.Target, forward.Previous, filepath.Join(filepath.Dir(forward.Previous), "rejected-"+filepath.Base(forward.Candidate))}
	name := "service-rollback-file-" + evidenceHash([]byte(transaction+"\n"+strings.ToLower(paths.Target))) + ".json"
	var step serviceFileRollback
	data, err := records.read(name)
	if err == nil {
		if err = decodeMaintenanceRecord(data, &step); err != nil {
			return err
		}
	} else if os.IsNotExist(err) {
		held := &restoreFileHandles{files: map[string]*os.File{}, parents: &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}}
		defer held.close()
		if err = check(); err != nil {
			return err
		}
		target, err := held.open(paths.Target)
		if err != nil {
			return err
		}
		original, err := held.open(paths.Candidate)
		if err != nil {
			return err
		}
		rejected, err := held.open(paths.Previous)
		if err != nil {
			return err
		}
		if rejected != "" {
			return errors.New("unrecorded rejected service file")
		}
		step = serviceFileRollback{1, transaction, paths, false, target, sourceHash}
		switch {
		case target == sourceHash && original == "":
			step.Unchanged = true
		case (migrationDigest(target) || target == "") && original == sourceHash:
			// The protected original proves ownership. Preserve even a damaged
			// installed target under its observed hash; never execute its bytes.
		default:
			return errors.New("service files do not match an admitted rollback state")
		}
		data, err = json.Marshal(step)
		if err != nil {
			return err
		}
		if err = persistRestoreRecord(name, data, 64<<10, records, check); err != nil {
			return err
		}
		held.close()
	} else {
		return err
	}
	if step.SchemaVersion != 1 || step.Transaction != transaction || step.Paths != paths || step.SourceSHA256 != sourceHash || (step.Unchanged && step.CurrentSHA256 != sourceHash) || (!step.Unchanged && step.CurrentSHA256 != "" && !migrationDigest(step.CurrentSHA256)) {
		return errors.New("service rollback step conflicts with protected pair")
	}
	if step.Unchanged {
		held := &restoreFileHandles{files: map[string]*os.File{}, parents: &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}}
		defer held.close()
		actual, err := held.open(paths.Target)
		if err != nil {
			return err
		}
		if actual != sourceHash {
			return errors.New("untouched service file changed during rollback")
		}
		return check()
	}
	return applyRestoreFile(paths, step.CurrentSHA256, sourceHash, check, func(restoreFilePaths, string, string) error {
		return persistRestoreRecord(name, data, 64<<10, records, check)
	})
}

func executeServiceFileRollback(record serviceReplacementRecord, areaPath string, admitted admittedServiceRelease, records restoreIntentStorage, check func() error) error {
	if check == nil || records.read == nil {
		return errors.New("protected rollback authority required")
	}
	if err := check(); err != nil {
		return err
	}
	if err := validateServiceReplacement(record, areaPath, admitted); err != nil {
		return err
	}
	// Recovery must consume existing authority; it cannot invent a pair receipt.
	data, err := records.read("service-replacement-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return err
	}
	var stored serviceReplacementRecord
	if err = decodeMaintenanceRecord(data, &stored); err != nil {
		return err
	}
	if stored != record {
		return errors.New("rollback differs from protected replacement")
	}
	for _, file := range serviceReplacementFiles(record, areaPath) {
		if err = check(); err != nil {
			return err
		}
		if err = restoreReplacedServiceFile(record.TransactionSHA256, file.Paths, file.Source, file.Target, records, check); err != nil {
			return err
		}
	}
	return check()
}

func (area *maintenanceArea) rollbackServiceFiles(record serviceReplacementRecord, source nativeReleaseSource, keys [][]byte, assertRecoverable func() error) error {
	if area == nil || assertRecoverable == nil {
		return errors.New("protected service rollback required")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertRecoverable()
	}
	if err := check(); err != nil {
		return err
	}
	records := area.restoreRecordStorage(check, serviceCandidateRecordLimit)
	data, err := records.read("service-candidate-" + record.TransactionSHA256 + ".json")
	if err != nil {
		return err
	}
	var candidate serviceCandidateRecord
	if err = decodeMaintenanceRecord(data, &candidate); err != nil {
		return err
	}
	// Authenticate metadata, not the rejected target executable. A damaged target
	// must not prevent restoration of independently pinned original bytes.
	admitted, err := validateCandidateRecord(candidate, record.TransactionSHA256, source, keys)
	if err != nil {
		return err
	}
	sourceRecord, err := loadServiceSourceRecord(filepath.Dir(area.Path), record.TransactionSHA256, record.SourceEvidenceSHA256, records, check)
	if err != nil {
		return err
	}
	if sourceRecord.Evidence != record.Source || source.ComponentVersion != record.Source.Receipt.ComponentVersion {
		return errors.New("rollback source evidence mismatch")
	}
	return executeServiceFileRollback(record, area.Path, admitted, records, check)
}
