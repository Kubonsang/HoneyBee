//go:build windows && honeybee_qualification

package main

import (
	"encoding/json"
	"errors"
	"golang.org/x/sys/windows"
	"os"
	"path/filepath"
	"strings"
	"time"
)

// Only the explicitly marked QA baseline is built with this tag. Requests and
// reached records live in the existing protected maintenance area. No command
// accepts an arbitrary file path, executable, service name or termination PID.
type qualificationArm struct {
	SchemaVersion  int    `json:"schemaVersion"`
	Nonce          string `json:"nonce"`
	ManifestSHA256 string `json:"manifestSha256"`
	State          string `json:"state"`
	Action         string `json:"action"`
}

func validQualificationState(state string) bool {
	switch state {
	case "BackupVerified", "Stopped", "Replaced", "ReadyForAppCommit":
		return true
	}
	return false
}

func qualificationCommand(args []string) (any, bool, error) {
	if len(args) == 0 || !strings.HasPrefix(args[0], "qualification-") {
		return nil, false, nil
	}
	if args[0] == "qualification-capabilities" && len(args) == 1 {
		return map[string]any{"schemaVersion": 1, "qualificationOnly": true, "protectedCheckpoints": 1}, true, nil
	}
	if args[0] == "qualification-interrupt" && len(args) == 2 && migrationDigest(args[1]) {
		return qualificationInterrupt(args[1])
	}
	if args[0] == "qualification-disarm" && len(args) == 2 && migrationDigest(args[1]) {
		area, err := openMaintenanceArea()
		if err != nil {
			return nil, true, err
		}
		defer area.close()
		records := area.restoreRecordStorage(area.assertHeld, 64<<10)
		if _, err = records.read("qualification-arm-" + args[1] + ".json"); os.IsNotExist(err) {
			return map[string]any{"disarmed": true}, true, nil
		} else if err != nil {
			return nil, true, err
		}
		if _, err = records.read("qualification-reached-" + args[1] + ".json"); err == nil {
			return map[string]any{"disarmed": true}, true, nil
		} else if !os.IsNotExist(err) {
			return nil, true, err
		}
		data, _ := json.Marshal(map[string]any{"schemaVersion": 1, "reached": false, "cancelled": true, "nonce": args[1]})
		err = persistRestoreRecord("qualification-reached-"+args[1]+".json", data, 64<<10, records, area.assertHeld)
		return map[string]any{"disarmed": err == nil}, true, err
	}
	if args[0] == "qualification-status" && len(args) == 2 && migrationDigest(args[1]) {
		_, records, closeReader, err := openMaintenanceReader()
		if err != nil {
			return nil, true, err
		}
		defer closeReader()
		data, err := records.read("qualification-reached-" + args[1] + ".json")
		if os.IsNotExist(err) {
			return map[string]any{"schemaVersion": 1, "reached": false}, true, nil
		}
		if err != nil {
			return nil, true, err
		}
		var record any
		err = json.Unmarshal(data, &record)
		return record, true, err
	}
	if args[0] != "qualification-arm" || len(args) != 5 || !migrationDigest(args[1]) || !migrationDigest(args[2]) || !validQualificationState(args[3]) || (args[4] != "halt" && args[4] != "fail") {
		return nil, true, errors.New("invalid QA checkpoint request")
	}
	area, err := openMaintenanceArea()
	if err != nil {
		return nil, true, err
	}
	defer area.close()
	receipt, err := loadReceipt(filepath.Join(filepath.Dir(area.Path), "install-receipt.json"))
	if err != nil || !strings.HasSuffix(receipt.ComponentVersion, ".qa-baseline") {
		return nil, true, errors.New("QA baseline service required")
	}
	arm := qualificationArm{1, args[1], args[2], args[3], args[4]}
	data, err := json.Marshal(arm)
	if err == nil {
		err = persistRestoreRecord("qualification-arm-"+arm.Nonce+".json", data, 64<<10, area.restoreRecordStorage(area.assertHeld, 64<<10), area.assertHeld)
	}
	return arm, true, err
}

