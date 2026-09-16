//go:build windows

package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"syscall"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

// This admission pass performs reads only and runs under the installer mutex,
// before directory creation, ACL changes or receipt/executable reconciliation.
func inspectInstallAdmission(receiptPath string, expected installReceipt, serviceOpenErr error, replace bool) error {
	if serviceOpenErr != nil && !errors.Is(serviceOpenErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return fmt.Errorf("cannot inspect existing storage service: %w", serviceOpenErr)
	}
	for _, target := range []string{expected.StoreRoot, expected.WorkspaceRoot, expected.ConfigPath, expected.Executable, receiptPath} {
		if err := inspectLocalPath(target); err != nil {
			return err
		}
	}
	if pathsOverlap(expected.StoreRoot, expected.WorkspaceRoot) {
		return errors.New("service store and workspace roots must be separate")
	}
	next, previous := receiptReplacementPaths(receiptPath)
	hasReceipt := false
	approvedDigests := map[string]bool{expected.ExecutableSHA256: true}
	for _, candidate := range []string{receiptPath, previous, next} {
		if err := inspectLocalPath(candidate); err != nil {
			return err
		}
		receipt, err := loadReceipt(candidate)
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return fmt.Errorf("receipt requires manual recovery: %w", err)
		}
		if err := sameMachineIdentity(receipt, expected); err != nil {
			return err
		}
		if !replace || serviceOpenErr != nil {
			if err := sameReceipt(receipt, expected); err != nil {
				return err
			}
		}
		approvedDigests[receipt.ExecutableSHA256] = true
		// An uncommitted next receipt alone does not establish ownership.
		if candidate != next {
			hasReceipt = true
		}
	}
	if !hasReceipt {
		if serviceOpenErr == nil {
			return serviceWithoutReceiptError()
		}
		for _, root := range []string{expected.StoreRoot, expected.WorkspaceRoot} {
			if err := requireNewOrEmptyDirectory(root); err != nil {
				return err
			}
		}
	}
	if hasReceipt {
		nextBinary, previousBinary := replacementPaths(expected.Executable)
		hasRecoverableBinary := false
		for _, candidate := range []string{expected.Executable, previousBinary, nextBinary} {
			if err := inspectLocalPath(candidate); err != nil {
				return err
			}
			digest, err := hashFileHex(candidate)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !approvedDigests[digest] {
				return errors.New("service binary evidence does not match an admitted receipt")
			}
			if candidate != nextBinary {
				hasRecoverableBinary = true
			}
		}
		if serviceOpenErr == nil && !hasRecoverableBinary {
			return errors.New("existing service has no recoverable binary")
		}
	}
	// Config mismatch must not be discovered only after applying new ACLs.
	config, err := workspace.LoadServiceConfig(expected.ConfigPath)
	if err == nil {
		if config != expectedServiceConfig(expected) {
			return errors.New("workspace storage service config identity mismatch")
		}
	} else if !os.IsNotExist(err) || serviceOpenErr == nil {
		return err
	}
	return nil
}

func expectedServiceConfig(receipt installReceipt) workspace.ServiceConfig {
	return workspace.ServiceConfig{
		SchemaVersion: workspace.ServiceConfigSchemaVersion,
		StoreRoot:     receipt.StoreRoot, WorkspaceRoot: receipt.WorkspaceRoot, UserSID: receipt.UserSID,
		QuotaBytes: workspace.DefaultQuotaBytes, HostFloorBytes: workspace.DefaultHostFloor,
		ChildReserveBytes: workspace.DefaultChildReserve, PipeName: workspace.DefaultPipeName,
	}
}

func pathsOverlap(left, right string) bool {
	left = strings.ToLower(filepath.Clean(left))
	right = strings.ToLower(filepath.Clean(right))
	separator := string(os.PathSeparator)
	return left == right || strings.HasPrefix(left, right+separator) || strings.HasPrefix(right, left+separator)
}

// Inspect existing components without creating missing ones. Handle-based guards
// in the mutation phase still reject redirection and pin directories afterwards.
func inspectLocalPath(target string) error {
	clean := filepath.Clean(target)
	volume := filepath.VolumeName(clean)
	if !filepath.IsAbs(clean) || len(volume) != 2 || volume[1] != ':' || clean == volume+`\` {
		return fmt.Errorf("storage path must be below a local drive root: %s", target)
	}
	current := volume + `\`
	parts := strings.Split(strings.TrimPrefix(clean, current), `\`)
	for index, part := range parts {
		current = filepath.Join(current, part)
		info, err := os.Lstat(current)
		if os.IsNotExist(err) {
			return nil
		}
		if err != nil {
			return err
		}
		attributes, ok := info.Sys().(*syscall.Win32FileAttributeData)
		if info.Mode()&os.ModeSymlink != 0 || (ok && attributes.FileAttributes&windows.FILE_ATTRIBUTE_REPARSE_POINT != 0) {
			return fmt.Errorf("redirected storage path: %s", current)
		}
		if index < len(parts)-1 && !info.IsDir() {
			return fmt.Errorf("storage ancestor is not a directory: %s", current)
		}
	}
	return nil
}

func verifyServiceCommand(command string, expected installReceipt) error {
	args, err := windows.DecomposeCommandLine(command)
	if err != nil || len(args) != 4 || !strings.EqualFold(filepath.Clean(args[0]), filepath.Clean(expected.Executable)) ||
		args[1] != "broker-run" || args[2] != "--service-config" || !strings.EqualFold(filepath.Clean(args[3]), filepath.Clean(expected.ConfigPath)) {
		return errors.New("existing storage service command does not match the installation receipt")
	}
	return nil
}

// The elevated fresh-install entry point must recheck SCM under the mutex even
// when the initiating unelevated process previously observed a missing service.
func requireFreshService(serviceOpenErr error, freshOnly bool) error {
	if !freshOnly {
		return nil
	}
	if errors.Is(serviceOpenErr, windows.ERROR_SERVICE_DOES_NOT_EXIST) {
		return nil
	}
	if serviceOpenErr != nil {
		return serviceOpenErr
	}
	return errors.New("fresh installation refused: storage service already exists")
}
