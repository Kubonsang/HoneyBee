//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

func serviceReplacementFixture(t *testing.T) (serviceReplacementRecord, string, admittedServiceRelease, restoreIntentStorage) {
	t.Helper()
	name, receipt, scm := evidenceFixture(t)
	evidence, err := inspectServiceEvidence(name, receipt.UserSID, scm)
	if err != nil {
		t.Fatal(err)
	}
	area := filepath.Join(receipt.StoreRoot, "maintenance")
	admitted := admittedServiceRelease{ManifestSHA256: evidenceHash([]byte("signed release fixture")), ExecutableSHA256: evidenceHash([]byte("new-host")), ExecutableSize: 8}
	admitted.Release.Components.Storage.ComponentVersion = "fixture-new-component"
	target, bytes, err := replacementReceipt(receipt, admitted)
	if err != nil {
		t.Fatal(err)
	}
	sourceBytes, _ := json.Marshal(evidence)
	tx := strings.Repeat("a", 64)
	record := serviceReplacementRecord{1, tx, evidenceHash(sourceBytes), admitted.ManifestSHA256, "service-files-" + tx + "-fixture", evidence, target, evidenceHash(bytes)}
	directory := filepath.Join(area, record.PayloadName)
	if err = os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "host.exe"), []byte("new-host"), 0600); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "receipt.json"), bytes, 0600); err != nil {
		t.Fatal(err)
	}
	_, records := restoreIntentFixture(t)
	return record, area, admitted, records
}

func TestServiceReplacementNativePairReplayPreservesOriginals(t *testing.T) {
	record, area, admitted, records := serviceReplacementFixture(t)
	check := func() error { return nil }
	originalHost, err := os.ReadFile(record.Source.Receipt.Executable)
	if err != nil {
		t.Fatal(err)
	}
	originalReceipt, err := os.ReadFile(filepath.Join(record.Source.Receipt.StoreRoot, "install-receipt.json"))
	if err != nil {
		t.Fatal(err)
	}
	originalConfig, err := os.ReadFile(record.Source.Receipt.ConfigPath)
	if err != nil {
		t.Fatal(err)
	}
	workspaceData := filepath.Join(record.Source.Receipt.StoreRoot, "preserved-workspace-data")
	if err = os.WriteFile(workspaceData, []byte("user data"), 0600); err != nil {
		t.Fatal(err)
	}
	interrupt := true
	apply := func(paths restoreFilePaths, oldHash, newHash string) error {
		if _, err := records.read("service-replacement-" + record.TransactionSHA256 + ".json"); err != nil {
			t.Fatal("pair not persisted before replacement", err)
		}
		err := applyRestoreFile(paths, oldHash, newHash, check, func(p restoreFilePaths, a, b string) error {
			return persistRestoreFileIntent(restoreFileIntent{1, "service-replace-" + record.TransactionSHA256, p, a, b}, records, check)
		})
		if err != nil {
			return err
		}
		if interrupt {
			interrupt = false
			return errors.New("process terminated after host publication")
		}
		return nil
	}
	if err = executeServiceReplacement(record, area, admitted, records, check, apply); err == nil {
		t.Fatal("interruption ignored")
	}
	if current, _ := os.ReadFile(filepath.Join(record.Source.Receipt.StoreRoot, "install-receipt.json")); string(current) != string(originalReceipt) {
		t.Fatal("receipt unexpectedly replaced")
	}
	if err = executeServiceReplacement(record, area, admitted, records, check, apply); err != nil {
		t.Fatal(err)
	}
	if err = executeServiceReplacement(record, area, admitted, records, check, apply); err != nil {
		t.Fatal("completed replay", err)
	}
	for _, file := range serviceReplacementFiles(record, area) {
		bytes, err := os.ReadFile(file.Paths.Target)
		if err != nil || evidenceHash(bytes) != file.Target {
			t.Fatal("target pair mismatch", err)
		}
		bytes, err = os.ReadFile(file.Paths.Previous)
		if err != nil || evidenceHash(bytes) != file.Source {
			t.Fatal("original pair lost", err)
		}
	}
	if evidenceHash(originalHost) != record.Source.ExecutableSHA256 {
		t.Fatal("fixture identity mismatch")
	}
	if bytes, _ := os.ReadFile(record.Source.Receipt.ConfigPath); string(bytes) != string(originalConfig) {
		t.Fatal("config changed")
	}
	if bytes, _ := os.ReadFile(workspaceData); string(bytes) != "user data" {
		t.Fatal("workspace data changed")
	}
}

