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

type serviceRecoveryContext struct {
	SchemaVersion        int                  `json:"schemaVersion"`
	TransactionSHA256    string               `json:"transactionSha256"`
	SourceEvidenceSHA256 string               `json:"sourceEvidenceSha256"`
	MigrationName        string               `json:"migrationName"`
	MigrationSHA256      string               `json:"migrationSha256"`
	WorkerExecutable     string               `json:"workerExecutable"`
	WorkerSHA256         string               `json:"workerSha256"`
	ReleaseSource        nativeReleaseSource  `json:"releaseSource"`
	ApplicationRoot      string               `json:"applicationRoot"`
	SourcePointerSHA256  string               `json:"sourcePointerSha256"`
	TargetPointerSHA256  string               `json:"targetPointerSha256"`
	Owner                serviceRecoveryOwner `json:"owner"`
}

func (r serviceRecoveryContext) validate(areaPath string) error {
	if r.SchemaVersion != 1 || !migrationDigest(r.TransactionSHA256) || !migrationDigest(r.SourceEvidenceSHA256) || !migrationDigest(r.MigrationSHA256) || !migrationDigest(r.SourcePointerSHA256) || !migrationDigest(r.TargetPointerSHA256) || r.SourcePointerSHA256 == r.TargetPointerSHA256 || r.Owner.PID == 0 || r.Owner.Created == 0 {
		return errors.New("invalid recovery context identity")
	}
	if validateColdBackupName(r.MigrationName) != nil || strings.Contains(r.MigrationName, "/") || !strings.HasPrefix(r.MigrationName, "migration-") {
		return errors.New("invalid protected migration name")
	}
	if !filepath.IsAbs(r.ApplicationRoot) || filepath.Clean(r.ApplicationRoot) != r.ApplicationRoot || pathsOverlap(r.ApplicationRoot, filepath.Dir(areaPath)) {
		return errors.New("separate canonical application root required")
	}
	registration := serviceRecoveryRegistration{r.TransactionSHA256, r.MigrationSHA256, r.WorkerExecutable, r.WorkerSHA256}
	return registration.validate(areaPath)
}

func (r serviceRecoveryContext) registration(pin string) serviceRecoveryRegistration {
	return serviceRecoveryRegistration{r.TransactionSHA256, pin, r.WorkerExecutable, r.WorkerSHA256}
}

// Read-only, handle-pinned access independent of the writer's operation lock.
// A running recovery worker must be able to become ready while that writer holds
// the lock, then wait for it to be released rather than racing the live update.
func openMaintenanceReader() (string, restoreIntentStorage, func(), error) {
	root, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		return "", restoreIntentStorage{}, nil, err
	}
	root = filepath.Join(root, "UnityWorkspaceStorage")
	parents := &verifiedColdBackup{directories: map[string]windows.Handle{}}
	if err = parents.holdDirectory(root); err != nil {
		parents.close()
		return "", restoreIntentStorage{}, nil, err
	}
	directory, err := privateMaintenanceChild(parents.directories[strings.ToLower(root)], "maintenance", true, windows.FILE_OPEN)
	if err != nil {
		parents.close()
		return "", restoreIntentStorage{}, nil, err
	}
	closed := false
	close := func() {
		if !closed {
			closed = true
			_ = windows.CloseHandle(directory)
			parents.close()
		}
	}
	check := func() error {
		if closed {
			return errors.New("maintenance reader closed")
		}
		var info windows.ByHandleFileInformation
		return windows.GetFileInformationByHandle(directory, &info)
	}
	return filepath.Join(root, "maintenance"), privateRecordStorage(directory, check, 16<<20), close, nil
}

func readServiceRecoveryContext(transaction, pin, areaPath string, records restoreIntentStorage) (serviceRecoveryContext, error) {
	var result serviceRecoveryContext
	if !migrationDigest(transaction) || !migrationDigest(pin) || records.read == nil {
		return result, errors.New("pinned recovery context required")
	}
	data, err := records.read("service-recovery-" + transaction + ".json")
	if err != nil {
		return result, err
	}
	if len(data) > 64<<10 || evidenceHash(data) != pin {
		return result, errors.New("recovery context hash mismatch")
	}
	if err = decodeMaintenanceRecord(data, &result); err != nil {
		return result, err
	}
	if result.TransactionSHA256 != transaction {
		return result, errors.New("recovery transaction mismatch")
	}
	return result, result.validate(areaPath)
}

func (area *maintenanceArea) recordServiceRecovery(record serviceRecoveryContext) (serviceRecoveryRegistration, error) {
	if area == nil {
		return serviceRecoveryRegistration{}, errors.New("protected maintenance required")
	}
	if err := record.validate(area.Path); err != nil {
		return serviceRecoveryRegistration{}, err
	}
	keys, _, err := installedReleaseTrust()
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	held, admitted, err := area.openServiceCandidate(record.TransactionSHA256, record.ReleaseSource, keys)
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	defer held.close()
	if record.WorkerExecutable != filepath.Join(held.directory, "host.exe") || record.WorkerSHA256 != admitted.ExecutableSHA256 {
		return serviceRecoveryRegistration{}, errors.New("worker differs from admitted candidate")
	}
	records := area.restoreRecordStorage(area.assertHeld, 64<<10)
	source, err := loadServiceSourceRecord(filepath.Dir(area.Path), record.TransactionSHA256, record.SourceEvidenceSHA256, records, area.assertHeld)
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	if source.Evidence.Receipt.WorkspaceRoot != filepath.Join(record.ApplicationRoot, "Workspaces") || source.Evidence.Receipt.ComponentVersion != record.ReleaseSource.ComponentVersion {
		return serviceRecoveryRegistration{}, errors.New("recovery context differs from installed user binding")
	}
	journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	defer journal.closePrivate()
	owner, ownerErr := captureServiceRecoveryOwner(record.Owner.PID, source.InitiatingSID)
	if ownerErr != nil {
		return serviceRecoveryRegistration{}, ownerErr
	}
	if owner != record.Owner {
		return serviceRecoveryRegistration{}, errors.New("update owner process changed before recovery admission")
	}
	identityBytes, err := os.ReadFile(filepath.Join(journal.directory, "identity.json"))
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	var identity migrationIdentity
	if evidenceHash(identityBytes) != record.MigrationSHA256 {
		return serviceRecoveryRegistration{}, errors.New("migration identity changed")
	}
	if err = decodeMaintenanceRecord(identityBytes, &identity); err != nil {
		return serviceRecoveryRegistration{}, err
	}
	if identity.SourceEvidenceSHA256 != record.SourceEvidenceSHA256 || identity.TargetManifestSHA256 != admitted.ManifestSHA256 {
		return serviceRecoveryRegistration{}, errors.New("recovery journal differs from admitted pair")
	}
	data, err := json.Marshal(record)
	if err != nil {
		return serviceRecoveryRegistration{}, err
	}
	pin := evidenceHash(data)
	err = persistRestoreRecord("service-recovery-"+record.TransactionSHA256+".json", data, 64<<10, records, area.assertHeld)
	return record.registration(pin), err
}
