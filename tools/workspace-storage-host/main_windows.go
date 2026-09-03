//go:build windows

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
	"time"
	"unsafe"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const (
	receiptSchema           = 2
	serviceConflictExitCode = 23
)

type hostError struct {
	code     string
	message  string
	exitCode int
}

func (err hostError) Error() string { return err.message }

type installReceipt struct {
	SchemaVersion    int    `json:"schemaVersion"`
	ServiceName      string `json:"serviceName"`
	PipeName         string `json:"pipeName"`
	ComponentVersion string `json:"componentVersion"`
	StoreRoot        string `json:"storeRoot"`
	WorkspaceRoot    string `json:"workspaceRoot"`
	ConfigPath       string `json:"configPath"`
	UserSID          string `json:"userSid"`
	Executable       string `json:"executable"`
	ExecutableSHA256 string `json:"executableSha256"`
}

type storageDiagnostic struct {
	ServiceExists           bool   `json:"serviceExists"`
	ServiceState            string `json:"serviceState,omitempty"`
	ReceiptExists           bool   `json:"receiptExists"`
	ReceiptValid            bool   `json:"receiptValid"`
	ComponentVersion        string `json:"componentVersion,omitempty"`
	WorkspaceRoot           string `json:"workspaceRoot,omitempty"`
	WorkspaceRootAccessible bool   `json:"workspaceRootAccessible"`
	ExecutableExists        bool   `json:"executableExists"`
	ExecutableDigestMatches bool   `json:"executableDigestMatches"`
	UserMatches             bool   `json:"userMatches"`
}

func main() {
	result, err := execute(os.Args[1:])
	if err != nil {
		code := "workspace-storage.install-failed"
		exitCode := 1
		var typed hostError
		if errors.As(err, &typed) {
			code = typed.code
			exitCode = typed.exitCode
		}
		writeJSON(map[string]any{
			"schemaVersion": 1,
			"ok":            false,
			"error":         map[string]string{"code": code},
		})
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(exitCode)
	}
	writeJSON(result)
}

