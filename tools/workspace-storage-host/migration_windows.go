//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
)

// Internal coordinator: no CLI exposes this until coherent backup and privileged
// SCM adapters exist. Caller must own a machine-wide lock and a protected journal.
type migrationHooks struct {
	AssertHeld      func() error
	ValidateSource  func() error
	CaptureBackup   func() error // includes sustained quiescence of all storage writers
	VerifyBackup    func() error // must prove a coherent, restorable store/workspace backup
	StopSource      func() error
	PauseSource     func() error // drain pipe operations and background recovery before topology capture
	ReserveDisks    func() error // persist topology and hold all volume/image locks before service exit
	QuiesceDisks    func() error // durable mount inventory, flush and non-forced detach confirmation
	ResumeSource    func() error // restore original mounts/service without using an incomplete backup
	Replace         func() error // binary, configuration and receipt are one recovery unit
	ValidateTarget  func() error
	RestoreSource   func() error           // idempotent even after partial replacement/restoration
	AppSelection    func() (string, error) // source, target, or unknown; never inferred from service state
	AuthorizeCommit func() error           // protected pair decision after Doctor AND isolated Desktop readiness
}

type migrationIdentity struct {
	SchemaVersion        int    `json:"schemaVersion"`
	SourceComponent      string `json:"sourceComponent"`
	TargetComponent      string `json:"targetComponent"`
	SourceEvidenceSHA256 string `json:"sourceEvidenceSha256"`
	TargetManifestSHA256 string `json:"targetManifestSha256"`
}
type migrationRecord struct {
	SchemaVersion  int    `json:"schemaVersion"`
	State          string `json:"state"`
	IdentitySHA256 string `json:"identitySha256"`
	PreviousSHA256 string `json:"previousSha256"`
}
type serviceMigration struct {
	persist                   func(string, []byte) error
	closePrivate              func()
	directory, identitySHA256 string
	states                    []string
	lastSHA256                string
}

var migrationTransitions = map[string][]string{
	"": {"Prepared"}, "Prepared": {"Reserving", "Failed"},
	"Reserving": {"Reserved", "Resuming"}, "Reserved": {"Stopping", "Resuming"},
	"Stopping": {"Stopped", "Resuming"}, "Stopped": {"Quiescing", "Resuming"},
	"Quiescing": {"Quiesced", "Resuming"}, "Quiesced": {"BackingUp", "Resuming"},
	"BackingUp": {"BackupVerified", "Resuming"}, "BackupVerified": {"Replacing", "Resuming"},
	"Resuming": {"Resumed"}, "Replacing": {"Replaced", "RollingBack"},
	"Replaced": {"Validating", "RollingBack"}, "Validating": {"ReadyForAppCommit", "RollingBack"},
	"ReadyForAppCommit": {"Committed", "RollingBack"}, "RollingBack": {"RolledBack"},
}

func migrationTransition(from, to string) bool {
	for _, next := range migrationTransitions[from] {
		if next == to {
			return true
		}
	}
	return false
}
func migrationDigest(s string) bool {
	if len(s) != 64 {
		return false
	}
	for _, c := range s {
		if !(c >= '0' && c <= '9' || c >= 'a' && c <= 'f') {
			return false
		}
	}
	return true
}
func createServiceMigration(parent string, identity migrationIdentity) (*serviceMigration, error) {
	if identity.SchemaVersion != 3 || identity.SourceComponent == "" || identity.TargetComponent == "" || identity.SourceComponent == identity.TargetComponent || !migrationDigest(identity.SourceEvidenceSHA256) || !migrationDigest(identity.TargetManifestSHA256) {
		return nil, errors.New("invalid migration identity")
	}
	if err := inspectLocalPath(parent); err != nil {
		return nil, err
	}
	directory, err := os.MkdirTemp(parent, "migration-")
	if err != nil {
		return nil, err
	}
	data, err := json.Marshal(identity)
	if err != nil {
		return nil, err
	}
	if err = writeEvidenceFile(filepath.Join(directory, "identity.json"), data); err != nil {
		return nil, err
	}
	journal := &serviceMigration{directory: directory, identitySHA256: evidenceHash(data)}
	if err = journal.mark("Prepared"); err != nil {
		return nil, err
	}
	return journal, nil
}
func loadServiceMigration(directory, identitySHA256 string) (*serviceMigration, error) {
	return loadServiceMigrationUsing(directory, identitySHA256, func(name string) ([]byte, error) { return evidenceBytes(filepath.Join(directory, name), 64<<10) })
}

