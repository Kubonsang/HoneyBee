//go:build windows

package main

import (
	"encoding/binary"
	"errors"
	"fmt"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	maintenanceLockVolume     = 0x00090018
	maintenanceDismountVolume = 0x00090020
	maintenanceDiskExtents    = 0x00560000
)

var (
	maintenanceVolumePattern   = regexp.MustCompile(`(?i)^\\\\\?\\Volume\{[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\}\\$`)
	maintenancePhysicalPattern = regexp.MustCompile(`(?i)^\\\\\.\\PhysicalDrive([0-9]+)$`)
	maintenanceVirtdisk        = windows.NewLazySystemDLL("virtdisk.dll")
	maintenanceOpenDisk        = maintenanceVirtdisk.NewProc("OpenVirtualDisk")
	maintenancePhysicalPath    = maintenanceVirtdisk.NewProc("GetVirtualDiskPhysicalPath")
	maintenanceDetachDisk      = maintenanceVirtdisk.NewProc("DetachVirtualDisk")
	maintenanceDiskInformation = maintenanceVirtdisk.NewProc("GetVirtualDiskInformation")
)

// Windows BOOL is 32 bits. V2 explicitly selects information-only, read-only
// access; V1 RWDepth=0 can still be refused for a live differencing child.
type maintenanceInfoOpenParameters struct {
	Version, GetInfoOnly, ReadOnly uint32
	ResiliencyGUID                 windows.GUID
}

// Reservation needs a handle usable for detach, not an information-only handle.
// Use V2 here too: V1 GET_INFO|DETACH is refused for the live child even with
// RWDepth=0. ReadOnly applies to the backing file, not volume dismount authority.
func maintenanceDetachOpenParameters() maintenanceInfoOpenParameters {
	return maintenanceInfoOpenParameters{Version: 2, GetInfoOnly: 0, ReadOnly: 1}
}

func openMaintenanceImageInfo(imagePath string) (windows.Handle, error) {
	if !filepath.IsAbs(imagePath) || !strings.EqualFold(filepath.Ext(imagePath), ".vhdx") {
		return 0, errors.New("absolute VHDX image required")
	}
	if err := inspectLocalPath(imagePath); err != nil {
		return 0, fmt.Errorf("inspect VHDX information path %s: %w", imagePath, err)
	}
	name, err := windows.UTF16PtrFromString(imagePath)
	if err != nil {
		return 0, err
	}
	provider := struct {
		DeviceID uint32
		VendorID windows.GUID
	}{3, windows.GUID{Data1: 0xec984aec, Data2: 0xa0f9, Data3: 0x47e9, Data4: [8]byte{0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b}}}
	parameters := maintenanceInfoOpenParameters{Version: 2, GetInfoOnly: 1, ReadOnly: 1}
	var handle windows.Handle
	// V2 requires VIRTUAL_DISK_ACCESS_NONE. Keep the entire parent chain open:
	// a NO_PARENTS fallback would not validate the same attached image topology.
	status, _, _ := maintenanceOpenDisk.Call(uintptr(unsafe.Pointer(&provider)), uintptr(unsafe.Pointer(name)), 0, 0, uintptr(unsafe.Pointer(&parameters)), uintptr(unsafe.Pointer(&handle)))
	runtime.KeepAlive(name)
	if status != 0 {
		return 0, fmt.Errorf("OpenVirtualDisk(V2, GetInfoOnly, ReadOnly) for %s: %w", imagePath, syscall.Errno(status))
	}
	return handle, nil
}

// IsLoaded includes backing images in a differencing chain. It must not alone
// be interpreted as proof that the image has its own attached disk device.
func maintenanceImageLoaded(imagePath string) (bool, error) {
	handle, err := openMaintenanceImageInfo(imagePath)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	info := struct {
		Version, Padding, IsLoaded uint32
		Rest                       [5]uint32
	}{Version: 13}
	size := uint32(unsafe.Sizeof(info))
	var used uint32
	status, _, _ := maintenanceDiskInformation.Call(uintptr(handle), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&used)))
	if status != 0 {
		return false, fmt.Errorf("GetVirtualDiskInformation(IsLoaded) for %s: %w", imagePath, syscall.Errno(status))
	}
	if used < 12 || used > uint32(unsafe.Sizeof(info)) || info.Version != 13 || info.IsLoaded > 1 {
		return false, errors.New("invalid VHDX attachment state")
	}
	return info.IsLoaded != 0, nil
}