func execute(args []string) (any, error) {
	if len(args) == 0 {
		return nil, errors.New("usage: install|broker-run|control|diagnose|version")
	}
	switch args[0] {
	case "version":
		return map[string]any{"schemaVersion": 1, "ok": true, "component": "honeybee-workspace-storage-host"}, nil
	case "broker-run":
		flags := flag.NewFlagSet("broker-run", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		configPath := flags.String("service-config", "", "absolute broker config path")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 || !filepath.IsAbs(*configPath) {
			return nil, errors.New("broker-run requires --service-config")
		}
		return nil, workspace.RunWindowsService(*configPath)
	case "control":
		if len(args) != 1 {
			return nil, errors.New("control accepts one JSON request on stdin")
		}
		var request workspace.Request
		decoder := json.NewDecoder(os.Stdin)
		decoder.DisallowUnknownFields()
		if err := decoder.Decode(&request); err != nil {
			return nil, fmt.Errorf("decode control request: %w", err)
		}
		var trailing any
		if err := decoder.Decode(&trailing); !errors.Is(err, io.EOF) {
			return nil, errors.New("control request contains trailing JSON")
		}
		ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		response, callErr := workspace.DefaultClient().Call(ctx, request)
		if callErr != nil && response.Error == nil {
			return nil, callErr
		}
		return response, nil
	case "diagnose":
		if len(args) != 1 {
			return nil, errors.New("diagnose accepts no arguments")
		}
		return map[string]any{
			"schemaVersion": 1,
			"ok":            true,
			"diagnostic":    diagnoseStorage(),
		}, nil
	case "install":
		flags := flag.NewFlagSet("install", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		workspaceRoot := flags.String("workspace-root", "", "absolute workspace root")
		userSID := flags.String("user-sid", "", "installed user SID")
		componentVersion := flags.String("component-version", "", "pinned component version")
		replace := flags.Bool("replace", false, "replace the existing HoneyBee service binary")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
			return nil, errors.New("invalid install arguments")
		}
		return install(*workspaceRoot, *userSID, *componentVersion, *replace)
	default:
		return nil, fmt.Errorf("unknown command %q", args[0])
	}
}

func diagnoseStorage() storageDiagnostic {
	result := storageDiagnostic{}
	programData := os.Getenv("ProgramData")
	if filepath.IsAbs(programData) {
		receiptPath := filepath.Join(programData, "UnityWorkspaceStorage", "install-receipt.json")
		if _, err := os.Lstat(receiptPath); err == nil {
			result.ReceiptExists = true
		}
		if receipt, err := loadReceipt(receiptPath); err == nil {
			result.ReceiptValid = true
			result.ComponentVersion = receipt.ComponentVersion
			result.WorkspaceRoot = receipt.WorkspaceRoot
			if info, statErr := os.Lstat(receipt.WorkspaceRoot); statErr == nil &&
				info.IsDir() && info.Mode()&os.ModeSymlink == 0 {
				if handle, openErr := os.Open(receipt.WorkspaceRoot); openErr == nil {
					result.WorkspaceRootAccessible = true
					_ = handle.Close()
				}
			}
			if info, statErr := os.Lstat(receipt.Executable); statErr == nil &&
				info.Mode().IsRegular() && info.Mode()&os.ModeSymlink == 0 {
				result.ExecutableExists = true
				if digest, hashErr := hashFileHex(receipt.Executable); hashErr == nil {
					result.ExecutableDigestMatches = strings.EqualFold(
						digest,
						receipt.ExecutableSHA256,
					)
				}
			}
			if sid, sidErr := currentUserSID(); sidErr == nil {
				result.UserMatches = sid == receipt.UserSID
			}
		}
	}
	manager, err := mgr.Connect()
	if err != nil {
		return result
	}
	defer manager.Disconnect()
	service, err := manager.OpenService(workspace.WindowsServiceName)
	if err != nil {
		return result
	}
	defer service.Close()
	result.ServiceExists = true
	if status, queryErr := service.Query(); queryErr == nil {
		result.ServiceState = serviceStateName(status.State)
	}
	return result
}

func currentUserSID() (string, error) {
	token, err := windows.OpenCurrentProcessToken()
	if err != nil {
		return "", err
	}
	defer token.Close()
	user, err := token.GetTokenUser()
	if err != nil {
		return "", err
	}
	return user.User.Sid.String(), nil
}

func serviceStateName(state svc.State) string {
	switch state {
	case svc.Stopped:
		return "stopped"
	case svc.StartPending:
		return "start-pending"
	case svc.StopPending:
		return "stop-pending"
	case svc.Running:
		return "running"
	case svc.ContinuePending:
		return "continue-pending"
	case svc.PausePending:
		return "pause-pending"
	case svc.Paused:
		return "paused"
	default:
		return "unknown"
	}
}

func install(workspaceRootValue, userSID, componentVersion string, replace bool) (any, error) {
	if !workspace.IsElevated() {
		return nil, errors.New("workspace storage installation requires elevation")
	}
	releaseInstaller, err := acquireInstallerMutex()
	if err != nil {
		return nil, err
	}
	defer releaseInstaller()
	workspaceRoot := filepath.Clean(workspaceRootValue)
	if !filepath.IsAbs(workspaceRoot) || userSID == "" || componentVersion == "" {
		return nil, errors.New("workspace root, installed user SID, and component version are required")
	}
	if _, err := windows.StringToSid(userSID); err != nil {
		return nil, errors.New("installed user SID is invalid")
	}
	programData := os.Getenv("ProgramData")
	if !filepath.IsAbs(programData) {
		return nil, errors.New("ProgramData is unavailable")
	}
	storeRoot := filepath.Join(programData, "UnityWorkspaceStorage")
	configPath := filepath.Join(storeRoot, "broker-config.json")
	installedExecutable := filepath.Join(storeRoot, "broker", "unity-workspace-storage-host.exe")
	receiptPath := filepath.Join(storeRoot, "install-receipt.json")
	storeGuard, err := secureDirectoryTree(storeRoot)
	if err != nil {
		return nil, err
	}
	defer storeGuard.close()
	workspaceGuard, err := secureDirectoryTree(workspaceRoot)
	if err != nil {
		return nil, err
	}
	defer workspaceGuard.close()
	if err := applyACL(storeGuard.final, userSID, false); err != nil {
		return nil, err
	}
	if err := applyACL(workspaceGuard.final, userSID, true); err != nil {
		return nil, err
	}
	if err := reconcileReceiptFile(receiptPath); err != nil {
		return nil, err
	}
	source, err := os.Executable()
	if err != nil {
		return nil, err
	}
	executableSHA256, err := hashFileHex(source)
	if err != nil {
		return nil, err
	}
	receipt := installReceipt{
		SchemaVersion:    receiptSchema,
		ServiceName:      workspace.WindowsServiceName,
		PipeName:         workspace.DefaultPipeName,
		ComponentVersion: componentVersion,
		StoreRoot:        storeRoot,
		WorkspaceRoot:    workspaceRoot,
		ConfigPath:       configPath,
		UserSID:          userSID,
		Executable:       installedExecutable,
		ExecutableSHA256: executableSHA256,
	}

	manager, err := mgr.Connect()
	if err != nil {
		return nil, err
	}
	defer manager.Disconnect()
	if existing, openErr := manager.OpenService(workspace.WindowsServiceName); openErr == nil {
		defer existing.Close()
		if _, receiptErr := os.Stat(receiptPath); os.IsNotExist(receiptErr) {
			return nil, serviceWithoutReceiptError()
		}
		return verifyExisting(receiptPath, receipt, existing, replace)
	}

	if existingReceipt, receiptErr := loadReceipt(receiptPath); receiptErr == nil {
		if err := sameReceipt(existingReceipt, receipt); err != nil {
			return nil, err
		}
		receipt = existingReceipt
	} else if !os.IsNotExist(receiptErr) {
		return nil, receiptErr
	} else {
		if err := requireNewOrEmptyDirectory(storeRoot); err != nil {
			return nil, err
		}
		if err := writeExclusiveJSON(receiptPath, receipt); err != nil {
			return nil, err
		}
	}
	brokerGuard, err := secureDirectoryTree(filepath.Dir(installedExecutable))
	if err != nil {
		return nil, err
	}
	defer brokerGuard.close()
	if err := copyOrVerify(source, installedExecutable); err != nil {
		return nil, err
	}
	config := workspace.ServiceConfig{
		SchemaVersion:     workspace.ServiceConfigSchemaVersion,
		StoreRoot:         storeRoot,
		WorkspaceRoot:     workspaceRoot,
		UserSID:           userSID,
		QuotaBytes:        workspace.DefaultQuotaBytes,
		HostFloorBytes:    workspace.DefaultHostFloor,
		ChildReserveBytes: workspace.DefaultChildReserve,
		PipeName:          workspace.DefaultPipeName,
	}
	if err := ensureServiceConfig(configPath, config); err != nil {
		return nil, err
	}
	service, err := manager.CreateService(
		workspace.WindowsServiceName,
		installedExecutable,
		mgr.Config{
			DisplayName: "Unity Workspace Storage",
			Description: "Owns isolated Unity workspace lifecycle",
			StartType:   mgr.StartAutomatic,
		},
		"broker-run", "--service-config", configPath,
	)
	if err != nil {
		return nil, err
	}
	defer service.Close()
	if err := service.Start(); err != nil {
		_ = service.Delete()
		return nil, err
	}
	return map[string]any{
		"schemaVersion":    1,
		"ok":               true,
		"status":           "INSTALLED",
		"service":          workspace.WindowsServiceName,
		"pipeName":         workspace.DefaultPipeName,
		"componentVersion": componentVersion,
		"executableSha256": executableSHA256,
		"workspaceRoot":    workspaceRoot,
	}, nil
}

func serviceWithoutReceiptError() error {
	return hostError{
		code:     "workspace-storage.service-conflict",
		message:  "the UnityWorkspaceStorage service exists without a matching HoneyBee installation receipt",
		exitCode: serviceConflictExitCode,
	}
}

func acquireInstallerMutex() (func(), error) {
	name, err := windows.UTF16PtrFromString(`Global\UnityWorkspaceStorageInstallerV1`)
	if err != nil {
		return nil, err
	}
	handle, err := windows.CreateMutex(nil, false, name)
	if err != nil {
		return nil, err
	}
	result, err := windows.WaitForSingleObject(handle, uint32((10*time.Minute)/time.Millisecond))
	if err != nil || (result != windows.WAIT_OBJECT_0 && result != windows.WAIT_ABANDONED) {
		windows.CloseHandle(handle)
		if err != nil {
			return nil, err
		}
		return nil, errors.New("workspace storage installer mutex timed out")
	}
	return func() {
		_ = windows.ReleaseMutex(handle)
		_ = windows.CloseHandle(handle)
	}, nil
}

func verifyExisting(receiptPath string, expected installReceipt, service *mgr.Service, replace bool) (any, error) {
	receipt, err := loadReceipt(receiptPath)
	if err != nil {
		return nil, err
	}
	receiptChanged := sameReceipt(receipt, expected) != nil
	if receiptChanged && (!replace || sameMachineIdentity(receipt, expected) != nil) {
		return nil, errors.New("workspace storage install receipt does not match this user or root")
	}
	source, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if err := reconcileServiceExecutable(receipt.Executable, service); err != nil {
		return nil, err
	}
	matches, err := sameFileContent(source, receipt.Executable)
	if err != nil {
		return nil, err
	}
	switched := false
	if !matches {
		if !replace {
			return nil, errors.New("workspace storage service uses a different version; explicit replacement is required")
		}
		if err := replaceServiceExecutable(source, receipt.Executable, service); err != nil {
			return nil, err
		}
		switched = true
	}
	installedSHA256, err := hashFileHex(receipt.Executable)
	if err != nil || installedSHA256 != expected.ExecutableSHA256 {
		return nil, errors.New("workspace storage installed executable digest does not match its receipt")
	}
	if receiptChanged {
		if err := replaceReceiptFile(receiptPath, expected); err != nil {
			return nil, err
		}
		receipt = expected
	}
	status, err := service.Query()
	if err != nil {
		return nil, err
	}
	if status.State == svc.Stopped {
		if err := service.Start(); err != nil {
			return nil, err
		}
	}
	resultStatus := "ALREADY_INSTALLED"
	if switched {
		resultStatus = "SWITCHED"
	}
	return map[string]any{
		"schemaVersion":    1,
		"ok":               true,
		"status":           resultStatus,
		"service":          receipt.ServiceName,
		"pipeName":         receipt.PipeName,
		"componentVersion": receipt.ComponentVersion,
		"executableSha256": receipt.ExecutableSHA256,
		"workspaceRoot":    receipt.WorkspaceRoot,
	}, nil
}

func hashFileHex(target string) (string, error) {
	data, err := os.ReadFile(target)
	if err != nil {
		return "", err
	}
	digest := sha256.Sum256(data)
	return fmt.Sprintf("%x", digest[:]), nil
}

func sameFileContent(left, right string) (bool, error) {
	leftBytes, err := os.ReadFile(left)
	if err != nil {
		return false, err
	}
	rightBytes, err := os.ReadFile(right)
	if err != nil {
		return false, err
	}
	return sha256.Sum256(leftBytes) == sha256.Sum256(rightBytes), nil
}

func waitForServiceState(service *mgr.Service, expected svc.State, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		status, err := service.Query()
		if err != nil {
			return err
		}
		if status.State == expected {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("workspace storage service state transition timed out")
		}
		time.Sleep(200 * time.Millisecond)
	}
}