func TestServiceReplacementRefusesMissingAuthorityBeforeFileMutation(t *testing.T) {
	for _, scenario := range []string{"persist", "quiescence", "source", "target", "paths", "manifest"} {
		t.Run(scenario, func(t *testing.T) {
			record, area, admitted, records := serviceReplacementFixture(t)
			check := func() error { return nil }
			switch scenario {
			case "persist":
				records.publish = func(*os.File, string, string) error { return errors.New("journal publication failed") }
			case "quiescence":
				check = func() error { return errors.New("service running or boot recovery not registered") }
			case "source":
				record.Source.Receipt.UserSID = "S-1-5-18"
			case "target":
				record.Target.ComponentVersion = "unapproved"
			case "paths":
				record.PayloadName = "../user-payload"
			case "manifest":
				record.TargetManifestSHA256 = strings.Repeat("b", 64)
			}
			if err := executeServiceReplacement(record, area, admitted, records, check, func(restoreFilePaths, string, string) error {
				t.Fatal("mutated files without complete authority")
				return nil
			}); err == nil {
				t.Fatal("unsafe replacement admitted")
			}
		})
	}
}

func TestServiceReplacementRejectsConflictingRetry(t *testing.T) {
	record, area, admitted, records := serviceReplacementFixture(t)
	check := func() error { return nil }
	if err := executeServiceReplacement(record, area, admitted, records, check, func(restoreFilePaths, string, string) error { return errors.New("interrupted before files") }); err == nil {
		t.Fatal("missing interruption")
	}
	record.PayloadName += "-different"
	if err := executeServiceReplacement(record, area, admitted, records, check, func(restoreFilePaths, string, string) error { t.Fatal("changed transaction payload"); return nil }); err == nil {
		t.Fatal("conflicting retry accepted")
	}
}

func TestServiceFileRollbackAcrossNativePublicationBoundaries(t *testing.T) {
	for _, scenario := range []string{"prepared", "preserved-host", "published-host", "complete", "damaged-target", "rollback-interrupted"} {
		t.Run(scenario, func(t *testing.T) {
			record, area, admitted, records := serviceReplacementFixture(t)
			check := func() error { return nil }
			data, _ := json.Marshal(record)
			if err := persistRestoreRecord("service-replacement-"+record.TransactionSHA256+".json", data, 64<<10, records, check); err != nil {
				t.Fatal(err)
			}
			files := serviceReplacementFiles(record, area)
			native := func(paths restoreFilePaths, oldHash, newHash string) error {
				return applyRestoreFile(paths, oldHash, newHash, check, func(p restoreFilePaths, a, b string) error {
					return persistRestoreFileIntent(restoreFileIntent{1, "forward-" + record.TransactionSHA256, p, a, b}, records, check)
				})
			}
			switch scenario {
			case "preserved-host":
				// Exact filesystem state after the first durable rename; no new
				// executable has been published or run.
				if err := os.Rename(files[0].Paths.Target, files[0].Paths.Previous); err != nil {
					t.Fatal(err)
				}
			case "published-host":
				if err := native(files[0].Paths, files[0].Source, files[0].Target); err != nil {
					t.Fatal(err)
				}
			case "complete", "damaged-target", "rollback-interrupted":
				if err := executeServiceReplacement(record, area, admitted, records, check, native); err != nil {
					t.Fatal(err)
				}
				if scenario == "damaged-target" {
					if err := os.WriteFile(files[0].Paths.Target, []byte("damaged target evidence"), 0600); err != nil {
						t.Fatal(err)
					}
				}
			}
			if scenario == "rollback-interrupted" {
				broken := records
				count := 0
				broken.publish = func(file *os.File, temporary, name string) error {
					if strings.HasPrefix(name, "service-rollback-file-") {
						count++
						if count == 2 {
							return errors.New("restart between restored files")
						}
					}
					return records.publish(file, temporary, name)
				}
				if err := executeServiceFileRollback(record, area, admitted, broken, check); err == nil {
					t.Fatal("rollback interruption ignored")
				}
			}
			if err := executeServiceFileRollback(record, area, admitted, records, check); err != nil {
				t.Fatal(err)
			}
			if err := executeServiceFileRollback(record, area, admitted, records, check); err != nil {
				t.Fatal("rollback replay", err)
			}
			for _, file := range files {
				bytes, err := os.ReadFile(file.Paths.Target)
				if err != nil || evidenceHash(bytes) != file.Source {
					t.Fatal("original service pair not restored", err)
				}
			}
			if scenario == "damaged-target" {
				bytes, err := os.ReadFile(filepath.Join(area, record.PayloadName, "rejected-host.exe"))
				if err != nil || string(bytes) != "damaged target evidence" {
					t.Fatal("damaged bytes were not preserved", err)
				}
			}
		})
	}
}

func TestServiceFileRollbackCannotInventAuthority(t *testing.T) {
	record, area, admitted, records := serviceReplacementFixture(t)
	if err := executeServiceFileRollback(record, area, admitted, records, func() error { return nil }); err == nil {
		t.Fatal("rollback invented replacement authority")
	}
	for _, file := range serviceReplacementFiles(record, area) {
		bytes, err := os.ReadFile(file.Paths.Target)
		if err != nil || evidenceHash(bytes) != file.Source {
			t.Fatal("changed unadmitted service", err)
		}
	}
}