// Only the specific no-device result means no direct attachment. Access errors,
// truncated responses and unrecognized paths remain failures, never exemptions.
func maintenanceImageDirectlyAttached(imagePath string) (bool, error) {
	handle, err := openMaintenanceImageInfo(imagePath)
	if err != nil {
		return false, err
	}
	defer windows.CloseHandle(handle)
	_, err = maintenanceDiskNumber(handle)
	if errors.Is(err, windows.ERROR_DEV_NOT_EXIST) {
		return false, nil
	}
	return err == nil, err
}

// Native mechanics only: the privileged coordinator must admit the image and
// complete mount topology and hold its protected path guards before obtaining
// these handles while the broker is paused. Detach additionally requires the
// broker to have stopped and durable resume information. No CLI exposes it.
type maintenanceVolume struct {
	image, volume   windows.Handle
	diskNumber      uint32
	locked          bool
	assertHeld      func() error
	imagePath       string
	informationOnly bool
	// Set only by topology admission while the original image/path guards live.
	confirmDetached func() error
}

func singleMaintenanceExtent(data []byte) (uint32, error) {
	// VOLUME_DISK_EXTENTS: count, alignment padding, one DISK_EXTENT.
	// Multi-disk and truncated results never authorize a volume operation.
	if len(data) != 32 || binary.LittleEndian.Uint32(data[:4]) != 1 {
		return 0, errors.New("maintenance requires exactly one complete disk extent")
	}
	if binary.LittleEndian.Uint64(data[16:24]) > 1<<63-1 || binary.LittleEndian.Uint64(data[24:32]) == 0 || binary.LittleEndian.Uint64(data[24:32]) > 1<<63-1 {
		return 0, errors.New("invalid maintenance disk extent")
	}
	return binary.LittleEndian.Uint32(data[8:12]), nil
}

func maintenanceDiskNumber(handle windows.Handle) (uint32, error) {
	buffer := make([]uint16, 1024)
	size := uint32(len(buffer) * 2)
	status, _, _ := maintenancePhysicalPath.Call(uintptr(handle), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&buffer[0])))
	if status != 0 {
		return 0, syscall.Errno(status)
	}
	match := maintenancePhysicalPattern.FindStringSubmatch(windows.UTF16ToString(buffer))
	if match == nil {
		return 0, errors.New("unrecognized virtual disk physical path")
	}
	number, err := strconv.ParseUint(match[1], 10, 32)
	return uint32(number), err
}