func replaceServiceExecutable(source, destination string, service *mgr.Service) error {
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State != svc.Stopped {
		if _, err := service.Control(svc.Stop); err != nil {
			return err
		}
		if err := waitForServiceState(service, svc.Stopped, 30*time.Second); err != nil {
			return err
		}
	}
	next, previous := replacementPaths(destination)
	_ = os.Remove(next)
	if _, err := os.Stat(previous); err == nil {
		return errors.New("workspace storage replacement backup was not reconciled")
	} else if !os.IsNotExist(err) {
		return err
	}
	if err := copyExclusiveVerified(source, next); err != nil {
		return err
	}
	if err := os.Rename(destination, previous); err != nil {
		_ = os.Remove(next)
		return err
	}
	if err := os.Rename(next, destination); err != nil {
		_ = os.Rename(previous, destination)
		_ = os.Remove(next)
		return err
	}
	rollback := func() {
		_ = os.Remove(destination)
		_ = os.Rename(previous, destination)
		_ = service.Start()
	}
	if err := service.Start(); err != nil {
		rollback()
		return err
	}
	if err := waitForServiceState(service, svc.Running, 30*time.Second); err != nil {
		_, _ = service.Control(svc.Stop)
		_ = waitForServiceState(service, svc.Stopped, 30*time.Second)
		rollback()
		return err
	}
	matches, err := sameFileContent(source, destination)
	if err != nil || !matches {
		_, _ = service.Control(svc.Stop)
		_ = waitForServiceState(service, svc.Stopped, 30*time.Second)
		rollback()
		return errors.New("workspace storage service replacement did not preserve the approved binary")
	}
	if err := os.Remove(previous); err != nil {
		return err
	}
	return nil
}

