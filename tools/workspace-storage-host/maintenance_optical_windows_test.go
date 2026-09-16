//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"strings"
	"testing"

	"golang.org/x/sys/windows"
)

func TestMaintenanceOpticalVolumeRefusesUncertainClassification(t *testing.T) {
	for _, tc := range []struct {
		name                        string
		extentErr, deviceErr        error
		deviceType, driveType, size uint32
		wantSkip                    bool
	}{
		{"observed DVD", windows.ERROR_INVALID_FUNCTION, nil, 2, 5, 12, true},
		{"disk with same error", windows.ERROR_INVALID_FUNCTION, nil, 7, 3, 12, false},
		{"optical path but disk handle", windows.ERROR_INVALID_FUNCTION, nil, 7, 5, 12, false},
		{"optical handle but disk path", windows.ERROR_INVALID_FUNCTION, nil, 2, 3, 12, false},
		{"unknown root", windows.ERROR_INVALID_FUNCTION, nil, 2, 0, 12, false},
		{"short device reply", windows.ERROR_INVALID_FUNCTION, nil, 2, 5, 8, false},
		{"oversized device reply", windows.ERROR_INVALID_FUNCTION, nil, 2, 5, 16, false},
		{"classification denied", windows.ERROR_INVALID_FUNCTION, windows.ERROR_ACCESS_DENIED, 2, 5, 12, false},
		{"different extent error", windows.ERROR_ACCESS_DENIED, nil, 2, 5, 12, false},
		{"device disappeared", windows.ERROR_DEV_NOT_EXIST, nil, 2, 5, 12, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			queries := 0
			skip, err := maintenanceOpticalVolume("volume-under-test", tc.extentErr, func(data []byte) (uint32, error) {
				queries++
				binary.LittleEndian.PutUint32(data, tc.deviceType)
				return tc.size, tc.deviceErr
			}, func() uint32 { return tc.driveType })
			if skip != tc.wantSkip || (err == nil) != tc.wantSkip {
				t.Fatalf("skip=%v error=%v", skip, err)
			}
			if !errors.Is(tc.extentErr, windows.ERROR_INVALID_FUNCTION) && queries != 0 {
				t.Fatal("unrelated error attempted optical exception")
			}
			if err != nil && !strings.Contains(err.Error(), "volume-under-test") {
				t.Fatal("failure omitted volume identity")
			}
		})
	}
}
