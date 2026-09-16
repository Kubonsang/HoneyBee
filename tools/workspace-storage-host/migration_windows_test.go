//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"
)

func TestMigrationInterruptedColdPreparationResumesWithoutBackup(t *testing.T) {
	states := []string{"Reserving", "Reserved", "Stopping", "Stopped", "Quiescing", "Quiesced", "BackingUp", "BackupVerified", "Resuming"}
	for index, state := range states {
		t.Run(state, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			for _, step := range states[:index+1] {
				if err := j.mark(step); err != nil {
					t.Fatal(err)
				}
			}
			h.VerifyBackup = func() error { return errors.New("backup unavailable") }
			loaded, err := loadServiceMigration(j.directory, j.identitySHA256)
			if err != nil {
				t.Fatal(err)
			}
			if err = loaded.recover(h); err != nil {
				t.Fatal(err)
			}
			if loaded.state() != "Resumed" || !hasMigrationCall(*calls, "resume") || hasMigrationCall(*calls, "restore") {
				t.Fatalf("%s %v", loaded.state(), *calls)
			}
		})
	}
}
func TestMigrationQuiescenceFailureCannotCaptureOrReplace(t *testing.T) {
	j, h, calls := migrationFixture(t)
	h.QuiesceDisks = func() error { return errors.New("busy volume") }
	if err := j.run(h); err == nil {
		t.Fatal("accepted busy volume")
	}
	if j.state() != "Resumed" || hasMigrationCall(*calls, "backup") || hasMigrationCall(*calls, "replace") {
		t.Fatalf("%s %v", j.state(), *calls)
	}
}

func TestMigrationBusyVolumeCannotStopService(t *testing.T) {
	j, h, calls := migrationFixture(t)
	h.ReserveDisks = func() error { return errors.New("open user file") }
	if err := j.run(h); err == nil {
		t.Fatal("accepted busy volume")
	}
	if j.state() != "Resumed" || hasMigrationCall(*calls, "stop") || hasMigrationCall(*calls, "backup") || hasMigrationCall(*calls, "replace") {
		t.Fatal(j.state(), *calls)
	}
}

func TestMigrationRejectsProtocolTwoBeforeReplay(t *testing.T) {
	j, _, _ := migrationFixture(t)
	data, err := json.Marshal(migrationIdentity{2, "source", "target", evidenceHash([]byte("a")), evidenceHash([]byte("b"))})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(j.directory, "identity.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadServiceMigration(j.directory, evidenceHash(data)); err == nil {
		t.Fatal("replayed old reservation semantics")
	}
}
func TestMigrationColdOrderAndOldProtocolRefusal(t *testing.T) {
	j, h, calls := migrationFixture(t)
	if err := j.run(h); err != nil {
		t.Fatal(err)
	}
	want := []string{"source-health", "pause", "reserve", "stop", "quiesce", "backup", "verify-backup", "replace", "target-health"}
	if len(*calls) != len(want) {
		t.Fatal(*calls)
	}
	for i, name := range want {
		if (*calls)[i] != name {
			t.Fatal(*calls)
		}
	}
	data, err := json.Marshal(migrationIdentity{1, "source", "target", evidenceHash([]byte("a")), evidenceHash([]byte("b"))})
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(j.directory, "identity.json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	if _, err = loadServiceMigration(j.directory, evidenceHash(data)); err == nil {
		t.Fatal("interpreted warm-backup journal as cold backup")
	}
}

