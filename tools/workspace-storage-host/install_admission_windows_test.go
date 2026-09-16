//go:build windows

package main

import (
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
)

func admissionFixture(t *testing.T) (string, installReceipt) {
	t.Helper()
	root := t.TempDir()
	store := filepath.Join(root, "store")
	receipt := installReceipt{
		SchemaVersion: receiptSchema, ServiceName: workspace.WindowsServiceName,
		PipeName: workspace.DefaultPipeName, ComponentVersion: "test-version",
		StoreRoot: store, WorkspaceRoot: filepath.Join(root, "workspaces"),
		ConfigPath:       filepath.Join(store, "broker-config.json"),
		Executable:       filepath.Join(store, "broker", "host.exe"),
		ExecutableSHA256: strings.Repeat("a", 64), UserSID: "S-1-5-21-1",
	}
	return filepath.Join(store, "install-receipt.json"), receipt
}

func TestAdmissionFreshIsReadOnly(t *testing.T) {
	target, receipt := admissionFixture(t)
	if err := inspectInstallAdmission(target, receipt, windows.ERROR_SERVICE_DOES_NOT_EXIST, false); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{receipt.StoreRoot, receipt.WorkspaceRoot} {
		if _, err := os.Stat(root); !os.IsNotExist(err) {
			t.Fatal("admission created a directory")
		}
	}
}

func TestAdmissionSCMErrorsAreNotMissingServices(t *testing.T) {
	for _, scmErr := range []error{windows.ERROR_ACCESS_DENIED, windows.ERROR_SERVICE_MARKED_FOR_DELETE, errors.New("RPC failed")} {
		target, receipt := admissionFixture(t)
		if err := inspectInstallAdmission(target, receipt, scmErr, false); !errors.Is(err, scmErr) {
			t.Fatalf("SCM failure lost: %v", err)
		}
		if _, err := os.Stat(receipt.StoreRoot); !os.IsNotExist(err) {
			t.Fatal("SCM failure mutated store")
		}
	}
}

