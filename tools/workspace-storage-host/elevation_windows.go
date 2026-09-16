//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"runtime"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

func freshInstallArguments(root, sid, version string) ([]string, error) {
	if err := inspectLocalPath(root); err != nil {
		return nil, err
	}
	if _, err := windows.StringToSid(sid); err != nil {
		return nil, err
	}
	if version == "" || strings.ContainsRune(version, 0) {
		return nil, errors.New("component version required")
	}
	return []string{"install", "--fresh-only", "--workspace-root", filepath.Clean(root), "--user-sid", sid, "--component-version", version}, nil
}

// Runs in the initiating user process. Only the fixed service operation is elevated.
// The original SID is captured here, never derived from the alternate admin token.
func installElevated(root, version string) (any, error) {
	sid, err := currentUserSID()
	if err != nil {
		return nil, err
	}
	args, err := freshInstallArguments(root, sid, version)
	if err != nil {
		return nil, err
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if err := inspectLocalPath(executable); err != nil {
		return nil, err
	}
	// Query-only SCM access distinguishes absence from access errors before UAC.
	manager, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return nil, err
	}
	defer windows.CloseServiceHandle(manager)
	name, _ := windows.UTF16PtrFromString("UnityWorkspaceStorage")
	service, openErr := windows.OpenService(manager, name, windows.SERVICE_QUERY_STATUS)
	if openErr == nil {
		windows.CloseServiceHandle(service)
	}
	if err := requireFreshService(openErr, true); err != nil {
		return nil, err
	}
	code, err := executeRunAs(executable, args)
	if errors.Is(err, windows.ERROR_CANCELLED) {
		return nil, hostError{code: "workspace-storage.elevation-cancelled", message: "HoneyBee service installation was cancelled", exitCode: 24}
	}
	if err != nil {
		return nil, err
	}
	if code != 0 {
		return nil, fmt.Errorf("elevated service installer failed with exit code %d", code)
	}
	return map[string]any{"schemaVersion": 1, "ok": true, "status": "INSTALLER_COMPLETED"}, nil
}

type shellExecuteInfo struct {
	Size, Mask                        uint32
	Window                            windows.Handle
	Verb, File, Parameters, Directory *uint16
	Show                              int32
	Instance                          windows.Handle
	IDList                            uintptr
	Class                             *uint16
	ClassKey                          windows.Handle
	HotKey                            uint32
	Icon                              windows.Handle
	Process                           windows.Handle
}

func executeRunAs(executable string, args []string) (uint32, error) {
	return executeRunAsExchange(executable, args, nil)
}

func executeRunAsExchange(executable string, args []string, exchange func(windows.Handle) error) (uint32, error) {
	runtime.LockOSThread()
	defer runtime.UnlockOSThread()
	ole := windows.NewLazySystemDLL("ole32.dll")
	result, _, _ := ole.NewProc("CoInitializeEx").Call(0, 2|4)
	if int32(result) < 0 {
		return 0, fmt.Errorf("COM initialization failed: %#x", result)
	}
	defer ole.NewProc("CoUninitialize").Call()
	verb, _ := windows.UTF16PtrFromString("runas")
	file, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return 0, err
	}
	parameters, err := windows.UTF16PtrFromString(windows.ComposeCommandLine(args))
	if err != nil {
		return 0, err
	}
	directory, err := windows.UTF16PtrFromString(filepath.Dir(executable))
	if err != nil {
		return 0, err
	}
	info := shellExecuteInfo{Mask: 0x40 | 0x100 | 0x400, Verb: verb, File: file, Parameters: parameters, Directory: directory, Show: 0}
	info.Size = uint32(unsafe.Sizeof(info))
	ok, _, callErr := windows.NewLazySystemDLL("shell32.dll").NewProc("ShellExecuteExW").Call(uintptr(unsafe.Pointer(&info)))
	runtime.KeepAlive(info)
	if ok == 0 {
		return 0, callErr
	}
	if info.Process == 0 {
		return 0, errors.New("elevation returned no process handle")
	}
	defer windows.CloseHandle(info.Process)
	var exchangeErr error
	if exchange != nil {
		exchangeErr = exchange(info.Process)
	}
	// Do not time out and return while a privileged install might still commit.
	state, err := windows.WaitForSingleObject(info.Process, windows.INFINITE)
	if err != nil {
		return 0, err
	}
	if state != windows.WAIT_OBJECT_0 {
		return 0, errors.New("could not wait for elevated installer")
	}
	var code uint32
	err = windows.GetExitCodeProcess(info.Process, &code)
	return code, errors.Join(exchangeErr, err)
}
