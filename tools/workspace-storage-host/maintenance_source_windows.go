//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"

	"golang.org/x/sys/windows"
)

// A source evidence pin authorizes only the original executable/config/receipt,
// not arbitrary service files or a complete store restore. Keep this guard for
// the entire stop/resume operation; release it before exclusive cold backup or
// replacement. Resume must acquire a new guard against the original evidence.
type maintenanceSource struct {
	expected   serviceEvidence
	held       *verifiedColdBackup
	assertHeld func() error
}

func holdMaintenanceSource(expected serviceEvidence, assertHeld func() error) (*maintenanceSource, error) {
	if expected.SchemaVersion != 1 || assertHeld == nil || !migrationDigest(expected.ReceiptSHA256) || !migrationDigest(expected.ConfigSHA256) || !migrationDigest(expected.ExecutableSHA256) {
		return nil, errors.New("pinned source component evidence required")
	}
	if err := assertHeld(); err != nil {
		return nil, err
	}
	r := expected.Receipt
	if !filepath.IsAbs(r.StoreRoot) || r.ConfigPath != filepath.Join(r.StoreRoot, "broker-config.json") || r.Executable != filepath.Join(r.StoreRoot, "broker", "unity-workspace-storage-host.exe") {
		return nil, errors.New("noncanonical source component paths")
	}
	s := &maintenanceSource{expected: expected, assertHeld: assertHeld, held: &verifiedColdBackup{files: map[string]*os.File{}, directories: map[string]windows.Handle{}}}
	for _, path := range []string{filepath.Join(r.StoreRoot, "install-receipt.json"), r.ConfigPath, r.Executable} {
		if _, _, err := s.held.openFile(path); err != nil {
			s.close()
			return nil, err
		}
	}
	if err := s.verify(); err != nil {
		s.close()
		return nil, err
	}
	return s, nil
}

func (s *maintenanceSource) close() {
	if s.held != nil {
		s.held.close()
		s.held = nil
	}
}

func (s *maintenanceSource) verify() error {
	if s.held == nil || len(s.held.files) != 3 {
		return errors.New("source component handles released")
	}
	if err := s.assertHeld(); err != nil {
		return err
	}
	r := s.expected.Receipt
	// Reuse receipt/config semantics and command admission while read handles
	// prevent byte changes. SCM is checked independently by maintenanceService;
	// expected.SCM is the pinned original running identity, not a live-state claim.
	actual, err := inspectServiceEvidence(filepath.Join(r.StoreRoot, "install-receipt.json"), r.UserSID, s.expected.SCM)
	if err != nil {
		return err
	}
	if actual != s.expected {
		return errors.New("source components differ from pinned evidence")
	}
	return s.assertHeld()
}

// Bind the concrete verifier for exactly one stop/resume call. The callback
// lifetime ends here so later backup copying can acquire exclusive handles.
func (s *maintenanceService) withSourceEvidence(expected serviceEvidence, operation func(*maintenanceService) error) error {
	if operation == nil {
		return errors.New("source maintenance operation required")
	}
	if s.original.BinaryPathName != expected.SCM.Command || s.original.ServiceStartName != expected.SCM.Account || s.original.ServiceType != expected.SCM.ServiceType || s.original.StartType != expected.SCM.StartType {
		return errors.New("source evidence belongs to a different service configuration")
	}
	guard, err := holdMaintenanceSource(expected, s.assertHeld)
	if err != nil {
		return err
	}
	defer guard.close()
	bound := *s
	bound.verifySourceFiles = guard.verify
	return operation(&bound)
}
