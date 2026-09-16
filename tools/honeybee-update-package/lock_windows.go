//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"syscall"
)

// The sharing mode, not file existence or a PID, defines lock ownership.
func holdUpdateLock(directory string) error {
	if err := plainDir(directory); err != nil {
		return err
	}
	name, err := syscall.UTF16PtrFromString(filepath.Join(directory, "installation-update.lock"))
	if err != nil {
		return err
	}
	handle, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, 0, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return err
	}
	defer syscall.CloseHandle(handle)
	var info syscall.ByHandleFileInformation
	if err := syscall.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		return errors.New("redirected update lock")
	}
	if _, err := fmt.Fprintln(os.Stdout, "LOCKED"); err != nil {
		return err
	}
	_, err = io.Copy(io.Discard, os.Stdin) // Parent exit closes its pipe, releasing the OS handle.
	return err
}
