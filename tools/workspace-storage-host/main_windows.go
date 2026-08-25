//go:build windows

package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

const receiptSchema = 1

type installReceipt struct {
	SchemaVersion int
	ServiceName   string
	StoreRoot     string
	WorkspaceRoot string
	ConfigPath    string
	UserSID       string
	Executable    string
}

func main() {
	result, err := execute(os.Args[1:])
	if err != nil {
		writeJSON(map[string]any{
			"schemaVersion": 1,
			"ok":            false,
			"error":         map[string]string{"code": "workspace-storage-install-failed"},
		})
		_, _ = fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	writeJSON(result)
}

func execute(args []string) (any, error) {
	if len(args) == 0 {
		return nil, errors.New("usage: install|broker-run|version")
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
	case "install":
		flags := flag.NewFlagSet("install", flag.ContinueOnError)
		flags.SetOutput(io.Discard)
		workspaceRoot := flags.String("workspace-root", "", "absolute workspace root")
		userSID := flags.String("user-sid", "", "installed user SID")
		if err := flags.Parse(args[1:]); err != nil || flags.NArg() != 0 {
			return nil, errors.New("invalid install arguments")
		}
		return install(*workspaceRoot, *userSID)
	default:
		return nil, fmt.Errorf("unknown command %q", args[0])
	}
}

func install(workspaceRootValue, userSID string) (any, error) {
	if !workspace.IsElevated() {
		return nil, errors.New("workspace storage installation requires elevation")
	}
	workspaceRoot := filepath.Clean(workspaceRootValue)
	if !filepath.IsAbs(workspaceRoot) || userSID == "" {
		return nil, errors.New("workspace root and installed user SID are required")
	}
	if _, err := windows.StringToSid(userSID); err != nil {
		return nil, errors.New("installed user SID is invalid")
	}
	programData := os.Getenv("ProgramData")
	if !filepath.IsAbs(programData) {
		return nil, errors.New("ProgramData is unavailable")
	}
	storeRoot := filepath.Join(programData, "HoneyBee", "WorkspaceStorage")
	configPath := filepath.Join(storeRoot, "broker-config.json")
	installedExecutable := filepath.Join(storeRoot, "broker", "honeybee-workspace-storage-host.exe")
	receiptPath := filepath.Join(programData, "HoneyBee", "workspace-storage-install.json")
	receipt := installReceipt{
		SchemaVersion: receiptSchema,
		ServiceName:   workspace.WindowsServiceName,
		StoreRoot:     storeRoot,
		WorkspaceRoot: workspaceRoot,
		ConfigPath:    configPath,
		UserSID:       userSID,
		Executable:    installedExecutable,
	}

	manager, err := mgr.Connect()
	if err != nil {
		return nil, err
	}
	defer manager.Disconnect()
	if existing, openErr := manager.OpenService(workspace.WindowsServiceName); openErr == nil {
		defer existing.Close()
		if _, receiptErr := os.Stat(receiptPath); os.IsNotExist(receiptErr) {
			return map[string]any{
				"schemaVersion": 1,
				"ok":            true,
				"status":        "EXTERNAL_BROKER_PRESENT",
				"service":       workspace.WindowsServiceName,
				"workspaceRoot": workspaceRoot,
			}, nil
		}
		return verifyExisting(receiptPath, workspaceRoot, userSID, existing)
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
		if err := os.MkdirAll(filepath.Dir(receiptPath), 0700); err != nil {
			return nil, err
		}
		if err := writeExclusiveJSON(receiptPath, receipt); err != nil {
			return nil, err
		}
	}
	if err := os.MkdirAll(filepath.Dir(installedExecutable), 0700); err != nil {
		return nil, err
	}
	if err := os.MkdirAll(workspaceRoot, 0700); err != nil {
		return nil, err
	}
	if err := rejectReparse(storeRoot); err != nil {
		return nil, err
	}
	if err := rejectReparse(workspaceRoot); err != nil {
		return nil, err
	}
	source, err := os.Executable()
	if err != nil {
		return nil, err
	}
	if err := copyOrVerify(source, installedExecutable); err != nil {
		return nil, err
	}
	if err := applyACL(storeRoot, userSID, false); err != nil {
		return nil, err
	}
	if err := applyACL(workspaceRoot, userSID, true); err != nil {
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
			DisplayName: "HoneyBee Workspace Storage",
			Description: "Owns isolated Unity workspace lifecycle for HoneyBee",
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
		"schemaVersion": 1,
		"ok":            true,
		"status":        "INSTALLED",
		"service":       workspace.WindowsServiceName,
		"workspaceRoot": workspaceRoot,
	}, nil
}

func verifyExisting(receiptPath, workspaceRoot, userSID string, service *mgr.Service) (any, error) {
	receipt, err := loadReceipt(receiptPath)
	if err != nil {
		return nil, err
	}
	if receipt.SchemaVersion != receiptSchema ||
		receipt.ServiceName != workspace.WindowsServiceName ||
		!strings.EqualFold(filepath.Clean(receipt.WorkspaceRoot), workspaceRoot) ||
		receipt.UserSID != userSID {
		return nil, errors.New("workspace storage install receipt does not match this user or root")
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
	return map[string]any{
		"schemaVersion": 1,
		"ok":            true,
		"status":        "ALREADY_INSTALLED",
		"service":       receipt.ServiceName,
		"workspaceRoot": receipt.WorkspaceRoot,
	}, nil
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
		!filepath.IsAbs(receipt.StoreRoot) ||
		!filepath.IsAbs(receipt.WorkspaceRoot) ||
		!filepath.IsAbs(receipt.ConfigPath) ||
		!filepath.IsAbs(receipt.Executable) ||
		receipt.UserSID == "" {
		return installReceipt{}, errors.New("invalid workspace storage install receipt")
	}
	return receipt, nil
}

func sameReceipt(left, right installReceipt) error {
	if left.SchemaVersion != right.SchemaVersion ||
		left.ServiceName != right.ServiceName ||
		!strings.EqualFold(filepath.Clean(left.StoreRoot), filepath.Clean(right.StoreRoot)) ||
		!strings.EqualFold(filepath.Clean(left.WorkspaceRoot), filepath.Clean(right.WorkspaceRoot)) ||
		!strings.EqualFold(filepath.Clean(left.ConfigPath), filepath.Clean(right.ConfigPath)) ||
		!strings.EqualFold(filepath.Clean(left.Executable), filepath.Clean(right.Executable)) ||
		left.UserSID != right.UserSID {
		return errors.New("workspace storage install receipt identity mismatch")
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

func rejectReparse(target string) error {
	info, err := os.Lstat(target)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return fmt.Errorf("storage path is not a real directory: %s", target)
	}
	pointer, err := windows.UTF16PtrFromString(target)
	if err != nil {
		return err
	}
	attributes, err := windows.GetFileAttributes(pointer)
	if err != nil {
		return err
	}
	if attributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0 {
		return fmt.Errorf("storage path is a reparse point: %s", target)
	}
	return nil
}

func applyACL(target, userSID string, modify bool) error {
	permission := "(OI)(CI)RX"
	if modify {
		permission = "(OI)(CI)M"
	}
	output, err := exec.Command(
		"icacls.exe",
		target,
		"/inheritance:r",
		"/grant:r",
		"*S-1-5-18:(OI)(CI)F",
		"*S-1-5-32-544:(OI)(CI)F",
		"*"+userSID+":"+permission,
	).CombinedOutput()
	if err != nil {
		return fmt.Errorf("set storage ACL: %w: %s", err, output)
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