func TestAdmissionRejectsUnownedDataAndService(t *testing.T) {
	for _, kind := range []string{"service", "store", "workspace"} {
		t.Run(kind, func(t *testing.T) {
			target, receipt := admissionFixture(t)
			serviceErr := error(windows.ERROR_SERVICE_DOES_NOT_EXIST)
			if kind == "service" {
				serviceErr = nil
			} else {
				root := receipt.StoreRoot
				if kind == "workspace" {
					root = receipt.WorkspaceRoot
				}
				if err := os.MkdirAll(root, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(root, "user-data"), []byte("preserve"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			if err := inspectInstallAdmission(target, receipt, serviceErr, false); err == nil {
				t.Fatal("unowned state admitted")
			}
			if _, err := os.Stat(target); !os.IsNotExist(err) {
				t.Fatal("receipt created during rejection")
			}
		})
	}
}

func TestAdmissionReceiptIdentityAndInterruptedEvidence(t *testing.T) {
	for _, kind := range []string{"matching", "previous", "other-user", "other-root", "other-version", "corrupt", "next-only"} {
		t.Run(kind, func(t *testing.T) {
			target, expected := admissionFixture(t)
			if err := os.MkdirAll(expected.StoreRoot, 0700); err != nil {
				t.Fatal(err)
			}
			actual := expected
			candidate := target
			next, previous := receiptReplacementPaths(target)
			switch kind {
			case "previous":
				candidate = previous
			case "next-only":
				candidate = next
			case "other-user":
				actual.UserSID = "S-1-5-21-2"
			case "other-root":
				actual.WorkspaceRoot += "-other"
			case "other-version":
				actual.ComponentVersion = "old"
			}
			if kind == "corrupt" {
				if err := os.WriteFile(candidate, []byte("invalid"), 0600); err != nil {
					t.Fatal(err)
				}
			} else if err := writeExclusiveJSON(candidate, actual); err != nil {
				t.Fatal(err)
			}
			before, err := os.ReadFile(candidate)
			if err != nil {
				t.Fatal(err)
			}
			err = inspectInstallAdmission(target, expected, windows.ERROR_SERVICE_DOES_NOT_EXIST, false)
			want := kind == "matching" || kind == "previous"
			if (err == nil) != want {
				t.Fatalf("admission result %v", err)
			}
			after, err := os.ReadFile(candidate)
			if err != nil || string(before) != string(after) {
				t.Fatal("recovery evidence changed")
			}
			if _, err := os.Stat(expected.WorkspaceRoot); !os.IsNotExist(err) {
				t.Fatal("workspace created during inspection")
			}
		})
	}
}

func TestAdmissionConfigAndBinaryMismatch(t *testing.T) {
	for _, kind := range []string{"config", "binary"} {
		target, expected := admissionFixture(t)
		if err := os.MkdirAll(filepath.Dir(expected.Executable), 0700); err != nil {
			t.Fatal(err)
		}
		if err := writeExclusiveJSON(target, expected); err != nil {
			t.Fatal(err)
		}
		if kind == "config" {
			config := expectedServiceConfig(expected)
			config.UserSID = "S-1-5-21-2"
			if err := workspace.SaveServiceConfig(expected.ConfigPath, config); err != nil {
				t.Fatal(err)
			}
		} else if err := os.WriteFile(expected.Executable, []byte("unknown binary"), 0600); err != nil {
			t.Fatal(err)
		}
		if err := inspectInstallAdmission(target, expected, windows.ERROR_SERVICE_DOES_NOT_EXIST, true); err == nil {
			t.Fatalf("%s conflict admitted", kind)
		}
	}
}

func TestAdmissionServiceCommandIsExact(t *testing.T) {
	_, receipt := admissionFixture(t)
	valid := `"` + receipt.Executable + `" broker-run --service-config "` + receipt.ConfigPath + `"`
	if err := verifyServiceCommand(valid, receipt); err != nil {
		t.Fatal(err)
	}
	for _, command := range []string{valid + " --other", strings.Replace(valid, "broker-run", "other", 1), `C:\unknown.exe broker-run --service-config "` + receipt.ConfigPath + `"`} {
		if err := verifyServiceCommand(command, receipt); err == nil {
			t.Fatal("foreign service command admitted")
		}
	}
}

func TestAdmissionRejectsOverlappingAndVolumeRoots(t *testing.T) {
	for _, kind := range []string{"same", "nested", "volume"} {
		target, receipt := admissionFixture(t)
		switch kind {
		case "same":
			receipt.WorkspaceRoot = receipt.StoreRoot
		case "nested":
			receipt.WorkspaceRoot = filepath.Join(receipt.StoreRoot, "child")
		case "volume":
			receipt.WorkspaceRoot = filepath.VolumeName(receipt.StoreRoot) + `\`
		}
		if err := inspectInstallAdmission(target, receipt, windows.ERROR_SERVICE_DOES_NOT_EXIST, false); err == nil {
			t.Fatal("unsafe root admitted")
		}
	}
}

func TestFreshOnlyNeverBecomesReplacement(t *testing.T) {
	if err := requireFreshService(windows.ERROR_SERVICE_DOES_NOT_EXIST, true); err != nil {
		t.Fatal(err)
	}
	for _, scmErr := range []error{nil, windows.ERROR_ACCESS_DENIED, windows.ERROR_SERVICE_MARKED_FOR_DELETE} {
		if err := requireFreshService(scmErr, true); err == nil {
			t.Fatal("fresh-only admitted an existing or unknown service")
		}
	}
	if _, err := execute([]string{"install", "--fresh-only", "--replace"}); err == nil {
		t.Fatal("contradictory flags accepted")
	}
}

func TestAdmissionCannotMigrateMissingServiceWithOldReceipt(t *testing.T) {
	target, expected := admissionFixture(t)
	if err := os.MkdirAll(expected.StoreRoot, 0700); err != nil {
		t.Fatal(err)
	}
	old := expected
	old.ComponentVersion = "old"
	if err := writeExclusiveJSON(target, old); err != nil {
		t.Fatal(err)
	}
	if err := inspectInstallAdmission(target, expected, windows.ERROR_SERVICE_DOES_NOT_EXIST, true); err == nil {
		t.Fatal("missing service was admitted as a migration")
	}
}
