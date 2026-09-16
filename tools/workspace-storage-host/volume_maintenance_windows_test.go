//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"golang.org/x/sys/windows"
	"strings"
	"testing"
	"unsafe"
)

func TestMaintenanceInfoParametersMatchWindowsABI(t *testing.T) {
	var value maintenanceInfoOpenParameters
	if unsafe.Sizeof(value) != 28 || unsafe.Offsetof(value.GetInfoOnly) != 4 || unsafe.Offsetof(value.ReadOnly) != 8 || unsafe.Offsetof(value.ResiliencyGUID) != 12 {
		t.Fatal("OPEN_VIRTUAL_DISK_PARAMETERS V2 layout differs from Windows ABI")
	}
}

func TestReadOnlyVolumeVerificationRequiresLiveAdmission(t *testing.T) {
	volume := `\\?\Volume{12345678-1234-1234-1234-123456789abc}\`
	if err := verifyMaintenanceVolumeReadOnly(`C:\missing.vhdx`, volume, nil); err == nil {
		t.Fatal("missing admission allowed inspection")
	}
	lost := errors.New("admission lost")
	if err := verifyMaintenanceVolumeReadOnly(`C:\missing.vhdx`, volume, func() error { return lost }); !errors.Is(err, lost) {
		t.Fatalf("opened a disk before checking admission: %v", err)
	}
	if err := verifyMaintenanceVolumeReadOnly(`C:\missing.vhdx`, `\\.\PhysicalDrive0`, func() error { t.Fatal("invalid volume accepted"); return nil }); err == nil {
		t.Fatal("physical device accepted as a volume")
	}
}

func TestMaintenanceExtentRejectsAmbiguousOrTruncatedVolumes(t *testing.T) {
	valid := make([]byte, 32)
	binary.LittleEndian.PutUint32(valid, 1)
	binary.LittleEndian.PutUint32(valid[8:], 7)
	binary.LittleEndian.PutUint64(valid[24:], 4096)
	if disk, err := singleMaintenanceExtent(valid); err != nil || disk != 7 {
		t.Fatalf("disk=%d: %v", disk, err)
	}
	for _, size := range []int{0, 4, 8, 16, 24, 31} {
		if _, err := singleMaintenanceExtent(valid[:size]); err == nil {
			t.Fatalf("accepted %d bytes", size)
		}
	}
	for _, count := range []uint32{0, 2, 0xffffffff} {
		data := append([]byte(nil), valid...)
		binary.LittleEndian.PutUint32(data, count)
		if _, err := singleMaintenanceExtent(data); err == nil {
			t.Fatalf("accepted %d extents", count)
		}
	}
	for _, length := range []uint64{0, 1 << 63} {
		data := append([]byte(nil), valid...)
		binary.LittleEndian.PutUint64(data[24:], length)
		if _, err := singleMaintenanceExtent(data); err == nil {
			t.Fatal("accepted invalid extent length")
		}
	}
}

func TestMaintenanceQuiesceErrorKeepsStageDiskAndWindowsCode(t *testing.T) {
	v := &maintenanceVolume{image: 1, volume: 1, diskNumber: 7, locked: true,
		assertHeld: func() error { return windows.ERROR_DEV_NOT_EXIST }}
	err := v.detach()
	if !errors.Is(err, windows.ERROR_DEV_NOT_EXIST) || !strings.Contains(err.Error(), "quiesce disk 7 / verify reserved volume") {
		t.Fatalf("lost native error or stage: %v", err)
	}
}

func TestMaintenanceDetachUsesV2ReadOnlyNonInformationHandle(t *testing.T) {
	parameters := maintenanceDetachOpenParameters()
	if parameters.Version != 2 || parameters.GetInfoOnly != 0 || parameters.ReadOnly != 1 || parameters.ResiliencyGUID != (windows.GUID{}) {
		t.Fatalf("detach reservation must use V2 without backing-store writes or information-only restriction: %+v", parameters)
	}
}

func TestMaintenanceVolumeRequiresCanonicalVolumeIdentity(t *testing.T) {
	valid := `\\?\Volume{12345678-1234-1234-1234-123456789abc}\`
	if !maintenanceVolumePattern.MatchString(valid) {
		t.Fatal("rejected canonical GUID")
	}
	for _, volume := range []string{`C:\`, `\\.\PhysicalDrive0`, valid + "child", `\\?\Volume{other}\`, ""} {
		if _, err := openMaintenanceVolume(`C:\source.vhdx`, volume, func() error { return nil }); err == nil {
			t.Fatalf("accepted %q", volume)
		}
	}
	if _, err := openMaintenanceVolume(`C:\source.vhdx`, valid, nil); err == nil {
		t.Fatal("accepted missing ownership")
	}
}

func TestMaintenanceVolumeCannotDetachWithoutLock(t *testing.T) {
	v := &maintenanceVolume{}
	if err := v.detach(); err == nil {
		t.Fatal("accepted unlocked detach")
	}
	if err := v.lock(); err == nil {
		t.Fatal("accepted unopened volume")
	}
	if err := v.close(); err != nil {
		t.Fatal(err)
	}
	if err := v.close(); err != nil {
		t.Fatal(err)
	}
}
