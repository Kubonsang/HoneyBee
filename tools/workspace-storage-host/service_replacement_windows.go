//go:build windows

package main

import (
	"bytes"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"golang.org/x/sys/windows"
)

// Application files and workspace data are never replacement targets. The
// service config stays byte-identical in v1; schema conversion needs a separate
// admitted migration, not a caller-provided replacement config.
type serviceReplacementRecord struct {
	SchemaVersion        int             `json:"schemaVersion"`
	TransactionSHA256    string          `json:"transactionSha256"`
	SourceEvidenceSHA256 string          `json:"sourceEvidenceSha256"`
	TargetManifestSHA256 string          `json:"targetManifestSha256"`
	PayloadName          string          `json:"payloadName"`
	Source               serviceEvidence `json:"source"`
	Target               installReceipt  `json:"target"`
	TargetReceiptSHA256  string          `json:"targetReceiptSha256"`
}

func (area *maintenanceArea) prepareServiceReplacement(transaction string, expected serviceEvidence, source nativeReleaseSource, keys [][]byte, assertReady func() error) (serviceReplacementRecord, error) {
	var record serviceReplacementRecord
	if area == nil || assertReady == nil {
		return record, errors.New("protected service preparation required")
	}
	check := func() error {
		if err := area.assertHeld(); err != nil {
			return err
		}
		return assertReady()
	}
	if err := check(); err != nil {
		return record, err
	}
	held, admitted, err := area.openServiceCandidate(transaction, source, keys)
	if err != nil {
		return record, err
	}
	defer held.close()
	sourceBytes, err := json.Marshal(expected)
	if err != nil {
		return record, err
	}
	records := area.restoreRecordStorage(check, 64<<10)
	existing, err := records.read("service-replacement-" + transaction + ".json")
	if err == nil {
		if err = decodeMaintenanceRecord(existing, &record); err != nil {
			return record, err
		}
		if record.Source != expected || record.TransactionSHA256 != transaction {
			return record, errors.New("replacement retry source changed")
		}
		return record, validateServiceReplacement(record, area.Path, admitted)
	}
	if !os.IsNotExist(err) {
		return record, err
	}
	guard, err := holdMaintenanceSource(expected, check)
	if err != nil {
		return record, err
	}
	defer guard.close()
	target, receiptBytes, err := replacementReceipt(expected.Receipt, admitted)
	if err != nil {
		return record, err
	}
	var nonce [16]byte
	if _, err = rand.Read(nonce[:]); err != nil {
		return record, err
	}
	name := "service-files-" + transaction + "-" + hex.EncodeToString(nonce[:])
	record = serviceReplacementRecord{1, transaction, evidenceHash(sourceBytes), admitted.ManifestSHA256, name, expected, target, evidenceHash(receiptBytes)}
	if source.ComponentVersion != expected.Receipt.ComponentVersion {
		return record, errors.New("replacement source component mismatch")
	}
	if err = validateServiceReplacement(record, area.Path, admitted); err != nil {
		return record, err
	}
	volume, err := windows.UTF16PtrFromString(area.Path)
	if err != nil {
		return record, err
	}
	var available uint64
	if err = windows.GetDiskFreeSpaceEx(volume, &available, nil, nil); err != nil {
		return record, err
	}
	if admitted.ExecutableSize <= 0 || available < uint64(admitted.ExecutableSize)+uint64(len(receiptBytes))+(64<<20) {
		return record, errors.New("insufficient space for service replacement and recovery headroom")
	}
	directory, err := privateMaintenanceChild(area.directory, name, true, windows.FILE_CREATE)
	if err != nil {
		return record, err
	}
	defer windows.CloseHandle(directory)
	write := func(name string, input io.Reader, size int64, pin string) error {
		if err := check(); err != nil {
			return err
		}
		handle, err := privateMaintenanceChild(directory, name, false, windows.FILE_CREATE)
		if err != nil {
			return err
		}
		file := os.NewFile(uintptr(handle), name)
		hash := sha256.New()
		count, copyErr := io.Copy(io.MultiWriter(file, hash), io.LimitReader(input, size+1))
		syncErr, closeErr := file.Sync(), file.Close()
		if err = errors.Join(copyErr, syncErr, closeErr); err != nil {
			return err
		}
		if count != size || hex.EncodeToString(hash.Sum(nil)) != pin {
			return errors.New("replacement payload copy differs from admission")
		}
		return check()
	}
	host := held.files[filepath.Join(held.directory, "host.exe")]
	if host == nil {
		return record, errors.New("authenticated host handle missing")
	}
	if err = write("host.exe", io.NewSectionReader(host, 0, admitted.ExecutableSize), admitted.ExecutableSize, admitted.ExecutableSHA256); err != nil {
		return record, err
	}
	if err = write("receipt.json", bytes.NewReader(receiptBytes), int64(len(receiptBytes)), record.TargetReceiptSHA256); err != nil {
		return record, err
	}
	encoded, err := json.Marshal(record)
	if err != nil {
		return record, err
	}
	err = persistRestoreRecord("service-replacement-"+transaction+".json", encoded, 64<<10, records, check)
	return record, err
}