func replacementPaths(destination string) (string, string) {
	directory := filepath.Dir(destination)
	return filepath.Join(directory, ".replacement-next.exe"), filepath.Join(directory, ".replacement-previous.exe")
}

func fileExists(target string) (bool, error) {
	_, err := os.Stat(target)
	if err == nil {
		return true, nil
	}
	if os.IsNotExist(err) {
		return false, nil
	}
	return false, err
}

func reconcileServiceExecutable(destination string, service *mgr.Service) error {
	next, previous := replacementPaths(destination)
	destinationExists, err := fileExists(destination)
	if err != nil {
		return err
	}
	previousExists, err := fileExists(previous)
	if err != nil {
		return err
	}
	nextExists, err := fileExists(next)
	if err != nil {
		return err
	}
	if !destinationExists {
		if !previousExists {
			return errors.New("workspace storage service executable is missing without a recoverable backup")
		}
		if err := os.Rename(previous, destination); err != nil {
			return err
		}
		previousExists = false
		if nextExists {
			if err := os.Remove(next); err != nil {
				return err
			}
			nextExists = false
		}
	}
	if nextExists {
		if err := os.Remove(next); err != nil {
			return err
		}
	}
	if !previousExists {
		return nil
	}
	status, err := service.Query()
	if err != nil {
		return err
	}
	if status.State == svc.Stopped {
		if err := service.Start(); err != nil {
			return restorePreviousServiceExecutable(destination, previous, service, err)
		}
	}
	if err := waitForServiceState(service, svc.Running, 30*time.Second); err != nil {
		return restorePreviousServiceExecutable(destination, previous, service, err)
	}
	return os.Remove(previous)
}