func qualificationMigrationCheckpoint(j *serviceMigration, state string) error {
	if !validQualificationState(state) {
		return nil
	}
	areaPath, records, closeReader, err := openMaintenanceReader()
	if err != nil {
		return err
	}
	defer closeReader()
	if filepath.Dir(j.directory) != areaPath {
		return errors.New("QA checkpoint requires protected migration")
	}
	identityBytes, err := evidenceBytes(filepath.Join(j.directory, "identity.json"), 64<<10)
	if err != nil {
		return err
	}
	var identity migrationIdentity
	if json.Unmarshal(identityBytes, &identity) != nil || evidenceHash(identityBytes) != j.identitySHA256 || !strings.HasSuffix(identity.SourceComponent, ".qa-baseline") {
		return errors.New("QA migration identity mismatch")
	}
	entries, err := os.ReadDir(areaPath)
	if err != nil {
		return err
	}
	var matches []qualificationArm
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "qualification-arm-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := records.read(name)
		if err != nil {
			return err
		}
		var arm qualificationArm
		if decodeMaintenanceRecord(data, &arm) != nil || arm.SchemaVersion != 1 || !migrationDigest(arm.Nonce) || name != "qualification-arm-"+arm.Nonce+".json" {
			return errors.New("invalid protected QA arm")
		}
		if arm.State != state || arm.ManifestSHA256 != identity.TargetManifestSHA256 {
			continue
		}
		_, err = records.read("qualification-reached-" + arm.Nonce + ".json")
		if err == nil {
			continue
		}
		if !os.IsNotExist(err) {
			return err
		}
		matches = append(matches, arm)
	}
	if len(matches) == 0 {
		return nil
	}
	if len(matches) != 1 {
		return errors.New("ambiguous QA checkpoint arms")
	}
	arm := matches[0]
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	owner, err := captureServiceRecoveryOwner(uint32(os.Getpid()), sid)
	if err != nil {
		return err
	}
	var context *serviceRecoveryContext
	for _, entry := range entries {
		name := entry.Name()
		if !strings.HasPrefix(name, "service-recovery-") || !strings.HasSuffix(name, ".json") {
			continue
		}
		data, err := records.read(name)
		if err != nil {
			return err
		}
		var candidate serviceRecoveryContext
		if decodeMaintenanceRecord(data, &candidate) != nil {
			continue
		}
		if candidate.MigrationName != filepath.Base(j.directory) || candidate.MigrationSHA256 != j.identitySHA256 {
			continue
		}
		if err := candidate.validate(areaPath); err != nil {
			return err
		}
		if context != nil {
			return errors.New("ambiguous QA owner context")
		}
		context = &candidate
	}
	if context == nil {
		return errors.New("protected QA owner context missing")
	}
	data, err := json.Marshal(qualificationReached{1, true, arm.Nonce, arm.ManifestSHA256, state, filepath.Base(j.directory), j.identitySHA256, owner, context.Owner, context.ApplicationRoot, time.Now().UTC().Format(time.RFC3339Nano), time.Now().Add(5 * time.Minute).UTC().Format(time.RFC3339Nano)})
	if err != nil {
		return err
	}
	if err = persistRestoreRecord("qualification-reached-"+arm.Nonce+".json", data, 64<<10, records, func() error { return nil }); err != nil {
		return err
	}
	if arm.Action == "fail" {
		return errors.New("QA injected post-checkpoint failure")
	}
	// A bounded hold lets the QA controller terminate this exact transaction or
	// reboot the VM. If the controller disappears, ordinary rollback takes over.
	time.Sleep(5 * time.Minute)
	return errors.New("QA checkpoint controller timeout")
}

type qualificationReached struct {
	SchemaVersion   int                  `json:"schemaVersion"`
	Reached         bool                 `json:"reached"`
	Nonce           string               `json:"nonce"`
	ManifestSHA256  string               `json:"manifestSha256"`
	State           string               `json:"state"`
	MigrationName   string               `json:"migrationName"`
	IdentitySHA256  string               `json:"identitySha256"`
	Process         serviceRecoveryOwner `json:"process"`
	Owner           serviceRecoveryOwner `json:"owner"`
	ApplicationRoot string               `json:"applicationRoot"`
	ReachedAt       string               `json:"reachedAt"`
	HoldDeadline    string               `json:"holdDeadline"`
}

func qualificationHeldProcess(identity serviceRecoveryOwner, expected string) (windows.Handle, error) {
	h, err := windows.OpenProcess(windows.PROCESS_TERMINATE|windows.PROCESS_QUERY_LIMITED_INFORMATION|windows.SYNCHRONIZE, false, identity.PID)
	if err != nil {
		return 0, err
	}
	fail := func(err error) (windows.Handle, error) { windows.CloseHandle(h); return 0, err }
	var created, exit, kernel, user windows.Filetime
	if err = windows.GetProcessTimes(h, &created, &exit, &kernel, &user); err != nil {
		return fail(err)
	}
	if uint64(created.HighDateTime)<<32|uint64(created.LowDateTime) != identity.Created {
		return fail(errors.New("QA process identity changed"))
	}
	buffer := make([]uint16, 32768)
	size := uint32(len(buffer))
	if err = windows.QueryFullProcessImageName(h, 0, &buffer[0], &size); err != nil {
		return fail(err)
	}
	if !strings.EqualFold(filepath.Clean(windows.UTF16ToString(buffer[:size])), filepath.Clean(expected)) {
		return fail(errors.New("QA process executable changed"))
	}
	if state, err := windows.WaitForSingleObject(h, 0); err != nil || state != uint32(windows.WAIT_TIMEOUT) {
		return fail(errors.New("QA process already exited"))
	}
	return h, nil
}

func qualificationInterrupt(nonce string) (any, bool, error) {
	_, records, closeReader, err := openMaintenanceReader()
	if err != nil {
		return nil, true, err
	}
	defer closeReader()
	data, err := records.read("qualification-reached-" + nonce + ".json")
	if err != nil {
		return nil, true, err
	}
	var reached qualificationReached
	if decodeMaintenanceRecord(data, &reached) != nil || !reached.Reached || reached.Nonce != nonce {
		return nil, true, errors.New("QA checkpoint not reached")
	}
	executable, err := os.Executable()
	if err != nil {
		return nil, true, err
	}
	session, err := qualificationHeldProcess(reached.Process, executable)
	if err != nil {
		return nil, true, err
	}
	defer windows.CloseHandle(session)
	owner, err := qualificationHeldProcess(reached.Owner, filepath.Join(reached.ApplicationRoot, "recovery", "v1", "runtime", "node.exe"))
	if err != nil {
		return nil, true, err
	}
	defer windows.CloseHandle(owner)
	if err = windows.TerminateProcess(owner, 197); err != nil {
		return nil, true, err
	}
	if err = windows.TerminateProcess(session, 197); err != nil {
		return nil, true, err
	}
	return map[string]any{"schemaVersion": 1, "interrupted": true, "nonce": nonce}, true, nil
}