func replacementReceipt(source installReceipt, admitted admittedServiceRelease) (installReceipt, []byte, error) {
	if !migrationDigest(admitted.ExecutableSHA256) || !migrationDigest(admitted.ManifestSHA256) || !nativeComponentID.MatchString(admitted.Release.Components.Storage.ComponentVersion) || source.ComponentVersion == admitted.Release.Components.Storage.ComponentVersion {
		return installReceipt{}, nil, errors.New("distinct authenticated target service required")
	}
	target := source
	target.ComponentVersion = admitted.Release.Components.Storage.ComponentVersion
	target.ExecutableSHA256 = admitted.ExecutableSHA256
	data, err := json.Marshal(target)
	return target, data, err
}

func validateServiceReplacement(record serviceReplacementRecord, areaPath string, admitted admittedServiceRelease) error {
	if record.SchemaVersion != 1 || !migrationDigest(record.TransactionSHA256) || !migrationDigest(record.SourceEvidenceSHA256) || record.TargetManifestSHA256 != admitted.ManifestSHA256 {
		return errors.New("invalid service replacement authority")
	}
	if validateColdBackupName(record.PayloadName) != nil || strings.Contains(record.PayloadName, "/") || !strings.HasPrefix(record.PayloadName, "service-files-"+record.TransactionSHA256+"-") {
		return errors.New("invalid private replacement directory")
	}
	r := record.Source.Receipt
	root := filepath.Dir(areaPath)
	if r.SchemaVersion != receiptSchema || r.StoreRoot != root || r.ConfigPath != filepath.Join(root, "broker-config.json") || r.Executable != filepath.Join(root, "broker", "unity-workspace-storage-host.exe") || record.Source.SchemaVersion != 1 || record.Source.RecoveryReady || record.Source.ExecutableSHA256 != r.ExecutableSHA256 || !migrationDigest(record.Source.ConfigSHA256) || !migrationDigest(record.Source.ReceiptSHA256) {
		return errors.New("replacement source differs from fixed installed service")
	}
	data, err := json.Marshal(record.Source)
	if err != nil {
		return err
	}
	if evidenceHash(data) != record.SourceEvidenceSHA256 {
		return errors.New("replacement source evidence changed")
	}
	target, bytes, err := replacementReceipt(r, admitted)
	if err != nil {
		return err
	}
	if target != record.Target || evidenceHash(bytes) != record.TargetReceiptSHA256 {
		return errors.New("replacement receipt differs from authenticated target")
	}
	return nil
}

func serviceReplacementFiles(record serviceReplacementRecord, areaPath string) []struct {
	Paths          restoreFilePaths
	Source, Target string
} {
	directory := filepath.Join(areaPath, record.PayloadName)
	return []struct {
		Paths          restoreFilePaths
		Source, Target string
	}{
		{restoreFilePaths{record.Source.Receipt.Executable, filepath.Join(directory, "host.exe"), filepath.Join(directory, "previous-host.exe")}, record.Source.ExecutableSHA256, record.Target.ExecutableSHA256},
		{restoreFilePaths{filepath.Join(record.Source.Receipt.StoreRoot, "install-receipt.json"), filepath.Join(directory, "receipt.json"), filepath.Join(directory, "previous-receipt.json")}, record.Source.ReceiptSHA256, record.TargetReceiptSHA256},
	}
}

