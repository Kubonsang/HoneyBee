//go:build windows

package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"path/filepath"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
)

// Immutable original settings, separate from current SCM state. Disabled or
// demand-start observed after reboot must never become the original policy.
type serviceSourceRecord struct {
	SchemaVersion        int             `json:"schemaVersion"`
	TransactionSHA256    string          `json:"transactionSha256"`
	SourceEvidenceSHA256 string          `json:"sourceEvidenceSha256"`
	InitiatingSID        string          `json:"initiatingSid"`
	Evidence             serviceEvidence `json:"evidence"`
	Original             mgr.Config      `json:"original"`
}

func validateServiceSourceRecord(record serviceSourceRecord, store, transaction, sourcePin string) error {
	if record.SchemaVersion != 1 || !migrationDigest(transaction) || !migrationDigest(sourcePin) || record.TransactionSHA256 != transaction || record.SourceEvidenceSHA256 != sourcePin {
		return errors.New("protected source recovery identity mismatch")
	}
	data, err := json.Marshal(record.Evidence)
	if err != nil {
		return err
	}
	if evidenceHash(data) != sourcePin {
		return errors.New("source recovery evidence changed")
	}
	if record.Original.StartType != mgr.StartAutomatic || record.Original.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS || record.Original.ServiceStartName != "LocalSystem" || record.Original.Password != "" {
		return errors.New("unsupported original service configuration")
	}
	return validateMaintenanceBinding(store, record.InitiatingSID, record.Evidence, record.Original)
}

func persistServiceSourceRecord(record serviceSourceRecord, store string, storage restoreIntentStorage, check func() error) error {
	if err := validateServiceSourceRecord(record, store, record.TransactionSHA256, record.SourceEvidenceSHA256); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	return persistRestoreRecord("service-source-"+record.TransactionSHA256+".json", data, 64<<10, storage, check)
}

func loadServiceSourceRecord(store, transaction, sourcePin string, storage restoreIntentStorage, check func() error) (serviceSourceRecord, error) {
	var result serviceSourceRecord
	if !migrationDigest(transaction) || !migrationDigest(sourcePin) || storage.read == nil || check == nil {
		return result, errors.New("protected source record authority required")
	}
	if err := check(); err != nil {
		return result, err
	}
	data, err := storage.read("service-source-" + transaction + ".json")
	if err != nil {
		return result, err
	}
	if len(data) > 64<<10 {
		return result, errors.New("source record exceeds bound")
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err = decoder.Decode(&result); err != nil {
		return result, err
	}
	if err = decoder.Decode(new(any)); err != io.EOF {
		return result, errors.New("trailing source recovery data")
	}
	if err = validateServiceSourceRecord(result, store, transaction, sourcePin); err != nil {
		return result, err
	}
	return result, check()
}

func (area *maintenanceArea) recordServiceSource(record serviceSourceRecord) error {
	if area == nil {
		return errors.New("protected maintenance required")
	}
	return persistServiceSourceRecord(record, filepath.Dir(area.Path), area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld)
}

// Call only after the native journal chooses source recovery and mount topology
// has been restored. This factory only opens/validates; it does not start a service.
func openRecoveryMaintenanceService(area *maintenanceArea, transaction, sourcePin string, armRecovery func(serviceSourceRecord) error) (*boundMaintenanceService, error) {
	if area == nil {
		return nil, errors.New("protected maintenance required")
	}
	record, err := loadServiceSourceRecord(filepath.Dir(area.Path), transaction, sourcePin, area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld)
	if err != nil {
		return nil, err
	}
	return openMaintenanceServiceFromOriginal(area, record.InitiatingSID, record.Evidence, &record.Original, transaction, armRecovery)
}
