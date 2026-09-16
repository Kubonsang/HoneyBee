//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"testing"

	"golang.org/x/sys/windows/svc/mgr"
)

func TestServiceSourceRecordPreservesOriginalAcrossReplay(t *testing.T) {
	_, storage := restoreIntentFixture(t)
	p, receipt, scm := evidenceFixture(t)
	evidence, err := inspectServiceEvidence(p, receipt.UserSID, scm)
	if err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(evidence)
	if err != nil {
		t.Fatal(err)
	}
	transaction, pin := evidenceHash([]byte("migration")), evidenceHash(data)
	original := mgr.Config{BinaryPathName: scm.Command, StartType: scm.StartType, ServiceStartName: scm.Account, ServiceType: scm.ServiceType}
	record := serviceSourceRecord{1, transaction, pin, receipt.UserSID, evidence, original}
	check := func() error { return nil }
	broken := storage
	broken.publish = func(*os.File, string, string) error { return errors.New("injected publication interruption") }
	if err := persistServiceSourceRecord(record, receipt.StoreRoot, broken, check); err == nil {
		t.Fatal("interruption ignored")
	}
	if _, err := loadServiceSourceRecord(receipt.StoreRoot, transaction, pin, storage, check); !os.IsNotExist(err) {
		t.Fatal("partial record became authoritative", err)
	}
	if err := persistServiceSourceRecord(record, receipt.StoreRoot, storage, check); err != nil {
		t.Fatal(err)
	}
	if err := persistServiceSourceRecord(record, receipt.StoreRoot, storage, check); err != nil {
		t.Fatal(err)
	}
	loaded, err := loadServiceSourceRecord(receipt.StoreRoot, transaction, pin, storage, check)
	if err != nil || loaded.Original.StartType != mgr.StartAutomatic {
		t.Fatal(loaded, err)
	}
	changed := record
	changed.Original.StartType = mgr.StartDisabled
	if err := persistServiceSourceRecord(changed, receipt.StoreRoot, storage, check); err == nil {
		t.Fatal("disabled observed state replaced original")
	}
	if _, err := loadServiceSourceRecord(receipt.StoreRoot, transaction, evidenceHash([]byte("other")), storage, check); err == nil {
		t.Fatal("wrong source accepted")
	}
	if _, err := loadServiceSourceRecord(receipt.StoreRoot, transaction, pin, storage, func() error { return errors.New("ownership lost") }); err == nil {
		t.Fatal("lost ownership accepted")
	}
}