// Persist and re-read the complete pair before either file changes. apply must
// additionally retain the existing per-file durable rename intent on every replay.
func executeServiceReplacement(record serviceReplacementRecord, areaPath string, admitted admittedServiceRelease, records restoreIntentStorage, check func() error, apply func(restoreFilePaths, string, string) error) error {
	if check == nil || apply == nil {
		return errors.New("stopped service and native replacement required")
	}
	if err := validateServiceReplacement(record, areaPath, admitted); err != nil {
		return err
	}
	data, err := json.Marshal(record)
	if err != nil {
		return err
	}
	if err = persistRestoreRecord("service-replacement-"+record.TransactionSHA256+".json", data, 64<<10, records, check); err != nil {
		return err
	}
	for _, file := range serviceReplacementFiles(record, areaPath) {
		if err = check(); err != nil {
			return err
		}
		if err = apply(file.Paths, file.Source, file.Target); err != nil {
			return err
		}
	}
	return check()
}

// Caller must prove process exit, detached disks, a verified coherent backup and
// a registered recovery worker capable of restoring this pair. This internal
// adapter deliberately does not enable/start SCM or accept a user-side plan.
func (area *maintenanceArea) replaceServiceFiles(record serviceReplacementRecord, source nativeReleaseSource, keys [][]byte, assertRecoverable func() error) error {
	if area == nil || assertRecoverable == nil {
		return errors.New("protected recoverable replacement required")
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
	held, admitted, err := area.openServiceCandidate(record.TransactionSHA256, source, keys)
	if err != nil {
		return err
	}
	defer held.close()
	if err = validateServiceReplacement(record, area.Path, admitted); err != nil {
		return err
	}
	if source.ComponentVersion != record.Source.Receipt.ComponentVersion {
		return errors.New("release source differs from replacement source")
	}
	sourceRecord, err := loadServiceSourceRecord(filepath.Dir(area.Path), record.TransactionSHA256, record.SourceEvidenceSHA256, area.restoreRecordStorage(check, 64<<10), check)
	if err != nil {
		return err
	}
	if sourceRecord.Evidence != record.Source {
		return errors.New("replacement differs from protected original")
	}
	// Config never changes in this operation. Pin it throughout file publication.
	config := &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}
	defer config.close()
	file, size, err := config.openFile(record.Source.Receipt.ConfigPath)
	if err != nil {
		return err
	}
	if size > 64<<10 {
		return errors.New("service config exceeds bound")
	}
	bytes, err := io.ReadAll(io.NewSectionReader(file, 0, size))
	if err != nil {
		return err
	}
	if evidenceHash(bytes) != record.Source.ConfigSHA256 {
		return errors.New("service config changed before replacement")
	}
	return executeServiceReplacement(record, area.Path, admitted, area.restoreRecordStorage(check, 64<<10), check, func(paths restoreFilePaths, oldHash, newHash string) error {
		if err := area.applyRecordedRestoreFile("service-replace-"+record.TransactionSHA256, paths, oldHash, newHash, check); err != nil {
			return err
		}
		return grantReplacementRead(paths.Target, newHash, record.Target.UserSID, check)
	})
}

// A private staged file keeps its protected permissions after rename. Grant the
// initiating user read/execute (never write) before Doctor inspects the new pair.
func grantReplacementRead(target, pin, sid string, check func() error) error {
	if check == nil || !migrationDigest(pin) {
		return errors.New("replacement permission authority required")
	}
	if _, err := windows.StringToSid(sid); err != nil {
		return err
	}
	if err := check(); err != nil {
		return err
	}
	parents := &verifiedColdBackup{directories: map[string]windows.Handle{}}
	defer parents.close()
	if err := parents.holdDirectory(filepath.Dir(target)); err != nil {
		return err
	}
	pointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(pointer, windows.GENERIC_READ|windows.WRITE_DAC, windows.FILE_SHARE_READ, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	file := os.NewFile(uintptr(handle), target)
	defer file.Close()
	var info windows.ByHandleFileInformation
	if err = windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.NumberOfLinks != 1 || info.FileAttributes&(windows.FILE_ATTRIBUTE_DIRECTORY|windows.FILE_ATTRIBUTE_REPARSE_POINT) != 0 {
		return errors.New("redirected replacement target")
	}
	hash := sha256.New()
	if _, err = io.Copy(hash, file); err != nil {
		return err
	}
	if hex.EncodeToString(hash.Sum(nil)) != pin {
		return errors.New("replacement changed before permission publication")
	}
	if err = check(); err != nil {
		return err
	}
	if err = applyACL(handle, sid, false); err != nil {
		return err
	}
	return check()
}
