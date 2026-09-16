//go:build windows

package main

import (
	"errors"
	"fmt"
	"golang.org/x/sys/windows"
	"runtime"
	"syscall"
	"unsafe"
)

var errMaintenanceImageStillLoaded = errors.New("original reserved image is still loaded")

// Only a positive, guarded observation of the original image still loaded
// permits a later operational open. Access errors and changed identities are
// never treated as successful detach or permission to bypass verification.
func releaseMaintenanceInformationHandle(closeInformation, confirmDetached, openRemaining func() error) (bool, error) {
	if closeInformation == nil || confirmDetached == nil || openRemaining == nil {
		return false, errors.New("complete handoff callbacks required")
	}
	if err := closeInformation(); err != nil {
		return false, err
	}
	err := confirmDetached()
	if err == nil {
		return true, nil
	}
	if !errors.Is(err, errMaintenanceImageStillLoaded) {
		return false, err
	}
	return false, openRemaining()
}

// Called only after durable reservation, volume lock/dismount and source process
// exit, while original image/path guards and machine exclusion remain held.
func openStoppedMaintenanceImage(imagePath string) (windows.Handle, error) {
	if err := inspectLocalPath(imagePath); err != nil {
		return 0, err
	}
	name, err := windows.UTF16PtrFromString(imagePath)
	if err != nil {
		return 0, err
	}
	provider := struct {
		DeviceID uint32
		VendorID windows.GUID
	}{3, windows.GUID{Data1: 0xec984aec, Data2: 0xa0f9, Data3: 0x47e9, Data4: [8]byte{0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b}}}
	parameters := maintenanceDetachOpenParameters()
	var handle windows.Handle
	status, _, _ := maintenanceOpenDisk.Call(uintptr(unsafe.Pointer(&provider)), uintptr(unsafe.Pointer(name)), 0, 0, uintptr(unsafe.Pointer(&parameters)), uintptr(unsafe.Pointer(&handle)))
	runtime.KeepAlive(name)
	if status != 0 {
		return 0, fmt.Errorf("OpenVirtualDisk(V2, stopped source, ReadOnly) for %s: %w", imagePath, syscall.Errno(status))
	}
	return handle, nil
}
