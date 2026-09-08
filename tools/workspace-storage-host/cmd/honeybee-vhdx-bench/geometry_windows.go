//go:build windows

package main

import (
	"fmt"
	"runtime"
	"syscall"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Explicit child geometry: BlockSizeInBytes=0 was measured to produce 2 MiB
// children even from a 1 MiB parent. This function does not attach the image.
func createChild(path, parent string, block uint32) error {
	if block != 1<<20 && block != 2<<20 {
		return fmt.Errorf("unsupported benchmark block size %d", block)
	}
	type storageType struct {
		DeviceID uint32
		Vendor   windows.GUID
	}
	kind := storageType{3, windows.GUID{Data1: 0xec984aec, Data2: 0xa0f9, Data3: 0x47e9, Data4: [8]byte{0x90, 0x1f, 0x71, 0x41, 0x5a, 0x66, 0x34, 0x5b}}}
	type createV2 struct {
		Version                                             uint32
		Padding                                             uint32
		UniqueID                                            windows.GUID
		MaximumSize                                         uint64
		BlockSize, SectorSize, PhysicalSectorSize, Padding2 uint32
		ParentPath, SourcePath                              *uint16
		OpenFlags                                           uint32
		ParentType, SourceType                              storageType
		Resiliency                                          windows.GUID
		Padding3                                            uint32
	}
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return err
	}
	pp, err := windows.UTF16PtrFromString(parent)
	if err != nil {
		return err
	}
	options := createV2{Version: 2, BlockSize: block, ParentPath: pp, ParentType: kind}
	var handle windows.Handle
	status, _, _ := windows.NewLazySystemDLL("virtdisk.dll").NewProc("CreateVirtualDisk").Call(uintptr(unsafe.Pointer(&kind)), uintptr(unsafe.Pointer(p)), 0, 0, 0, 0, uintptr(unsafe.Pointer(&options)), 0, uintptr(unsafe.Pointer(&handle)))
	runtime.KeepAlive(p)
	runtime.KeepAlive(pp)
	runtime.KeepAlive(options)
	if status != 0 {
		return fmt.Errorf("create child: %w", syscall.Errno(status))
	}
	return windows.CloseHandle(handle)
}
