//go:build windows

package main

import (
	"fmt"
	"golang.org/x/sys/windows"
	"unsafe"
)

// Inventory v1 records NTFS LZNT1 via FILE_ATTRIBUTE_COMPRESSED. Other formats
// are rejected by inspection, so the flag is sufficient to restore this format.
func storeCompressionFormat(handle windows.Handle) (uint16, error) {
	var format uint16
	var returned uint32
	err := windows.DeviceIoControl(handle, windows.FSCTL_GET_COMPRESSION, nil, 0, (*byte)(unsafe.Pointer(&format)), 2, &returned, nil)
	if err != nil {
		return 0, fmt.Errorf("FSCTL_GET_COMPRESSION: %w", err)
	}
	if returned != 2 {
		return 0, fmt.Errorf("truncated compression format: %d bytes", returned)
	}
	return format, nil
}

// Call only after durable metadata intent, with a held writable admitted handle.
func setStoreCompression(handle windows.Handle, compressed bool) error {
	var format uint16
	if compressed {
		format = 2
	} // COMPRESSION_FORMAT_LZNT1
	var returned uint32
	if err := windows.DeviceIoControl(handle, windows.FSCTL_SET_COMPRESSION, (*byte)(unsafe.Pointer(&format)), 2, nil, 0, &returned, nil); err != nil {
		return fmt.Errorf("FSCTL_SET_COMPRESSION: %w", err)
	}
	actual, err := storeCompressionFormat(handle)
	if err != nil {
		return err
	}
	if actual != format {
		return fmt.Errorf("restored compression differs: got %d, want %d", actual, format)
	}
	return nil
}
