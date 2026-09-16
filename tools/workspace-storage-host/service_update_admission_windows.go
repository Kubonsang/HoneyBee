//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows/svc"
)

type serviceApplicationPointer struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Generation     uint64 `json:"generation"`
	ActiveVersion  string `json:"activeVersion"`
	ManifestSHA256 string `json:"manifestSha256"`
}

type serviceUpdateAdmission struct {
	SchemaVersion           int                 `json:"schemaVersion"`
	TransactionSHA256       string              `json:"transactionSha256"`
	OwnerPID                uint32              `json:"ownerPid"`
	ApplicationRoot         string              `json:"applicationRoot"`
	SourcePointer           []byte              `json:"sourcePointer"`
	SourceObservationSHA256 string              `json:"sourceObservationSha256"`
	TargetPointer           []byte              `json:"targetPointer"`
	Source                  nativeReleaseSource `json:"source"`
	Executable              string              `json:"executable"`
	Manifest                []byte              `json:"manifest"`
	Signature               []byte              `json:"signature"`
	Inventory               []byte              `json:"inventory"`
}

func newServiceTransactionID() (string, error) {
	var nonce [32]byte
	_, err := rand.Read(nonce[:])
	return hex.EncodeToString(nonce[:]), err
}

func validateServiceUpdatePointers(request serviceUpdateAdmission, admitted admittedServiceRelease) error {
	if request.SchemaVersion != 1 || !migrationDigest(request.TransactionSHA256) || request.OwnerPID == 0 || !filepath.IsAbs(request.ApplicationRoot) || filepath.Clean(request.ApplicationRoot) != request.ApplicationRoot {
		return errors.New("canonical application and transaction identity required")
	}
	var source, target serviceApplicationPointer
	for index, data := range [][]byte{request.SourcePointer, request.TargetPointer} {
		if len(data) == 0 || len(data) > 64<<10 {
			return errors.New("bounded application pointers required")
		}
		pointer := &source
		if index == 1 {
			pointer = &target
		}
		if err := decodeMaintenanceRecord(data, pointer); err != nil {
			return err
		}
		if pointer.SchemaVersion != 1 || pointer.Generation == 0 || pointer.Generation > 9007199254740991 || !nativeReleaseVersion.MatchString(pointer.ActiveVersion) || !migrationDigest(pointer.ManifestSHA256) {
			return errors.New("invalid application pointer")
		}
	}
	if source.ActiveVersion != request.Source.AppVersion || target.ActiveVersion != admitted.Release.Version || target.Generation != source.Generation+1 || target.ManifestSHA256 != admitted.Release.Recovery.LaunchManifestSHA256 {
		return errors.New("application selection differs from authenticated release")
	}
	return nil
}

