//go:build windows

package main

import (
	"github.com/Kubonsang/unity-workspace-storage/storage"
	"golang.org/x/sys/windows"
	"unsafe"
)

var allocationInfoProc = windows.NewLazySystemDLL("kernel32.dll").NewProc("GetFileInformationByHandleEx")

// GetCompressedFileSize returns EOF for ordinary files, not cluster allocation.
// Match the product usage companion: STANDARD_INFO for ordinary files and the
// compressed/sparse API only when those attributes are actually present.
func measuredFileUsage(path string) (storage.FileUsage, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return storage.FileUsage{}, err
	}
	attrs, err := windows.GetFileAttributes(p)
	if err != nil {
		return storage.FileUsage{}, err
	}
	if attrs&(windows.FILE_ATTRIBUTE_COMPRESSED|windows.FILE_ATTRIBUTE_SPARSE_FILE) != 0 {
		return storage.FileUsageOf(path)
	}
	h, err := windows.CreateFile(p, windows.FILE_READ_ATTRIBUTES, windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE|windows.FILE_SHARE_DELETE, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return storage.FileUsage{}, err
	}
	defer windows.CloseHandle(h)
	var info struct {
		Allocation, EOF          int64
		Links                    uint32
		DeletePending, Directory byte
		Padding                  [2]byte
	}
	ok, _, callErr := allocationInfoProc.Call(uintptr(h), 1, uintptr(unsafe.Pointer(&info)), unsafe.Sizeof(info))
	if ok == 0 {
		return storage.FileUsage{}, callErr
	}
	return storage.FileUsage{LogicalBytes: info.EOF, AllocatedBytes: info.Allocation}, nil
}
