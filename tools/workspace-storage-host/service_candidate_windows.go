//go:build windows

package main

import (
	"bytes"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
)

const serviceCandidateRecordLimit = 16 << 20

// Stored only in the private maintenance area. Metadata is retained so restart
// can reauthenticate against trusted keys instead of trusting a user-side receipt.
type serviceCandidateRecord struct {
	SchemaVersion     int    `json:"schemaVersion"`
	TransactionSHA256 string `json:"transactionSha256"`
	PayloadName       string `json:"payloadName"`
	PayloadSHA256     string `json:"payloadSha256"`
	Manifest          []byte `json:"manifest"`
	Signature         []byte `json:"signature"`
	Inventory         []byte `json:"inventory"`
}

func matchServiceCandidate(manifest coldBackupManifest, admitted admittedServiceRelease) error {
	if manifest.SchemaVersion != 1 || len(manifest.Files) != 1 {
		return errors.New("candidate must contain exactly one standalone host")
	}
	file := manifest.Files[0]
	if file.Name != "host.exe" || file.SHA256 != admitted.ExecutableSHA256 || file.Size != admitted.ExecutableSize {
		return errors.New("candidate host differs from signed release")
	}
	return nil
}

func validateCandidateRecord(record serviceCandidateRecord, transaction string, source nativeReleaseSource, keys [][]byte) (admittedServiceRelease, error) {
	if record.SchemaVersion != 1 || !migrationDigest(transaction) || transaction != record.TransactionSHA256 || !migrationDigest(record.PayloadSHA256) || validateColdBackupName(record.PayloadName) != nil || strings.Contains(record.PayloadName, "/") || !strings.HasPrefix(record.PayloadName, "candidate-"+transaction+"-") {
		return admittedServiceRelease{}, errors.New("invalid protected service candidate")
	}
	return admitServiceRelease(record.Manifest, record.Signature, record.Inventory, keys, source)
}

func (area *maintenanceArea) stageServiceCandidate(transaction, sourceFile string, manifest, signature, inventory []byte, source nativeReleaseSource, keys [][]byte) (serviceCandidateRecord, error) {
	var result serviceCandidateRecord
	if area == nil || !migrationDigest(transaction) || !filepath.IsAbs(sourceFile) {
		return result, errors.New("protected candidate staging authority required")
	}
	if err := area.assertHeld(); err != nil {
		return result, err
	}
	admitted, err := admitServiceRelease(manifest, signature, inventory, keys, source)
	if err != nil {
		return result, err
	}
	storage := area.restoreRecordStorage(area.assertHeld, serviceCandidateRecordLimit)
	existing, readErr := storage.read("service-candidate-" + transaction + ".json")
	if readErr == nil {
		if err := decodeNativeReleaseJSON(existing, &result); err != nil {
			return result, err
		}
		if !bytes.Equal(result.Manifest, manifest) || !bytes.Equal(result.Signature, signature) || !bytes.Equal(result.Inventory, inventory) {
			return result, errors.New("candidate retry conflicts with protected release")
		}
		held, _, err := area.openServiceCandidate(transaction, source, keys)
		if err != nil {
			return result, err
		}
		held.close()
		return result, nil
	}
	if !os.IsNotExist(readErr) {
		return result, readErr
	}
	// Orphan payloads from interrupted staging remain evidence, but do not block
	// a retry or get mistaken for a fully admitted candidate.
	var nonce [16]byte
	if _, err := rand.Read(nonce[:]); err != nil {
		return result, err
	}
	name := "candidate-" + transaction + "-" + hex.EncodeToString(nonce[:])
	// This copies a release artifact, not the live store. The machine operation
	// lock and exclusive source file handle protect it during bounded copying.
	output, closeOutput, check, err := area.backupOutput(name, area.assertHeld)
	if err != nil {
		return result, err
	}
	defer closeOutput()
	output.admitSource = func(entry string, size int64) error {
		if entry != "host.exe" || size != admitted.ExecutableSize {
			return errors.New("candidate source size differs from signed host")
		}
		return nil
	}
	pin, err := captureColdFilesTo(filepath.Join(area.Path, name), []coldBackupInput{{Name: "host.exe", Source: sourceFile}}, check, output)
	if err != nil {
		return result, err
	}
	closeOutput()
	held, err := verifyColdBackup(filepath.Join(area.Path, name), pin, area.assertHeld)
	if err != nil {
		return result, err
	}
	defer held.close()
	if err = matchServiceCandidate(held.manifest, admitted); err != nil {
		return result, err
	}
	result = serviceCandidateRecord{1, transaction, name, pin, append([]byte(nil), manifest...), append([]byte(nil), signature...), append([]byte(nil), inventory...)}
	data, err := json.Marshal(result)
	if err != nil {
		return result, err
	}
	if err = persistRestoreRecord("service-candidate-"+transaction+".json", data, serviceCandidateRecordLimit, area.restoreRecordStorage(area.assertHeld, serviceCandidateRecordLimit), area.assertHeld); err != nil {
		return result, err
	}
	return result, nil
}

// Keeps authenticated private bytes open against replacement until consumed.
// Starting/replacing a service still needs a coherent source backup and journal.
func (area *maintenanceArea) openServiceCandidate(transaction string, source nativeReleaseSource, keys [][]byte) (*verifiedColdBackup, admittedServiceRelease, error) {
	var admitted admittedServiceRelease
	if area == nil || !migrationDigest(transaction) {
		return nil, admitted, errors.New("protected candidate identity required")
	}
	if err := area.assertHeld(); err != nil {
		return nil, admitted, err
	}
	storage := area.restoreRecordStorage(area.assertHeld, serviceCandidateRecordLimit)
	data, err := storage.read("service-candidate-" + transaction + ".json")
	if err != nil {
		return nil, admitted, err
	}
	var record serviceCandidateRecord
	if len(data) > serviceCandidateRecordLimit {
		return nil, admitted, errors.New("candidate record exceeds bound")
	}
	if err = decodeNativeReleaseJSON(data, &record); err != nil {
		return nil, admitted, err
	}
	admitted, err = validateCandidateRecord(record, transaction, source, keys)
	if err != nil {
		return nil, admitted, err
	}
	held, err := verifyColdBackup(filepath.Join(area.Path, record.PayloadName), record.PayloadSHA256, area.assertHeld)
	if err != nil {
		return nil, admitted, err
	}
	if err = matchServiceCandidate(held.manifest, admitted); err != nil {
		held.close()
		return nil, admitted, err
	}
	if err = area.assertHeld(); err != nil {
		held.close()
		return nil, admitted, err
	}
	return held, admitted, nil
}