func restorePreviousServiceExecutable(destination, previous string, service *mgr.Service, cause error) error {
	status, queryErr := service.Query()
	if queryErr == nil && status.State != svc.Stopped {
		_, _ = service.Control(svc.Stop)
		queryErr = waitForServiceState(service, svc.Stopped, 30*time.Second)
	}
	if queryErr != nil {
		return errors.Join(cause, queryErr)
	}
	if err := os.Remove(destination); err != nil && !os.IsNotExist(err) {
		return errors.Join(cause, err)
	}
	if err := os.Rename(previous, destination); err != nil {
		return errors.Join(cause, err)
	}
	if err := service.Start(); err != nil {
		return errors.Join(cause, err)
	}
	if err := waitForServiceState(service, svc.Running, 30*time.Second); err != nil {
		return errors.Join(cause, err)
	}
	return nil
}

func loadReceipt(target string) (installReceipt, error) {
	data, err := os.ReadFile(target)
	if err != nil {
		return installReceipt{}, err
	}
	var receipt installReceipt
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&receipt); err != nil {
		return installReceipt{}, err
	}
	if receipt.SchemaVersion != receiptSchema ||
		receipt.ServiceName != workspace.WindowsServiceName ||
		receipt.PipeName != workspace.DefaultPipeName ||
		receipt.ComponentVersion == "" ||
		!filepath.IsAbs(receipt.StoreRoot) ||
		!filepath.IsAbs(receipt.WorkspaceRoot) ||
		!filepath.IsAbs(receipt.ConfigPath) ||
		!filepath.IsAbs(receipt.Executable) ||
		receipt.UserSID == "" ||
		len(receipt.ExecutableSHA256) != 64 {
		return installReceipt{}, errors.New("invalid workspace storage install receipt")
	}
	return receipt, nil
}