func openMaintenanceVolume(imagePath, volumeGUID string, assertHeld func() error) (*maintenanceVolume, error) {
	if assertHeld == nil || !maintenanceVolumePattern.MatchString(volumeGUID) || !filepath.IsAbs(imagePath) || !strings.EqualFold(filepath.Ext(imagePath), ".vhdx") {
		return nil, errors.New("maintenance ownership and canonical volume GUID required")
	}
	if err := assertHeld(); err != nil {
		return nil, err
	}
	if err := inspectLocalPath(imagePath); err != nil {
		return nil, fmt.Errorf("inspect VHDX path %s: %w", imagePath, err)
	}
	// A second operational VHDX open conflicts with the live broker writer.
	// Capture identity with an information-only handle and retain the volume lock
	// across Stop. Operational access, if still needed, is obtained after Stop.
	image, err := openMaintenanceImageInfo(imagePath)
	if err != nil {
		return nil, err
	}
	v := &maintenanceVolume{image: image, imagePath: imagePath, informationOnly: true, assertHeld: assertHeld}
	reject := func(err error) (*maintenanceVolume, error) { return nil, errors.Join(err, v.close()) }
	v.diskNumber, err = maintenanceDiskNumber(v.image)
	if err != nil {
		return reject(fmt.Errorf("GetVirtualDiskPhysicalPath for %s: %w", imagePath, err))
	}
	volume, err := windows.UTF16PtrFromString(strings.TrimSuffix(volumeGUID, `\`))
	if err != nil {
		return reject(err)
	}
	v.volume, err = windows.CreateFile(volume, windows.GENERIC_READ|windows.GENERIC_WRITE, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		v.volume = 0
		return reject(fmt.Errorf("CreateFile(READ|WRITE) for volume %s (image %s): %w", volumeGUID, imagePath, err))
	}
	if err = v.verifyIdentity(); err != nil {
		return reject(err)
	}
	return v, nil
}

// Recovery validation must not acquire detach or writable-volume access merely
// to compare disk/volume identity. No mutable maintenance handle escapes here.
func verifyMaintenanceVolumeReadOnly(imagePath, volumeGUID string, assertHeld func() error) error {
	if assertHeld == nil || !maintenanceVolumePattern.MatchString(volumeGUID) {
		return errors.New("held admission and canonical volume GUID required for inspection")
	}
	if err := assertHeld(); err != nil {
		return err
	}
	image, err := openMaintenanceImageInfo(imagePath)
	if err != nil {
		return err
	}
	v := &maintenanceVolume{image: image, assertHeld: assertHeld}
	defer v.close()
	v.diskNumber, err = maintenanceDiskNumber(image)
	if err != nil {
		return fmt.Errorf("query inspected image disk %s: %w", imagePath, err)
	}
	name, err := windows.UTF16PtrFromString(strings.TrimSuffix(volumeGUID, `\`))
	if err != nil {
		return err
	}
	handle, err := windows.CreateFile(name, windows.GENERIC_READ, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE, nil, windows.OPEN_EXISTING, 0, 0)
	if err != nil {
		return fmt.Errorf("open read-only inspection volume %s: %w", volumeGUID, err)
	}
	v.volume = handle
	if err := v.verifyIdentity(); err != nil {
		return err
	}
	return assertHeld()
}

func (v *maintenanceVolume) verifyIdentity() error {
	if v.assertHeld == nil || v.image == 0 || v.volume == 0 {
		return errors.New("closed maintenance volume")
	}
	if err := v.assertHeld(); err != nil {
		return err
	}
	actual, err := maintenanceDiskNumber(v.image)
	if err != nil {
		return fmt.Errorf("GetVirtualDiskPhysicalPath for admitted disk %d: %w", v.diskNumber, err)
	}
	if actual != v.diskNumber {
		return errors.New("virtual disk identity changed")
	}
	data := make([]byte, 32)
	var returned uint32
	if err = windows.DeviceIoControl(v.volume, maintenanceDiskExtents, nil, 0, &data[0], uint32(len(data)), &returned, nil); err != nil {
		return fmt.Errorf("IOCTL_VOLUME_GET_VOLUME_DISK_EXTENTS for admitted disk %d: %w", v.diskNumber, err)
	}
	if returned > uint32(len(data)) {
		return errors.New("invalid extent response length")
	}
	volumeDisk, err := singleMaintenanceExtent(data[:returned])
	if err != nil {
		return err
	}
	if volumeDisk != actual {
		return errors.New("volume does not belong to the admitted virtual disk")
	}
	return nil
}

// Call for every admitted volume before detaching any image. Windows refuses the
// lock while files are open and flushes cached writes when the lock succeeds.
func (v *maintenanceVolume) lock() error {
	if err := v.verifyIdentity(); err != nil {
		return err
	}
	if v.locked {
		return nil
	}
	var returned uint32
	if err := windows.DeviceIoControl(v.volume, maintenanceLockVolume, nil, 0, nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("volume is in use; maintenance cancelled: %w", err)
	}
	v.locked = true
	return v.verifyIdentity()
}

// The lock stays held through dismount and detach. There is no force/unlock retry,
// mount-point deletion, image deletion, formatting, or source-file cleanup here.
func (v *maintenanceVolume) detach() (result error) {
	operation := "verify reserved volume"
	nativeDeviceOperation := true
	defer func() {
		if result != nil && v.locked && nativeDeviceOperation {
			result = reconcileMaintenanceDeviceLoss(result, v.confirmDetached)
		}
		if result != nil {
			result = fmt.Errorf("quiesce disk %d / %s: %w", v.diskNumber, operation, result)
		}
	}()
	if !v.locked {
		return errors.New("volume must be exclusively locked before detach")
	}
	if err := v.verifyIdentity(); err != nil {
		return err
	}
	var returned uint32
	operation = "FSCTL_DISMOUNT_VOLUME"
	if err := windows.DeviceIoControl(v.volume, maintenanceDismountVolume, nil, 0, nil, 0, &returned, nil); err != nil {
		return err
	}
	operation = "assert ownership before detach"
	nativeDeviceOperation = false
	if err := v.assertHeld(); err != nil {
		return err
	}
	operation = "DetachVirtualDisk"
	nativeDeviceOperation = true
	if v.informationOnly {
		operation = "release information reservation after service stop"
		nativeDeviceOperation = false
		if v.confirmDetached == nil {
			return errors.New("independent original-image proof required before releasing reservation")
		}
		detached, err := releaseMaintenanceInformationHandle(
			func() error {
				if err := v.assertHeld(); err != nil {
					return err
				}
				if err := windows.CloseHandle(v.image); err != nil {
					return err
				}
				v.image = 0
				return nil
			}, v.confirmDetached,
			func() error {
				if err := v.assertHeld(); err != nil {
					return err
				}
				image, err := openStoppedMaintenanceImage(v.imagePath)
				if err != nil {
					return err
				}
				v.image = image
				v.informationOnly = false
				// The path guard, original disk number, and locked volume must
				// still identify the same attachment after the operational open.
				return v.verifyIdentity()
			})
		if err != nil {
			return err
		}
		if detached {
			return v.assertHeld()
		}
		operation = "DetachVirtualDisk after source process exit"
		nativeDeviceOperation = true
	}
	status, _, _ := maintenanceDetachDisk.Call(uintptr(v.image), 0, 0)
	if status != 0 {
		return syscall.Errno(status)
	}
	// A successful detach request can still leave a permanent attachment present.
	// Ask the provider explicitly; an arbitrary query error is never "detached".
	operation = "assert ownership after detach"
	nativeDeviceOperation = false
	if err := v.assertHeld(); err != nil {
		return err
	}
	if v.confirmDetached != nil {
		operation = "confirm original pinned image detached"
		return v.confirmDetached()
	}
	info := struct {
		Version, Padding, IsLoaded uint32
		Rest                       [5]uint32
	}{Version: 13, IsLoaded: 1}
	size := uint32(unsafe.Sizeof(info))
	var used uint32
	operation = "GetVirtualDiskInformation(IS_LOADED) after detach"
	nativeDeviceOperation = true
	status, _, _ = maintenanceDiskInformation.Call(uintptr(v.image), uintptr(unsafe.Pointer(&size)), uintptr(unsafe.Pointer(&info)), uintptr(unsafe.Pointer(&used)))
	if status != 0 {
		return syscall.Errno(status)
	}
	if used < 12 || used > uint32(unsafe.Sizeof(info)) || info.Version != 13 || info.IsLoaded != 0 {
		return errors.New("virtual disk detachment was not confirmed")
	}
	// Caller closes these native handles before acquiring exclusive backup file
	// handles; application/service exclusion must remain held across that boundary.
	operation = "assert ownership after detached confirmation"
	nativeDeviceOperation = false
	return v.assertHeld()
}

// ERROR_DEV_NOT_EXIST is not itself evidence of quiescence. Accept it only after
// admission's independent, guarded image query proves the original file unloaded.
// No fallback on access-denied, invalid handles, unknown errors or failed proof.
func reconcileMaintenanceDeviceLoss(cause error, confirmDetached func() error) error {
	if !errors.Is(cause, windows.ERROR_DEV_NOT_EXIST) || confirmDetached == nil {
		return cause
	}
	if err := confirmDetached(); err != nil {
		return errors.Join(cause, fmt.Errorf("independent detached-image proof failed: %w", err))
	}
	return nil
}

func proveMaintenanceImageDetached(expectedID string, assertHeld func() error, identity func() (string, error), loaded func() (bool, error)) error {
	if expectedID == "" || assertHeld == nil || identity == nil || loaded == nil {
		return errors.New("original image identity and held admission required")
	}
	if err := assertHeld(); err != nil {
		return err
	}
	actual, err := identity()
	if err != nil {
		return err
	}
	if actual != expectedID {
		return errors.New("original reserved image identity changed")
	}
	attached, err := loaded()
	if err != nil {
		return err
	}
	if attached {
		return errMaintenanceImageStillLoaded
	}
	return assertHeld()
}

func (v *maintenanceVolume) close() error {
	var errs []error
	if v.volume != 0 {
		errs = append(errs, windows.CloseHandle(v.volume))
		v.volume = 0
		v.locked = false
	}
	if v.image != 0 {
		errs = append(errs, windows.CloseHandle(v.image))
		v.image = 0
	}
	return errors.Join(errs...)
}
