//go:build windows

package main

import (
	"bytes"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"syscall"
	"time"
	"unsafe"
)

// Native Windows x64 layout of JOBOBJECT_EXTENDED_LIMIT_INFORMATION.
// This helper is built only for the supported win32-x64 package.
type jobLimits struct {
	PerProcess, PerJob                             int64
	Flags                                          uint32
	MinWorking, MaxWorking                         uintptr
	Active                                         uint32
	Affinity                                       uintptr
	Priority, Scheduling                           uint32
	IO                                             [6]uint64
	ProcessMemory, JobMemory, PeakProcess, PeakJob uintptr
}

func containDoctor() error {
	if unsafe.Sizeof(uintptr(0)) != 8 {
		return errors.New("Doctor containment requires Windows x64")
	}
	dll := syscall.NewLazyDLL("kernel32.dll")
	job, _, e := dll.NewProc("CreateJobObjectW").Call(0, 0)
	if job == 0 {
		return fmt.Errorf("create Doctor job: %w", e)
	}
	limits := jobLimits{Flags: 0x2000} // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE, no breakaway.
	ok, _, e := dll.NewProc("SetInformationJobObject").Call(job, 9, uintptr(unsafe.Pointer(&limits)), unsafe.Sizeof(limits))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		return fmt.Errorf("configure Doctor job: %w", e)
	}
	self, _ := syscall.GetCurrentProcess()
	ok, _, e = dll.NewProc("AssignProcessToJobObject").Call(job, uintptr(self))
	if ok == 0 {
		syscall.CloseHandle(syscall.Handle(job))
		return fmt.Errorf("join Doctor job: %w", e)
	}
	// Intentionally keep the noninheritable handle until process exit. Closing it
	// kills this helper too. Every subsequently spawned child inherits membership.
	return nil
}

type doctorBuffer struct{ buffer bytes.Buffer }

func (b *doctorBuffer) Bytes() []byte { return b.buffer.Bytes() }

func (b *doctorBuffer) Write(p []byte) (int, error) {
	if b.buffer.Len()+len(p) > 1024*1024 {
		fmt.Fprintln(os.Stderr, "Doctor output limit exceeded")
		os.Exit(2) // Closing the job kills descendants, including pipe holders.
	}
	return b.buffer.Write(p)
}

func runContainedDoctor(node, cli, directory, timeout string) error {
	ms, err := strconv.Atoi(timeout)
	if err != nil || ms < 1 || ms > 120000 {
		return errors.New("invalid Doctor timeout")
	}
	for _, p := range []string{node, cli, directory} {
		if !filepath.IsAbs(p) {
			return errors.New("absolute Doctor paths required")
		}
	}
	if err := plainDir(directory); err != nil {
		return err
	}
	if err := containDoctor(); err != nil {
		return err
	}
	// A parent-owned stdin pipe is the lifetime lease, never passed to Doctor.
	go func() { _, _ = io.Copy(io.Discard, os.Stdin); os.Exit(2) }()
	timer := time.AfterFunc(time.Duration(ms)*time.Millisecond, func() {
		fmt.Fprintln(os.Stderr, "Doctor timed out")
		os.Exit(2)
	})
	defer timer.Stop()
	cmd := exec.Command(node, cli, "doctor", "--json")
	cmd.Dir = directory
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	var stdout, stderr doctorBuffer
	cmd.Stdout, cmd.Stderr = &stdout, &stderr
	// Descendant-held output pipes cannot keep the helper alive indefinitely.
	cmd.WaitDelay = 500 * time.Millisecond
	runErr := cmd.Run()
	if _, err := os.Stdout.Write(stdout.Bytes()); err != nil {
		return err
	}
	_, err = os.Stderr.Write(stderr.Bytes())
	if err != nil {
		return err
	}
	if runErr != nil {
		return fmt.Errorf("Doctor process failed: %w", runErr)
	}
	return err
}
