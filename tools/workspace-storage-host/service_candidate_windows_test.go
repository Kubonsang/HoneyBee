//go:build windows

package main

import "testing"

func TestServiceCandidateRequiresExactSignedStandaloneHost(t *testing.T) {
	expected := admittedServiceRelease{ExecutableSHA256: evidenceHash([]byte("signed host")), ExecutableSize: 11}
	good := coldBackupManifest{SchemaVersion: 1, Files: []coldBackupFile{{"host.exe", 11, expected.ExecutableSHA256}}}
	if err := matchServiceCandidate(good, expected); err != nil {
		t.Fatal(err)
	}
	for _, files := range [][]coldBackupFile{
		nil, {{"other.exe", 11, expected.ExecutableSHA256}}, {{"host.exe", 12, expected.ExecutableSHA256}}, {{"host.exe", 11, evidenceHash([]byte("wrong"))}}, {good.Files[0], good.Files[0]},
	} {
		if err := matchServiceCandidate(coldBackupManifest{SchemaVersion: 1, Files: files}, expected); err == nil {
			t.Fatal("candidate integrity bypass", files)
		}
	}
	for _, record := range []serviceCandidateRecord{
		{}, {SchemaVersion: 1, TransactionSHA256: evidenceHash([]byte("tx")), PayloadName: "../escape", PayloadSHA256: evidenceHash([]byte("payload"))},
	} {
		if _, err := validateCandidateRecord(record, evidenceHash([]byte("tx")), nativeReleaseSource{}, nil); err == nil {
			t.Fatal("unauthenticated candidate accepted")
		}
	}
	var area *maintenanceArea
	if _, err := area.stageServiceCandidate("", "", nil, nil, nil, nativeReleaseSource{}, nil); err == nil {
		t.Fatal("unprotected candidate staging")
	}
}
