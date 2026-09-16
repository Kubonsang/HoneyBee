//go:build windows

package main

import (
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
)

func activityHandle(directory, file string, shared bool) (syscall.Handle, error) {
	name, err := syscall.UTF16PtrFromString(filepath.Join(directory, file))
	if err != nil {
		return 0, err
	}
	var sharing uint32
	if shared {
		sharing = syscall.FILE_SHARE_READ | syscall.FILE_SHARE_WRITE
	}
	h, err := syscall.CreateFile(name, syscall.GENERIC_READ|syscall.GENERIC_WRITE, sharing, nil, syscall.OPEN_ALWAYS, syscall.FILE_ATTRIBUTE_NORMAL|syscall.FILE_FLAG_OPEN_REPARSE_POINT, 0)
	if err != nil {
		return 0, err
	}
	var info syscall.ByHandleFileInformation
	err = syscall.GetFileInformationByHandle(h, &info)
	if err == nil && info.FileAttributes&(syscall.FILE_ATTRIBUTE_REPARSE_POINT|syscall.FILE_ATTRIBUTE_DIRECTORY) != 0 {
		err = errors.New("redirected activity lock")
	}
	if err != nil {
		syscall.CloseHandle(h)
		return 0, err
	}
	return h, nil
}

func holdActivity(directory, mode, timeout string) error {
	if mode != "shared" && mode != "exclusive" {
		return errors.New("invalid activity mode")
	}
	ms, err := strconv.Atoi(timeout)
	if err != nil || ms < 1 || ms > 120000 {
		return errors.New("invalid activity timeout")
	}
	if err := plainDir(directory); err != nil {
		return err
	}
	ended := make(chan struct{})
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); close(ended) }()
	// Existing clients never wait on this admission gate. The updater closes it
	// before waiting for shared holders, so new clients cannot starve the drain.
	gate, err := activityHandle(directory, "application-admission.lock", mode == "shared")
	if err != nil {
		return fmt.Errorf("application admission unavailable: %w", err)
	}
	gateOpen := true
	defer func() {
		if gateOpen {
			syscall.CloseHandle(gate)
		}
	}()
	if mode == "exclusive" {
		if _, err := fmt.Fprintln(os.Stdout, "DRAINING"); err != nil {
			return err
		}
	}
	deadline := time.Now().Add(time.Duration(ms) * time.Millisecond)
	var activity syscall.Handle
	for {
		select {
		case <-ended:
			return errors.New("activity owner disconnected")
		default:
		}
		activity, err = activityHandle(directory, "application-activity.lock", mode == "shared")
		if err == nil {
			break
		}
		if mode == "shared" || !errors.Is(err, syscall.Errno(32)) {
			return err
		}
		if !time.Now().Before(deadline) {
			return errors.New("application drain timed out")
		}
		select {
		case <-ended:
			return errors.New("activity owner disconnected")
		case <-time.After(25 * time.Millisecond):
		}
	}
	defer syscall.CloseHandle(activity)
	if mode == "shared" {
		syscall.CloseHandle(gate)
		gateOpen = false
	}
	if _, err := fmt.Fprintln(os.Stdout, "HELD"); err != nil {
		return err
	}
	<-ended
	return nil
}