func sameReceipt(left, right installReceipt) error {
	if err := sameMachineIdentity(left, right); err != nil ||
		left.ComponentVersion != right.ComponentVersion ||
		left.ExecutableSHA256 != right.ExecutableSHA256 {
		return errors.New("workspace storage install receipt identity mismatch")
	}
	return nil
}

func sameMachineIdentity(left, right installReceipt) error {
	if left.SchemaVersion != right.SchemaVersion ||
		left.ServiceName != right.ServiceName ||
		left.PipeName != right.PipeName ||
		!strings.EqualFold(filepath.Clean(left.StoreRoot), filepath.Clean(right.StoreRoot)) ||
		!strings.EqualFold(filepath.Clean(left.WorkspaceRoot), filepath.Clean(right.WorkspaceRoot)) ||
		!strings.EqualFold(filepath.Clean(left.ConfigPath), filepath.Clean(right.ConfigPath)) ||
		!strings.EqualFold(filepath.Clean(left.Executable), filepath.Clean(right.Executable)) ||
		left.UserSID != right.UserSID {
		return errors.New("workspace storage install receipt identity mismatch")
	}
	return nil
}

func receiptReplacementPaths(target string) (string, string) {
	directory := filepath.Dir(target)
	return filepath.Join(directory, ".install-receipt-next.json"), filepath.Join(directory, ".install-receipt-previous.json")
}

func reconcileReceiptFile(target string) error {
	next, previous := receiptReplacementPaths(target)
	targetExists, err := fileExists(target)
	if err != nil {
		return err
	}
	previousExists, err := fileExists(previous)
	if err != nil {
		return err
	}
	if !targetExists && previousExists {
		if err := os.Rename(previous, target); err != nil {
			return err
		}
		targetExists = true
		previousExists = false
	}
	if !targetExists {
		if err := os.Remove(next); err != nil && !os.IsNotExist(err) {
			return err
		}
		return nil
	}
	if _, err := loadReceipt(target); err != nil {
		if !previousExists {
			return err
		}
		if removeErr := os.Remove(target); removeErr != nil {
			return errors.Join(err, removeErr)
		}
		if renameErr := os.Rename(previous, target); renameErr != nil {
			return errors.Join(err, renameErr)
		}
		previousExists = false
	}
	if previousExists {
		if err := os.Remove(previous); err != nil {
			return err
		}
	}
	if err := os.Remove(next); err != nil && !os.IsNotExist(err) {
		return err
	}
	return nil
}

func replaceReceiptFile(target string, value installReceipt) error {
	if err := reconcileReceiptFile(target); err != nil {
		return err
	}
	next, previous := receiptReplacementPaths(target)
	if err := writeExclusiveJSON(next, value); err != nil {
		return err
	}
	if err := os.Rename(target, previous); err != nil {
		_ = os.Remove(next)
		return err
	}
	if err := os.Rename(next, target); err != nil {
		_ = os.Rename(previous, target)
		_ = os.Remove(next)
		return err
	}
	if err := os.Remove(previous); err != nil {
		return err
	}
	return nil
}