func migrationFixture(t *testing.T) (*serviceMigration, migrationHooks, *[]string) {
	t.Helper()
	j, err := createServiceMigration(t.TempDir(), migrationIdentity{3, "source.hb12", "target.hb13", evidenceHash([]byte("source")), evidenceHash([]byte("target"))})
	if err != nil {
		t.Fatal(err)
	}
	calls := []string{}
	action := func(name string) func() error { return func() error { calls = append(calls, name); return nil } }
	h := migrationHooks{AssertHeld: func() error { return nil }, ValidateSource: action("source-health"), CaptureBackup: action("backup"), VerifyBackup: action("verify-backup"), StopSource: action("stop"), ReserveDisks: action("reserve"), QuiesceDisks: action("quiesce"), ResumeSource: action("resume"), Replace: action("replace"), ValidateTarget: action("target-health"), RestoreSource: action("restore"), AppSelection: func() (string, error) { return "source", nil }}
	h.AuthorizeCommit = func() error { return nil }
	h.PauseSource = action("pause")
	return j, h, &calls
}

func TestMigrationTargetSelectionDoesNotAuthorizePairCommit(t *testing.T) {
	j, h, _ := migrationFixture(t)
	if err := j.run(h); err != nil {
		t.Fatal(err)
	}
	h.AppSelection = func() (string, error) { return "target", nil }
	h.AuthorizeCommit = nil
	if err := j.recover(h); err == nil || j.state() != "ReadyForAppCommit" {
		t.Fatal("target selection committed without protected decision")
	}
}
func hasMigrationCall(calls []string, name string) bool {
	for _, call := range calls {
		if call == name {
			return true
		}
	}
	return false
}
func TestMigrationWaitsForApplicationCommit(t *testing.T) {
	j, h, _ := migrationFixture(t)
	if err := j.run(h); err != nil {
		t.Fatal(err)
	}
	if j.state() != "ReadyForAppCommit" {
		t.Fatal(j.state())
	}
	loaded, err := loadServiceMigration(j.directory, j.identitySHA256)
	if err != nil {
		t.Fatal(err)
	}
	h.AppSelection = func() (string, error) { return "target", nil }
	if err = loaded.recover(h); err != nil {
		t.Fatal(err)
	}
	if loaded.state() != "Committed" {
		t.Fatal(loaded.state())
	}
}