func loadServiceMigrationUsing(directory, identitySHA256 string, read func(string) ([]byte, error)) (*serviceMigration, error) {
	if !migrationDigest(identitySHA256) {
		return nil, errors.New("migration identity pin required")
	}
	if err := inspectLocalPath(directory); err != nil {
		return nil, err
	}
	identity, err := read("identity.json")
	if err != nil {
		return nil, err
	}
	if evidenceHash(identity) != identitySHA256 {
		return nil, errors.New("migration identity changed")
	}
	var binding migrationIdentity
	if err := json.Unmarshal(identity, &binding); err != nil || binding.SchemaVersion != 3 {
		return nil, errors.New("migration requires reserved-volume protocol 3")
	}
	journal := &serviceMigration{directory: directory, identitySHA256: identitySHA256}
	entries, err := os.ReadDir(directory)
	if err != nil {
		return nil, err
	}
	if len(entries) > 128 {
		return nil, errors.New("migration journal exceeds bounded history")
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "identity.json" {
			continue
		}
		// Interrupted writes have no state authority; keep them as evidence.
		if filepath.Ext(name) == ".partial" {
			if _, err := read(name); err != nil {
				return nil, err
			}
			continue
		}
		expected := fmt.Sprintf("%03d.json", len(journal.states)+1)
		if name != expected {
			return nil, errors.New("unknown or discontinuous migration journal")
		}
		data, err := read(name)
		if err != nil {
			return nil, err
		}
		var record migrationRecord
		if err = json.Unmarshal(data, &record); err != nil {
			return nil, err
		}
		if record.SchemaVersion != 1 || record.IdentitySHA256 != identitySHA256 || record.PreviousSHA256 != journal.lastSHA256 || !migrationTransition(journal.state(), record.State) {
			return nil, errors.New("invalid migration history")
		}
		journal.states = append(journal.states, record.State)
		journal.lastSHA256 = evidenceHash(data)
	}
	if len(journal.states) == 0 {
		return nil, errors.New("migration preparation incomplete")
	}
	return journal, nil
}
func (j *serviceMigration) state() string {
	if len(j.states) == 0 {
		return ""
	}
	return j.states[len(j.states)-1]
}
func (j *serviceMigration) mark(state string) error {
	if !migrationTransition(j.state(), state) {
		return errors.New("invalid migration transition")
	}
	data, err := json.Marshal(migrationRecord{1, state, j.identitySHA256, j.lastSHA256})
	if err != nil {
		return err
	}
	if j.persist != nil {
		if err := j.persist(fmt.Sprintf("%03d.json", len(j.states)+1), data); err != nil {
			return err
		}
		j.states = append(j.states, state)
		j.lastSHA256 = evidenceHash(data)
		return qualificationMigrationCheckpoint(j, state)
	}
	temporary, err := os.CreateTemp(j.directory, "state-*.partial")
	if err != nil {
		return err
	}
	_, writeErr := temporary.Write(data)
	syncErr := temporary.Sync()
	closeErr := temporary.Close()
	if err = errors.Join(writeErr, syncErr, closeErr); err != nil {
		return err
	}
	destination := filepath.Join(j.directory, fmt.Sprintf("%03d.json", len(j.states)+1))
	// Publish exclusively. A prior state file is never overwritten.
	if err = os.Link(temporary.Name(), destination); err != nil {
		return err
	}
	j.states = append(j.states, state)
	j.lastSHA256 = evidenceHash(data)
	// Keep temporary aliases as interruption evidence; cleanup is a separate policy.
	return nil
}
func validateMigrationHooks(h migrationHooks) error {
	if h.AssertHeld == nil || h.ValidateSource == nil || h.CaptureBackup == nil || h.VerifyBackup == nil || h.StopSource == nil || h.PauseSource == nil || h.ReserveDisks == nil || h.QuiesceDisks == nil || h.ResumeSource == nil || h.Replace == nil || h.ValidateTarget == nil || h.RestoreSource == nil || h.AppSelection == nil {
		return errors.New("complete migration adapters required")
	}
	return h.AssertHeld()
}
func (j *serviceMigration) step(h migrationHooks, state string, action func() error) error {
	if err := h.AssertHeld(); err != nil {
		return err
	}
	if err := j.mark(state); err != nil {
		return err
	}
	if err := h.AssertHeld(); err != nil {
		return err
	}
	return action()
}
func (j *serviceMigration) rollback(h migrationHooks) error {
	if err := h.AssertHeld(); err != nil {
		return err
	}
	selection, err := h.AppSelection()
	if err != nil {
		return err
	}
	if selection != "source" {
		return errors.New("application selection does not permit service rollback")
	}
	if err = h.VerifyBackup(); err != nil {
		return err
	}
	if j.state() != "RollingBack" {
		if err = j.step(h, "RollingBack", func() error { return nil }); err != nil {
			return err
		}
	}
	if err = h.AssertHeld(); err != nil {
		return err
	}
	if err = h.RestoreSource(); err != nil {
		return err
	}
	if err = h.ValidateSource(); err != nil {
		return err
	}
	return j.step(h, "RolledBack", func() error { return nil })
}
func (j *serviceMigration) run(h migrationHooks) error {
	if err := validateMigrationHooks(h); err != nil {
		return err
	}
	if j.state() != "Prepared" {
		return errors.New("existing migration requires explicit recovery")
	}
	selection, err := h.AppSelection()
	if err != nil {
		return err
	}
	if selection != "source" {
		return errors.New("migration requires the source application")
	}
	if err := h.ValidateSource(); err != nil {
		return err
	}
	for _, step := range []struct {
		state  string
		action func() error
	}{
		{"Reserving", func() error {
			if err := h.PauseSource(); err != nil {
				return err
			}
			if err := h.AssertHeld(); err != nil {
				return err
			}
			return h.ReserveDisks()
		}}, {"Reserved", func() error { return nil }},
		{"Stopping", h.StopSource}, {"Stopped", func() error { return nil }},
		{"Quiescing", h.QuiesceDisks}, {"Quiesced", func() error { return nil }},
		{"BackingUp", h.CaptureBackup},
	} {
		if err := j.step(h, step.state, step.action); err != nil {
			return errors.Join(err, j.recover(h))
		}
	}
	if err := h.VerifyBackup(); err != nil {
		return errors.Join(err, j.recover(h))
	}
	if err := j.step(h, "BackupVerified", func() error { return nil }); err != nil {
		return errors.Join(err, j.recover(h))
	}
	for _, step := range []struct {
		state  string
		action func() error
	}{
		{"Replacing", h.Replace},
		{"Replaced", func() error { return nil }}, {"Validating", h.ValidateTarget}, {"ReadyForAppCommit", func() error { return nil }},
	} {
		if err := j.step(h, step.state, step.action); err != nil {
			return errors.Join(err, j.rollback(h))
		}
	}
	return nil
}
func (j *serviceMigration) recover(h migrationHooks) error {
	if err := validateMigrationHooks(h); err != nil {
		return err
	}
	// A healthy service alone cannot establish a compatible application/service
	// pair, including when replaying an already terminal journal.
	selection, err := h.AppSelection()
	if err != nil {
		return err
	}
	if selection != "source" && selection != "target" {
		return errors.New("unknown application selection blocks service recovery")
	}
	switch j.state() {
	case "Prepared":
		if selection != "source" {
			return errors.New("prepared migration requires source application")
		}
		if err := h.ValidateSource(); err != nil {
			return err
		}
		return j.step(h, "Failed", func() error { return nil })
	case "Committed":
		if selection != "target" {
			return errors.New("committed migration requires target application")
		}
		return h.ValidateTarget()
	case "RolledBack", "Failed", "Resumed":
		if selection != "source" {
			return errors.New("restored migration requires source application")
		}
		return h.ValidateSource()
	case "Reserving", "Reserved", "Stopping", "Stopped", "Quiescing", "Quiesced", "BackingUp", "BackupVerified", "Resuming":
		selection, err := h.AppSelection()
		if err != nil {
			return err
		}
		if selection != "source" {
			return errors.New("original service resume requires source application")
		}
		if j.state() != "Resuming" {
			if err = j.step(h, "Resuming", func() error { return nil }); err != nil {
				return err
			}
		}
		if err = h.AssertHeld(); err != nil {
			return err
		}
		if err = h.ResumeSource(); err != nil {
			return err
		}
		if err = h.ValidateSource(); err != nil {
			return err
		}
		return j.step(h, "Resumed", func() error { return nil })
	}
	selection, err = h.AppSelection()
	if err != nil {
		return err
	}
	if selection == "target" && j.state() == "ReadyForAppCommit" {
		if h.AuthorizeCommit == nil {
			return errors.New("protected application/service commit decision required")
		}
		if err = h.AuthorizeCommit(); err != nil {
			return err
		}
		if err = h.ValidateTarget(); err != nil {
			return err
		}
		return j.step(h, "Committed", func() error { return nil })
	}
	return j.rollback(h)
}