// This admission is called only by the elevated, bounded update command. All
// machine paths are derived from KnownFolder ProgramData; caller input selects
// a signed artifact, never an arbitrary service executable/configuration.
func stageInstalledServiceUpdate(ctx context.Context, area *maintenanceArea, request serviceUpdateAdmission) (serviceRecoveryRegistration, error) {
	var empty serviceRecoveryRegistration
	keys, channel, err := installedReleaseTrust()
	if err != nil {
		return empty, err
	}
	if request.Source.Channel != channel {
		return empty, errors.New("release channel differs from installed trust")
	}
	admitted, err := admitServiceRelease(request.Manifest, request.Signature, request.Inventory, keys, request.Source)
	if err != nil {
		return empty, err
	}
	if err = validateServiceUpdatePointers(request, admitted); err != nil {
		return empty, err
	}
	check := func() error {
		if err := ctx.Err(); err != nil {
			return err
		}
		return area.assertHeld()
	}
	if err = check(); err != nil {
		return empty, err
	}
	if err = assertNoOtherServiceUpdate(area, request.TransactionSHA256); err != nil {
		return empty, err
	}
	current, err := evidenceBytes(filepath.Join(request.ApplicationRoot, "current.json"), 64<<10)
	if err != nil {
		return empty, err
	}
	if !bytes.Equal(current, request.SourcePointer) {
		return empty, errors.New("source application selection changed")
	}
	store := filepath.Dir(area.Path)
	receiptPath := filepath.Join(store, "install-receipt.json")
	receipt, err := loadReceipt(receiptPath)
	if err != nil {
		return empty, err
	}
	owner, err := captureServiceRecoveryOwner(request.OwnerPID, receipt.UserSID)
	if err != nil {
		return empty, err
	}
	identity, err := queryServiceIdentity()
	if err != nil {
		return empty, err
	}
	source, err := inspectServiceEvidence(receiptPath, receipt.UserSID, identity)
	if err != nil {
		return empty, err
	}
	if source.Receipt.StoreRoot != store || source.Receipt.WorkspaceRoot != filepath.Join(request.ApplicationRoot, "Workspaces") || source.Receipt.ComponentVersion != request.Source.ComponentVersion {
		return empty, errors.New("installed service and application user binding differs")
	}
	var observation bytes.Buffer
	encoder := json.NewEncoder(&observation)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(source); err != nil {
		return empty, err
	}
	if !migrationDigest(request.SourceObservationSHA256) || evidenceHash(bytes.TrimSuffix(observation.Bytes(), []byte("\n"))) != request.SourceObservationSHA256 {
		return empty, errors.New("live service differs from application preflight")
	}
	encodedSource, err := json.Marshal(source)
	if err != nil {
		return empty, err
	}
	sourcePin := evidenceHash(encodedSource)
	// A repeated admission must reuse the original durable journal, not create
	// a second service owner for the same app transaction.
	records := area.restoreRecordStorage(check, 64<<10)
	if data, readErr := records.read("service-recovery-" + request.TransactionSHA256 + ".json"); readErr == nil {
		record, err := readServiceRecoveryContext(request.TransactionSHA256, evidenceHash(data), area.Path, records)
		if err != nil {
			return empty, err
		}
		if record.Owner != owner || record.SourceEvidenceSHA256 != sourcePin || record.ReleaseSource != request.Source || record.ApplicationRoot != request.ApplicationRoot || record.SourcePointerSHA256 != evidenceHash(request.SourcePointer) || record.TargetPointerSHA256 != evidenceHash(request.TargetPointer) {
			return empty, errors.New("service admission retry conflicts with protected owner")
		}
		held, candidate, err := area.openServiceCandidate(request.TransactionSHA256, request.Source, keys)
		if err != nil {
			return empty, err
		}
		held.close()
		if candidate.ManifestSHA256 != admitted.ManifestSHA256 {
			return empty, errors.New("service admission retry changes release")
		}
		registration := record.registration(evidenceHash(data))
		return registration, armInstalledServiceRecovery(ctx, area, record, registration)
	} else if !os.IsNotExist(readErr) {
		return empty, readErr
	}
	bound, err := openBoundMaintenanceService(area, receipt.UserSID, source, request.TransactionSHA256, func(serviceSourceRecord) error { return errors.New("recovery has not been armed") })
	if err != nil {
		return empty, err
	}
	defer bound.close()
	status, err := bound.handle.Query()
	if err != nil {
		return empty, err
	}
	if status.State != svc.Running || status.ProcessId == 0 || status.Accepts&svc.AcceptPauseAndContinue == 0 {
		return empty, errors.New("installed service does not support recoverable maintenance pause")
	}
	candidate, err := area.stageServiceCandidate(request.TransactionSHA256, request.Executable, request.Manifest, request.Signature, request.Inventory, request.Source, keys)
	if err != nil {
		return empty, err
	}
	if _, err = area.prepareServiceReplacement(request.TransactionSHA256, source, request.Source, keys, check); err != nil {
		return empty, err
	}
	if err = area.recordServiceSource(serviceSourceRecord{1, request.TransactionSHA256, sourcePin, receipt.UserSID, source, bound.service.original}); err != nil {
		return empty, err
	}
	journal, err := area.createMigration(migrationIdentity{SchemaVersion: 3, SourceComponent: source.Receipt.ComponentVersion, TargetComponent: admitted.Release.Components.Storage.ComponentVersion, SourceEvidenceSHA256: sourcePin, TargetManifestSHA256: admitted.ManifestSHA256})
	if err != nil {
		return empty, err
	}
	defer journal.closePrivate()
	record := serviceRecoveryContext{SchemaVersion: 1, TransactionSHA256: request.TransactionSHA256, SourceEvidenceSHA256: sourcePin, MigrationName: filepath.Base(journal.directory), MigrationSHA256: journal.identitySHA256, WorkerExecutable: filepath.Join(area.Path, candidate.PayloadName, "host.exe"), WorkerSHA256: admitted.ExecutableSHA256, ReleaseSource: request.Source, ApplicationRoot: request.ApplicationRoot, SourcePointerSHA256: evidenceHash(request.SourcePointer), TargetPointerSHA256: evidenceHash(request.TargetPointer), Owner: owner}
	registration, err := area.recordServiceRecovery(record)
	if err != nil {
		return empty, err
	}
	return registration, armInstalledServiceRecovery(ctx, area, record, registration)
}

func assertNoOtherServiceUpdate(area *maintenanceArea, transaction string) error {
	entries, err := os.ReadDir(area.Path)
	if err != nil {
		return err
	}
	if len(entries) > 10000 {
		return errors.New("service maintenance evidence exceeds bound")
	}
	records := area.restoreRecordStorage(area.assertHeld, 64<<10)
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "service-recovery-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		tx := strings.TrimSuffix(strings.TrimPrefix(name, "service-recovery-"), ".json")
		if !migrationDigest(tx) {
			return errors.New("invalid protected service recovery entry")
		}
		if tx == transaction {
			continue
		}
		data, err := records.read(name)
		if err != nil {
			return err
		}
		record, err := readServiceRecoveryContext(tx, evidenceHash(data), area.Path, records)
		if err != nil {
			return err
		}
		journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
		if err != nil {
			return err
		}
		state := journal.state()
		journal.closePrivate()
		if state != "Committed" && state != "RolledBack" && state != "Resumed" && state != "Failed" {
			return errors.New("another service update must recover before a new admission")
		}
	}
	return area.assertHeld()
}

func armInstalledServiceRecovery(ctx context.Context, area *maintenanceArea, record serviceRecoveryContext, registration serviceRecoveryRegistration) error {
	keys, _, err := installedReleaseTrust()
	if err != nil {
		return err
	}
	held, admitted, err := area.openServiceCandidate(record.TransactionSHA256, record.ReleaseSource, keys)
	if err != nil {
		return err
	}
	defer held.close()
	if admitted.ExecutableSHA256 != registration.ExecutableSHA256 || filepath.Join(held.directory, "host.exe") != registration.Executable {
		return errors.New("recovery worker candidate changed")
	}
	return rearmNativeRecoveryService(ctx, area, registration, func() error {
		_, err := readServiceRecoveryContext(record.TransactionSHA256, registration.ContextSHA256, area.Path, area.restoreRecordStorage(area.assertHeld, 64<<10))
		return err
	})
}