func ensureServiceConfig(target string, expected workspace.ServiceConfig) error {
	existing, err := workspace.LoadServiceConfig(target)
	if err == nil {
		if existing != expected {
			return errors.New("workspace storage service config identity mismatch")
		}
		return nil
	}
	if !os.IsNotExist(err) {
		return err
	}
	return workspace.SaveServiceConfig(target, expected)
}

func requireNewOrEmptyDirectory(target string) error {
	entries, err := os.ReadDir(target)
	if os.IsNotExist(err) {
		return nil
	}
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return fmt.Errorf("storage root already exists and is not empty: %s", target)
	}
	return nil
}

type secureDirectoryGuard struct {
	handles []windows.Handle
	final   windows.Handle
}

func (guard *secureDirectoryGuard) close() {
	for index := len(guard.handles) - 1; index >= 0; index-- {
		_ = windows.CloseHandle(guard.handles[index])
	}
}

func openRealDirectory(target string, final bool) (windows.Handle, error) {
	pointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return windows.InvalidHandle, err
	}
	access := uint32(windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	if final {
		access |= windows.READ_CONTROL | windows.WRITE_DAC
	}
	handle, err := windows.CreateFile(
		pointer,
		access,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_FLAG_BACKUP_SEMANTICS|windows.FILE_FLAG_OPEN_REPARSE_POINT,
		0,
	)
	if err != nil {
		return windows.InvalidHandle, err
	}
	if err := validateRealDirectoryHandle(handle, target); err != nil {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func validateRealDirectoryHandle(handle windows.Handle, target string) error {
	var info windows.ByHandleFileInformation
	if err := windows.GetFileInformationByHandle(handle, &info); err != nil {
		return err
	}
	if info.FileAttributes&windows.FILE_ATTRIBUTE_DIRECTORY == 0 ||
		info.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("storage path component is not a real directory: %s", target)
	}
	return nil
}

func openOrCreateRealChildDirectory(parent windows.Handle, component, displayPath string, final bool) (windows.Handle, error) {
	if component == "" || component == "." || component == ".." || strings.ContainsAny(component, `\\/`) {
		return windows.InvalidHandle, fmt.Errorf("storage path component is invalid: %s", displayPath)
	}
	objectName, err := windows.NewNTUnicodeString(component)
	if err != nil {
		return windows.InvalidHandle, err
	}
	attributes := &windows.OBJECT_ATTRIBUTES{
		RootDirectory: parent,
		ObjectName:    objectName,
		Attributes:    windows.OBJ_CASE_INSENSITIVE | windows.OBJ_DONT_REPARSE,
	}
	attributes.Length = uint32(unsafe.Sizeof(*attributes))
	access := uint32(windows.FILE_LIST_DIRECTORY | windows.FILE_TRAVERSE | windows.FILE_READ_ATTRIBUTES | windows.SYNCHRONIZE)
	if final {
		access |= windows.READ_CONTROL | windows.WRITE_DAC
	}
	var handle windows.Handle
	var status windows.IO_STATUS_BLOCK
	if err := windows.NtCreateFile(
		&handle,
		access,
		attributes,
		&status,
		nil,
		windows.FILE_ATTRIBUTE_DIRECTORY,
		windows.FILE_SHARE_READ|windows.FILE_SHARE_WRITE,
		windows.FILE_OPEN_IF,
		windows.FILE_DIRECTORY_FILE|windows.FILE_OPEN_REPARSE_POINT|windows.FILE_OPEN_FOR_BACKUP_INTENT|windows.FILE_SYNCHRONOUS_IO_NONALERT,
		0,
		0,
	); err != nil {
		return windows.InvalidHandle, err
	}
	if err := validateRealDirectoryHandle(handle, displayPath); err != nil {
		_ = windows.CloseHandle(handle)
		return windows.InvalidHandle, err
	}
	return handle, nil
}

func secureDirectoryTree(target string) (*secureDirectoryGuard, error) {
	clean := filepath.Clean(target)
	volume := filepath.VolumeName(clean)
	if volume == "" || strings.HasPrefix(volume, `\\`) {
		return nil, fmt.Errorf("storage path must use a local absolute volume: %s", target)
	}
	root := volume + string(os.PathSeparator)
	relative, err := filepath.Rel(root, clean)
	if err != nil || relative == "." || strings.HasPrefix(relative, ".."+string(os.PathSeparator)) {
		return nil, fmt.Errorf("storage path is outside its local volume: %s", target)
	}
	components := strings.Split(relative, string(os.PathSeparator))
	guard := &secureDirectoryGuard{}
	current := root
	rootHandle, err := openRealDirectory(root, false)
	if err != nil {
		return nil, err
	}
	guard.handles = append(guard.handles, rootHandle)
	for index, component := range components {
		current = filepath.Join(current, component)
		handle, err := openOrCreateRealChildDirectory(
			guard.handles[len(guard.handles)-1],
			component,
			current,
			index == len(components)-1,
		)
		if err != nil {
			guard.close()
			return nil, err
		}
		guard.handles = append(guard.handles, handle)
		guard.final = handle
	}
	return guard, nil
}

func applyACL(target windows.Handle, userSID string, modify bool) error {
	permission := "0x1200a9"
	if modify {
		permission = "0x1301bf"
	}
	descriptor, err := windows.SecurityDescriptorFromString(
		"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)(A;OICI;" + permission + ";;;" + userSID + ")",
	)
	if err != nil {
		return err
	}
	dacl, _, err := descriptor.DACL()
	if err != nil {
		return err
	}
	if err := windows.SetSecurityInfo(
		target,
		windows.SE_FILE_OBJECT,
		windows.DACL_SECURITY_INFORMATION|windows.PROTECTED_DACL_SECURITY_INFORMATION,
		nil,
		nil,
		dacl,
		nil,
	); err != nil {
		return fmt.Errorf("set storage ACL: %w", err)
	}
	return nil
}

func copyExclusiveVerified(source, destination string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(destination, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0700)
	if err != nil {
		return err
	}
	sourceHash := sha256.New()
	_, copyErr := io.Copy(io.MultiWriter(output, sourceHash), input)
	syncErr := output.Sync()
	closeErr := output.Close()
	if err := errors.Join(copyErr, syncErr, closeErr); err != nil {
		_ = os.Remove(destination)
		return err
	}
	installed, err := os.Open(destination)
	if err != nil {
		return err
	}
	destinationHash := sha256.New()
	_, hashErr := io.Copy(destinationHash, installed)
	closeErr = installed.Close()
	if err := errors.Join(hashErr, closeErr); err != nil {
		return err
	}
	if !bytes.Equal(sourceHash.Sum(nil), destinationHash.Sum(nil)) {
		return errors.New("installed workspace storage host hash mismatch")
	}
	return nil
}

func copyOrVerify(source, destination string) error {
	if err := copyExclusiveVerified(source, destination); err == nil {
		return nil
	} else if !os.IsExist(err) {
		return err
	}
	sourceBytes, err := os.ReadFile(source)
	if err != nil {
		return err
	}
	destinationBytes, err := os.ReadFile(destination)
	if err != nil {
		return err
	}
	if sha256.Sum256(sourceBytes) != sha256.Sum256(destinationBytes) {
		return errors.New("installed workspace storage host differs from this HoneyBee package")
	}
	return nil
}

func writeExclusiveJSON(target string, value any) error {
	data, err := json.MarshalIndent(value, "", "  ")
	if err != nil {
		return err
	}
	handle, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	_, writeErr := handle.Write(append(data, '\n'))
	syncErr := handle.Sync()
	closeErr := handle.Close()
	return errors.Join(writeErr, syncErr, closeErr)
}

func writeJSON(value any) {
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetEscapeHTML(false)
	_ = encoder.Encode(value)
}