func TestMigrationRecoveryRejectsConflictingTerminalApplication(t *testing.T) {
	for _, state := range []string{"Prepared", "Failed", "Resumed", "RolledBack", "Committed"} {
		t.Run(state, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			switch state {
			case "Failed":
				if err := j.recover(h); err != nil {
					t.Fatal(err)
				}
			case "Resumed":
				if err := j.mark("Reserving"); err != nil {
					t.Fatal(err)
				}
				if err := j.recover(h); err != nil {
					t.Fatal(err)
				}
			case "RolledBack", "Committed":
				if err := j.run(h); err != nil {
					t.Fatal(err)
				}
				if state == "Committed" {
					h.AppSelection = func() (string, error) { return "target", nil }
				}
				if err := j.recover(h); err != nil {
					t.Fatal(err)
				}
			}
			conflicting := "target"
			if state == "Committed" {
				conflicting = "source"
			}
			for _, selection := range []string{"unknown", conflicting} {
				before := len(*calls)
				h.AppSelection = func() (string, error) { return selection, nil }
				if err := j.recover(h); err == nil {
					t.Fatal("accepted conflicting application")
				}
				if j.state() != state || len(*calls) != before {
					t.Fatal("recovery acted despite conflicting application")
				}
			}
		})
	}
}
func TestMigrationUnverifiedBackupCannotReplaceService(t *testing.T) {
	for _, failure := range []string{"capture", "verify"} {
		t.Run(failure, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			fail := func() error { return errors.New("backup unavailable") }
			if failure == "capture" {
				h.CaptureBackup = fail
			} else {
				h.VerifyBackup = fail
			}
			if err := j.run(h); err == nil {
				t.Fatal("accepted failed backup")
			}
			if !hasMigrationCall(*calls, "resume") || hasMigrationCall(*calls, "replace") || hasMigrationCall(*calls, "restore") {
				t.Fatal(*calls)
			}
			if err := j.recover(h); err != nil {
				t.Fatal(err)
			}
			if j.state() != "Resumed" {
				t.Fatal(j.state())
			}
		})
	}
}
func TestMigrationOperationFailuresRestoreSource(t *testing.T) {
	for _, failure := range []string{"replace", "health"} {
		t.Run(failure, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			fail := func() error { return errors.New("injected operation failure") }
			switch failure {
			case "stop":
				h.StopSource = fail
			case "replace":
				h.Replace = fail
			case "health":
				h.ValidateTarget = fail
			}
			if err := j.run(h); err == nil {
				t.Fatal("operation failure lost")
			}
			if j.state() != "RolledBack" || !hasMigrationCall(*calls, "restore") {
				t.Fatalf("%s %v", j.state(), *calls)
			}
		})
	}
}
func TestMigrationEveryInterruptedMutationRollsBack(t *testing.T) {
	states := []string{"Reserving", "Reserved", "Stopping", "Stopped", "Quiescing", "Quiesced", "BackingUp", "BackupVerified", "Replacing", "Replaced", "Validating", "ReadyForAppCommit", "RollingBack"}
	for index, state := range states {
		if index < 8 {
			continue
		}
		t.Run(state, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			for _, step := range states[:index+1] {
				if err := j.mark(step); err != nil {
					t.Fatal(err)
				}
			}
			loaded, err := loadServiceMigration(j.directory, j.identitySHA256)
			if err != nil {
				t.Fatal(err)
			}
			if err = loaded.recover(h); err != nil {
				t.Fatal(err)
			}
			if loaded.state() != "RolledBack" || !hasMigrationCall(*calls, "restore") {
				t.Fatalf("%s %v", loaded.state(), *calls)
			}
		})
	}
}
func TestMigrationUnknownAppOrLostLockPreventsRollback(t *testing.T) {
	for _, failure := range []string{"unknown-app", "lock", "backup"} {
		t.Run(failure, func(t *testing.T) {
			j, h, calls := migrationFixture(t)
			if err := j.run(h); err != nil {
				t.Fatal(err)
			}
			switch failure {
			case "unknown-app":
				h.AppSelection = func() (string, error) { return "unknown", nil }
			case "lock":
				h.AssertHeld = func() error { return errors.New("lost ownership") }
			case "backup":
				h.VerifyBackup = func() error { return errors.New("changed backup") }
			}
			if err := j.recover(h); err == nil {
				t.Fatal("unsafe recovery accepted")
			}
			if hasMigrationCall(*calls, "restore") {
				t.Fatal("restored without authority")
			}
		})
	}
}
func TestMigrationFailedRestoreRemainsRecoverable(t *testing.T) {
	j, h, _ := migrationFixture(t)
	if err := j.run(h); err != nil {
		t.Fatal(err)
	}
	restore := h.RestoreSource
	h.RestoreSource = func() error { return errors.New("interrupted restore") }
	if err := j.recover(h); err == nil {
		t.Fatal("restore failure lost")
	}
	if j.state() != "RollingBack" {
		t.Fatal(j.state())
	}
	loaded, err := loadServiceMigration(j.directory, j.identitySHA256)
	if err != nil {
		t.Fatal(err)
	}
	h.RestoreSource = restore
	if err = loaded.recover(h); err != nil {
		t.Fatal(err)
	}
	if loaded.state() != "RolledBack" {
		t.Fatal(loaded.state())
	}
}
func TestMigrationJournalRejectsTamperingAndPreservesPartial(t *testing.T) {
	j, _, _ := migrationFixture(t)
	partial := filepath.Join(j.directory, "interrupted.partial")
	if err := os.WriteFile(partial, []byte("incomplete"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadServiceMigration(j.directory, j.identitySHA256); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(partial); err != nil {
		t.Fatal("lost partial evidence")
	}
	if err := os.WriteFile(filepath.Join(j.directory, "001.json"), []byte("{}"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := loadServiceMigration(j.directory, j.identitySHA256); err == nil {
		t.Fatal("accepted changed record")
	}
}
