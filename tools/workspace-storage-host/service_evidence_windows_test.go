//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc/mgr"
	"os"
	"path/filepath"
	"testing"
)

func evidenceFixture(t *testing.T) (string, installReceipt, serviceIdentity) {
	t.Helper()
	p, r := admissionFixture(t)
	r.Executable = filepath.Join(r.StoreRoot, "broker", "unity-workspace-storage-host.exe")
	os.MkdirAll(filepath.Dir(r.Executable), 0700)
	os.MkdirAll(r.WorkspaceRoot, 0700)
	binary := []byte("original service executable")
	r.ExecutableSHA256 = evidenceHash(binary)
	write := func(p string, v any) {
		b, e := json.Marshal(v)
		if e != nil {
			t.Fatal(e)
		}
		if e = os.WriteFile(p, b, 0600); e != nil {
			t.Fatal(e)
		}
	}
	os.WriteFile(r.Executable, binary, 0600)
	write(p, r)
	write(r.ConfigPath, expectedServiceConfig(r))
	scm := serviceIdentity{windows.ComposeCommandLine([]string{r.Executable, "broker-run", "--service-config", r.ConfigPath}), "LocalSystem", mgr.StartAutomatic, windows.SERVICE_WIN32_OWN_PROCESS, "running"}
	return p, r, scm
}
func TestServiceEvidenceIdentity(t *testing.T) {
	p, r, scm := evidenceFixture(t)
	evidence, err := inspectServiceEvidence(p, r.UserSID, scm)
	if err != nil {
		t.Fatal(err)
	}
	if evidence.RecoveryReady || evidence.ExecutableSHA256 != r.ExecutableSHA256 {
		t.Fatal("bad evidence authority or identity")
	}
	for _, change := range []func(*serviceIdentity){func(s *serviceIdentity) { s.Account = "other" }, func(s *serviceIdentity) { s.Command += " --replace" }, func(s *serviceIdentity) { s.StartType = mgr.StartDisabled }, func(s *serviceIdentity) { s.State = "stopped" }, func(s *serviceIdentity) { s.ServiceType = windows.SERVICE_WIN32_SHARE_PROCESS }} {
		altered := scm
		change(&altered)
		if _, err := inspectServiceEvidence(p, r.UserSID, altered); err == nil {
			t.Fatal("accepted altered SCM identity")
		}
	}
	if _, err := inspectServiceEvidence(p, "other-user", scm); err == nil {
		t.Fatal("accepted another user")
	}
}
func TestServiceEvidenceRejectsDamagedSources(t *testing.T) {
	for _, kind := range []string{"binary", "config", "receipt", "pending", "trailing"} {
		t.Run(kind, func(t *testing.T) {
			p, r, scm := evidenceFixture(t)
			switch kind {
			case "binary":
				os.WriteFile(r.Executable, []byte("tampered"), 0600)
			case "config":
				os.WriteFile(r.ConfigPath, []byte("{}"), 0600)
			case "receipt":
				os.WriteFile(p, []byte("{}"), 0600)
			case "pending":
				n, _ := replacementPaths(r.Executable)
				os.WriteFile(n, []byte("pending"), 0600)
			case "trailing":
				b, _ := os.ReadFile(p)
				os.WriteFile(p, append(b, []byte(" {}")...), 0600)
			}
			if _, err := inspectServiceEvidence(p, r.UserSID, scm); err == nil {
				t.Fatal("accepted damaged source")
			}
		})
	}
}
func TestServiceEvidenceBackup(t *testing.T) {
	p, r, scm := evidenceFixture(t)
	capture := func() (serviceEvidence, error) { return inspectServiceEvidence(p, r.UserSID, scm) }
	dest := filepath.Join(t.TempDir(), "backup")
	result, err := backupServiceEvidence(dest, capture, func(string) error { return nil })
	if err != nil {
		t.Fatal(err)
	}
	if result.RecoveryReady {
		t.Fatal("component backup authorized migration")
	}
	for name, digest := range map[string]string{"install-receipt.json": result.ReceiptSHA256, "broker-config.json": result.ConfigSHA256, "broker.exe": result.ExecutableSHA256} {
		b, e := os.ReadFile(filepath.Join(dest, name))
		if e != nil || evidenceHash(b) != digest {
			t.Fatal("backup mismatch")
		}
	}
	if _, err := backupServiceEvidence(dest, capture, func(string) error { return nil }); err == nil {
		t.Fatal("overwrote backup")
	}
	for _, dest := range []string{filepath.Join(r.StoreRoot, "backup"), filepath.Join(r.WorkspaceRoot, "backup")} {
		if _, err := backupServiceEvidence(dest, capture, func(string) error { return nil }); err == nil {
			t.Fatal("backup overlapped live data")
		}
	}
}
func TestServiceEvidenceBackupInterruption(t *testing.T) {
	for _, point := range []string{"install-receipt.json", "broker-config.json", "broker.exe", "source-change", "copy-change"} {
		t.Run(point, func(t *testing.T) {
			p, r, scm := evidenceFixture(t)
			capture := func() (serviceEvidence, error) { return inspectServiceEvidence(p, r.UserSID, scm) }
			dest := filepath.Join(t.TempDir(), "backup")
			_, err := backupServiceEvidence(dest, capture, func(name string) error {
				if point == name {
					return errors.New("injected write interruption")
				}
				if name == "broker.exe" && point == "source-change" {
					scm.StartType = mgr.StartDisabled
				}
				if name == "broker.exe" && point == "copy-change" {
					return os.WriteFile(filepath.Join(dest, "install-receipt.json"), []byte("changed"), 0600)
				}
				return nil
			})
			if err == nil {
				t.Fatal("accepted interrupted/changed backup")
			}
			if _, err := os.Stat(filepath.Join(dest, "002-Captured.json")); !os.IsNotExist(err) {
				t.Fatal("committed incomplete evidence")
			}
			if _, err := os.Stat(filepath.Join(dest, "001-Capturing.json")); err != nil {
				t.Fatal("lost partial evidence")
			}
			if _, err := os.Stat(r.Executable); err != nil {
				t.Fatal("source removed")
			}
		})
	}
}

func TestServiceEvidenceArguments(t *testing.T) {
	for _, args := range [][]string{{"service-evidence", "--replace"}, {"service-evidence", "--backup-directory"}, {"service-evidence", "--backup-directory", "x", "extra"}} {
		if _, err := execute(args); err == nil {
			t.Fatal("accepted unsupported evidence command")
		}
	}
}
