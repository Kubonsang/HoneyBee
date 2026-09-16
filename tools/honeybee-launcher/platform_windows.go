package main

import (
	"fmt"
	"os"
	"os/exec"
	"syscall"
	"unsafe"
)

func configureRecoveryProcess(command *exec.Cmd) {
	command.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
}

func isRedirected(info os.FileInfo) bool {
	attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
	return info.Mode()&os.ModeSymlink != 0 || (ok && attributes.FileAttributes&syscall.FILE_ATTRIBUTE_REPARSE_POINT != 0)
}

func reportError(message string, cli bool) {
	if cli {
		fmt.Fprintln(os.Stderr, message)
		return
	}
	text, _ := syscall.UTF16PtrFromString(message)
	title, _ := syscall.UTF16PtrFromString("HoneyBee")
	box := syscall.NewLazyDLL("user32.dll").NewProc("MessageBoxW")
	box.Call(0, uintptr(unsafe.Pointer(text)), uintptr(unsafe.Pointer(title)), 0x10)
}
