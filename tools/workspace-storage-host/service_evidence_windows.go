//go:build windows

package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"reflect"
	"strings"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

type serviceIdentity struct {
	Command     string `json:"command"`
	Account     string `json:"account"`
	StartType   uint32 `json:"startType"`
	ServiceType uint32 `json:"serviceType"`
	State       string `json:"state"`
}
type serviceEvidence struct {
	SchemaVersion    int             `json:"schemaVersion"`
	Receipt          installReceipt  `json:"receipt"`
	ReceiptSHA256    string          `json:"receiptSha256"`
	ConfigSHA256     string          `json:"configSha256"`
	ExecutableSHA256 string          `json:"executableSha256"`
	SCM              serviceIdentity `json:"scm"`
	RecoveryReady    bool            `json:"recoveryReady"`
}

func evidenceBytes(target string, limit int64) ([]byte, error) {
	if err := inspectLocalPath(target); err != nil {
		return nil, err
	}
	info, err := os.Lstat(target)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("invalid evidence file")
	}
	f, err := os.Open(target)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	b, err := io.ReadAll(io.LimitReader(f, limit+1))
	if err != nil {
		return nil, err
	}
	if int64(len(b)) > limit {
		return nil, errors.New("evidence size exceeded")
	}
	return b, nil
}
func evidenceHash(b []byte) string { h := sha256.Sum256(b); return hex.EncodeToString(h[:]) }
func inspectServiceEvidence(receiptPath, sid string, scm serviceIdentity) (serviceEvidence, error) {
	var result serviceEvidence
	data, err := evidenceBytes(receiptPath, 64<<10)
	if err != nil {
		return result, err
	}
	receipt, err := decodeReceipt(data)
	if err != nil {
		return result, err
	}
	if receipt.UserSID != sid {
		return result, errors.New("service belongs to another user")
	}
	equal := func(a, b string) bool { return strings.EqualFold(filepath.Clean(a), filepath.Clean(b)) }
	if !equal(receiptPath, filepath.Join(receipt.StoreRoot, "install-receipt.json")) || !equal(receipt.ConfigPath, filepath.Join(receipt.StoreRoot, "broker-config.json")) || !equal(receipt.Executable, filepath.Join(receipt.StoreRoot, "broker", "unity-workspace-storage-host.exe")) {
		return result, errors.New("noncanonical service installation")
	}
	if pathsOverlap(receipt.StoreRoot, receipt.WorkspaceRoot) {
		return result, errors.New("overlapping service roots")
	}
	for _, target := range []string{receipt.StoreRoot, receipt.WorkspaceRoot, receipt.Executable, receipt.ConfigPath} {
		if err := inspectLocalPath(target); err != nil {
			return result, err
		}
	}
	for _, root := range []string{receipt.StoreRoot, receipt.WorkspaceRoot} {
		info, err := os.Stat(root)
		if err != nil || !info.IsDir() {
			return result, errors.New("service data root is unavailable")
		}
	}
	if err := verifyServiceCommand(scm.Command, receipt); err != nil {
		return result, err
	}
	if !strings.EqualFold(scm.Account, "LocalSystem") || scm.ServiceType != windows.SERVICE_WIN32_OWN_PROCESS || scm.StartType != mgr.StartAutomatic || scm.State != "running" {
		return result, errors.New("unexpected service configuration or state")
	}
	next, previous := replacementPaths(receipt.Executable)
	rn, rp := receiptReplacementPaths(receiptPath)
	for _, target := range []string{next, previous, rn, rp} {
		if _, err := os.Lstat(target); !os.IsNotExist(err) {
			return result, errors.New("pending replacement evidence requires recovery")
		}
	}
	configBytes, err := evidenceBytes(receipt.ConfigPath, 64<<10)
	if err != nil {
		return result, err
	}
	var config workspace.ServiceConfig
	err = json.Unmarshal(configBytes, &config)
	if err != nil {
		return result, err
	}
	if config != expectedServiceConfig(receipt) {
		return result, errors.New("service configuration disagrees with receipt")
	}
	executable, err := evidenceBytes(receipt.Executable, 128<<20)
	if err != nil {
		return result, err
	}
	digest := evidenceHash(executable)
	if digest != receipt.ExecutableSHA256 {
		return result, errors.New("service executable disagrees with receipt")
	}
	// Bind byte evidence to the same parsed receipt/config, rather than a racing read.
	again, err := evidenceBytes(receiptPath, 64<<10)
	if err != nil || evidenceHash(again) != evidenceHash(data) {
		return result, errors.New("receipt changed during inspection")
	}
	again, err = evidenceBytes(receipt.ConfigPath, 64<<10)
	if err != nil || evidenceHash(again) != evidenceHash(configBytes) {
		return result, errors.New("config changed during inspection")
	}
	return serviceEvidence{1, receipt, evidenceHash(data), evidenceHash(configBytes), digest, scm, false}, nil
}
func queryServiceIdentity() (serviceIdentity, error) {
	var result serviceIdentity
	handle, err := windows.OpenSCManager(nil, nil, windows.SC_MANAGER_CONNECT)
	if err != nil {
		return result, err
	}
	manager := &mgr.Mgr{Handle: handle}
	defer manager.Disconnect()
	name, err := windows.UTF16PtrFromString(workspace.WindowsServiceName)
	if err != nil {
		return result, err
	}
	handle, err = windows.OpenService(manager.Handle, name, windows.SERVICE_QUERY_CONFIG|windows.SERVICE_QUERY_STATUS)
	if err != nil {
		return result, err
	}
	service := &mgr.Service{Name: workspace.WindowsServiceName, Handle: handle}
	defer service.Close()
	config, err := service.Config()
	if err != nil {
		return result, err
	}
	state, err := service.Query()
	if err != nil {
		return result, err
	}
	if state.State != svc.Running {
		return result, errors.New("service is not running")
	}
	return serviceIdentity{config.BinaryPathName, config.ServiceStartName, config.StartType, config.ServiceType, serviceStateName(state.State)}, nil
}
func captureServiceEvidence() (serviceEvidence, error) {
	var result serviceEvidence
	programData := os.Getenv("ProgramData")
	if !filepath.IsAbs(programData) {
		return result, errors.New("ProgramData is not absolute")
	}
	sid, err := currentUserSID()
	if err != nil {
		return result, err
	}
	scm, err := queryServiceIdentity()
	if err != nil {
		return result, err
	}
	result, err = inspectServiceEvidence(filepath.Join(programData, "UnityWorkspaceStorage", "install-receipt.json"), sid, scm)
	if err != nil {
		return result, err
	}
	after, err := queryServiceIdentity()
	if err != nil {
		return result, err
	}
	if after != scm {
		return result, errors.New("service changed during inspection")
	}
	return result, nil
}
func writeEvidenceFile(target string, data []byte) error {
	f, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	syncErr := f.Sync()
	closeErr := f.Close()
	return errors.Join(writeErr, syncErr, closeErr)
}

