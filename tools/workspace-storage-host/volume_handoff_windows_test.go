//go:build windows

package main

import (
	"errors"
	"golang.org/x/sys/windows"
	"reflect"
	"testing"
)

func TestMaintenanceInformationHandoffFailsClosed(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		closeErr, proofErr, openErr error
		detached                    bool
		calls                       []string
	}{
		{name: "last handle released", detached: true, calls: []string{"close", "proof"}},
		{name: "still attached", proofErr: errMaintenanceImageStillLoaded, calls: []string{"close", "proof", "open"}},
		{name: "close failed", closeErr: windows.ERROR_INVALID_HANDLE, calls: []string{"close"}},
		{name: "access denied is not detached", proofErr: windows.ERROR_ACCESS_DENIED, calls: []string{"close", "proof"}},
		{name: "identity mismatch", proofErr: errors.New("different image"), calls: []string{"close", "proof"}},
		{name: "remaining attachment busy", proofErr: errMaintenanceImageStillLoaded, openErr: windows.ERROR_SHARING_VIOLATION, calls: []string{"close", "proof", "open"}},
	} {
		t.Run(tc.name, func(t *testing.T) {
			var calls []string
			detached, err := releaseMaintenanceInformationHandle(func() error { calls = append(calls, "close"); return tc.closeErr }, func() error { calls = append(calls, "proof"); return tc.proofErr }, func() error { calls = append(calls, "open"); return tc.openErr })
			if detached != tc.detached || !reflect.DeepEqual(calls, tc.calls) {
				t.Fatal(detached, err, calls)
			}
			wantErr := tc.closeErr != nil || (tc.proofErr != nil && !errors.Is(tc.proofErr, errMaintenanceImageStillLoaded)) || tc.openErr != nil
			if (err != nil) != wantErr {
				t.Fatal(err)
			}
		})
	}
}
