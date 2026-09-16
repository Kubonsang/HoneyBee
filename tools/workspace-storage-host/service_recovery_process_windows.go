//go:build windows

package main

import (
	"errors"
	"path/filepath"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

var errInstalledServiceProcessAlive = errors.New("installed service process has not exited")

// After a worker crash its old process handle no longer exists. SCM Stopped
// alone is insufficient: refuse any surviving process using the fixed installed
// image. No PID is killed, and a matching name with unreadable identity is refusal.
func assertInstalledServiceProcessExited(executable string) error {
	if !filepath.IsAbs(executable) {
		return errors.New("fixed installed image required")
	}
	snapshot, err := windows.CreateToolhelp32Snapshot(windows.TH32CS_SNAPPROCESS, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(snapshot)
	var entry windows.ProcessEntry32
	entry.Size = uint32(unsafe.Sizeof(entry))
	err = windows.Process32First(snapshot, &entry)
	for count := 0; err == nil; count++ {
		if count > 65536 {
			return errors.New("process inventory exceeds bound")
		}
		if strings.EqualFold(windows.UTF16ToString(entry.ExeFile[:]), filepath.Base(executable)) {
			handle, openErr := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, entry.ProcessID)
			if openErr != nil && !errors.Is(openErr, windows.ERROR_INVALID_PARAMETER) {
				return openErr
			}
			if openErr == nil {
				buffer := make([]uint16, 32768)
				length := uint32(len(buffer))
				queryErr := windows.QueryFullProcessImageName(handle, 0, &buffer[0], &length)
				_ = windows.CloseHandle(handle)
				if queryErr != nil {
					return queryErr
				}
				if strings.EqualFold(windows.UTF16ToString(buffer[:length]), executable) {
					return errInstalledServiceProcessAlive
				}
			}
		}
		err = windows.Process32Next(snapshot, &entry)
	}
	if !errors.Is(err, windows.ERROR_NO_MORE_FILES) {
		return err
	}
	return nil
}