// This is a component evidence backup, NOT a coherent workspace/store snapshot.
func backupServiceEvidence(destination string, capture func() (serviceEvidence, error), checkpoint func(string) error) (serviceEvidence, error) {
	before, err := capture()
	if err != nil {
		return before, err
	}
	if before.RecoveryReady {
		return before, errors.New("unexpected evidence authority")
	}
	if err := inspectLocalPath(destination); err != nil {
		return before, err
	}
	if pathsOverlap(destination, before.Receipt.StoreRoot) || pathsOverlap(destination, before.Receipt.WorkspaceRoot) {
		return before, errors.New("backup overlaps service data")
	}
	parent, err := os.Stat(filepath.Dir(destination))
	if err != nil || !parent.IsDir() {
		return before, errors.New("backup parent must exist")
	}
	if err := os.Mkdir(destination, 0700); err != nil {
		return before, err
	}
	prepared, _ := json.Marshal(map[string]any{"schemaVersion": 1, "state": "Capturing", "recoveryReady": false})
	if err := writeEvidenceFile(filepath.Join(destination, "001-Capturing.json"), prepared); err != nil {
		return before, err
	}
	for _, item := range []struct {
		name, source, digest string
		limit                int64
	}{
		{"install-receipt.json", filepath.Join(before.Receipt.StoreRoot, "install-receipt.json"), before.ReceiptSHA256, 64 << 10},
		{"broker-config.json", before.Receipt.ConfigPath, before.ConfigSHA256, 64 << 10},
		{"broker.exe", before.Receipt.Executable, before.ExecutableSHA256, 128 << 20},
	} {
		data, err := evidenceBytes(item.source, item.limit)
		if err != nil {
			return before, err
		}
		if evidenceHash(data) != item.digest {
			return before, errors.New("source changed during backup")
		}
		target := filepath.Join(destination, item.name)
		if err := writeEvidenceFile(target, data); err != nil {
			return before, err
		}
		copied, err := evidenceBytes(target, item.limit)
		if err != nil || evidenceHash(copied) != item.digest {
			return before, errors.New("backup verification failed")
		}
		if err := checkpoint(item.name); err != nil {
			return before, err
		}
	}
	after, err := capture()
	if err != nil {
		return before, err
	}
	if !reflect.DeepEqual(before, after) {
		return before, errors.New("service identity changed during backup")
	}
	for _, item := range []struct {
		name, digest string
		limit        int64
	}{
		{"install-receipt.json", before.ReceiptSHA256, 64 << 10},
		{"broker-config.json", before.ConfigSHA256, 64 << 10},
		{"broker.exe", before.ExecutableSHA256, 128 << 20},
	} {
		data, err := evidenceBytes(filepath.Join(destination, item.name), item.limit)
		if err != nil || evidenceHash(data) != item.digest {
			return before, errors.New("backup changed before completion")
		}
	}
	data, err := json.MarshalIndent(before, "", "  ")
	if err != nil {
		return before, err
	}
	if err := writeEvidenceFile(filepath.Join(destination, "002-Captured.json"), data); err != nil {
		return before, err
	}
	return before, nil
}
func runServiceEvidence(args []string) (any, error) {
	if len(args) == 0 {
		return captureServiceEvidence()
	}
	if len(args) != 2 || args[0] != "--backup-directory" {
		return nil, errors.New("service-evidence accepts optional --backup-directory NEW_DIRECTORY")
	}
	// Never let an elevated caller turn a user-controlled destination into an admin write.
	if workspace.IsElevated() {
		return nil, errors.New("evidence backup must run without elevation")
	}
	result, err := backupServiceEvidence(args[1], captureServiceEvidence, func(string) error { return nil })
	if err != nil {
		return nil, fmt.Errorf("service evidence capture failed; partial output is retained: %w", err)
	}
	return result, nil
}
