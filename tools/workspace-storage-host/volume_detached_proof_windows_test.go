//go:build windows

package main

import (
	"errors"
	"testing"

	"golang.org/x/sys/windows"
)

func TestDeviceLossRequiresIndependentOriginalImageProof(t *testing.T) {
	for _, tc := range []struct {
		name                  string
		cause                 error
		actual                string
		loaded                bool
		identityErr, queryErr error
		loseAuthorityAt       int
		wantPass              bool
	}{
		{"service exit unloaded original", windows.ERROR_DEV_NOT_EXIST, "original", false, nil, nil, 0, true},
		{"still attached", windows.ERROR_DEV_NOT_EXIST, "original", true, nil, nil, 0, false},
		{"different file", windows.ERROR_DEV_NOT_EXIST, "replacement", false, nil, nil, 0, false},
		{"missing file", windows.ERROR_DEV_NOT_EXIST, "", false, windows.ERROR_FILE_NOT_FOUND, nil, 0, false},
		{"query denied", windows.ERROR_DEV_NOT_EXIST, "original", false, nil, windows.ERROR_ACCESS_DENIED, 0, false},
		{"query itself says device lost", windows.ERROR_DEV_NOT_EXIST, "original", false, nil, windows.ERROR_DEV_NOT_EXIST, 0, false},
		{"authority lost before query", windows.ERROR_DEV_NOT_EXIST, "original", false, nil, nil, 1, false},
		{"authority lost after query", windows.ERROR_DEV_NOT_EXIST, "original", false, nil, nil, 2, false},
		{"access denied is never disappearance", windows.ERROR_ACCESS_DENIED, "original", false, nil, nil, 0, false},
		{"invalid handle is never disappearance", windows.ERROR_INVALID_HANDLE, "original", false, nil, nil, 0, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			checks, queries := 0, 0
			proof := func() error {
				return proveMaintenanceImageDetached("original", func() error {
					checks++
					if checks == tc.loseAuthorityAt {
						return errors.New("ownership lost")
					}
					return nil
				}, func() (string, error) { return tc.actual, tc.identityErr }, func() (bool, error) { queries++; return tc.loaded, tc.queryErr })
			}
			err := reconcileMaintenanceDeviceLoss(tc.cause, proof)
			if (err == nil) != tc.wantPass {
				t.Fatalf("unexpected outcome: %v", err)
			}
			if err != nil && !errors.Is(err, tc.cause) {
				t.Fatal("original Windows error lost")
			}
			if !errors.Is(tc.cause, windows.ERROR_DEV_NOT_EXIST) && checks != 0 {
				t.Fatal("unrelated error attempted proof")
			}
			if (tc.actual != "original" || tc.identityErr != nil || tc.loseAuthorityAt == 1) && queries != 0 {
				t.Fatal("queried unowned image")
			}
		})
	}
}

func TestDeviceLossWithoutTopologyProofFailsClosed(t *testing.T) {
	if !errors.Is(reconcileMaintenanceDeviceLoss(windows.ERROR_DEV_NOT_EXIST, nil), windows.ERROR_DEV_NOT_EXIST) {
		t.Fatal("unadmitted disappearance accepted")
	}
}

func TestQuiesceRefusesSourceRestartBeforeBackup(t *testing.T) {
	calls := []string{}
	r, err := reserveMaintenanceVolumes([]maintenanceVolumeOperation{&batchVolumeFixture{"a", &calls, ""}}, func() error { return nil }, func() error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	checks := 0
	err = r.quiesce(func() error {
		checks++
		if checks == 3 {
			return errors.New("service restarted")
		}
		return nil
	})
	if err == nil || !r.closed {
		t.Fatalf("failed to refuse and release after source restart: %v", err)
	}
	if len(calls) != 3 || calls[1] != "a:detach" || calls[2] != "a:close" {
		t.Fatalf("unexpected cleanup: %v", calls)
	}
}
