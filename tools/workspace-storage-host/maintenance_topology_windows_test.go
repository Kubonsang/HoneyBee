//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
)

func TestLoadedBackingParentRequiresAdmittedChildAndNoDirectAttachment(t *testing.T) {
	for _, tc := range []struct {
		name                                   string
		parent, attached, queryError, wantPass bool
	}{
		{"backing parent", true, false, false, true},
		{"independent parent mount", true, true, false, false},
		{"orphan image", false, false, false, false},
		{"foreign mounted image", false, true, false, false},
		{"unknown attachment", true, false, true, false},
	} {
		t.Run(tc.name, func(t *testing.T) {
			calls := 0
			err := admitLoadedBackingImage("parent.vhdx", tc.parent, func(string) (bool, error) {
				calls++
				if tc.queryError {
					return false, errors.New("access denied")
				}
				return tc.attached, nil
			})
			if (err == nil) != tc.wantPass {
				t.Fatalf("unexpected admission: %v", err)
			}
			if !tc.parent && calls != 0 {
				t.Fatal("unowned image received an exception")
			}
		})
	}
}

func topologyLeaseFixture(t *testing.T) (installReceipt, workspace.LeaseJournal) {
	t.Helper()
	root := t.TempDir()
	r := installReceipt{StoreRoot: filepath.Join(root, "store"), WorkspaceRoot: filepath.Join(root, "workspaces"), UserSID: "S-1-5-21-1-2-3-1001"}
	paths, err := workspace.NewPaths(r.StoreRoot, r.UserSID)
	if err != nil {
		t.Fatal(err)
	}
	for _, dir := range []string{paths.Pending, paths.Quarantine, paths.Leases} {
		if err := os.MkdirAll(dir, 0700); err != nil {
			t.Fatal(err)
		}
	}
	l := workspace.LeaseJournal{SchemaVersion: workspace.LeaseJournalSchemaVersion, LeaseID: "lease-1", RunID: "run-1", WorkspaceID: "workspace-1", UserSID: r.UserSID, OwnershipToken: "token-1", ParentKey: strings.Repeat("a", 64), Retained: true, State: "ready", FileIdentity: workspace.FileIdentity{FileID: "fixture-id"}}
	l.ChildPath, _ = paths.Child(l.LeaseID)
	p, _ := paths.Parent(l.ParentKey)
	l.ParentPath = filepath.Join(p, "parent.vhdx")
	l.WorkspacePath = filepath.Join(r.WorkspaceRoot, l.WorkspaceID)
	l.MountPath = filepath.Join(l.WorkspacePath, "Library")
	return r, l
}

func TestMaintenanceTopologyRejectsSkippedCorruptLease(t *testing.T) {
	r, l := topologyLeaseFixture(t)
	paths, _ := workspace.NewPaths(r.StoreRoot, r.UserSID)
	data, _ := json.Marshal(l)
	if err := os.WriteFile(filepath.Join(paths.Leases, l.LeaseID+".json"), data, 0600); err != nil {
		t.Fatal(err)
	}
	leases, err := readMaintenanceLeases(r.StoreRoot, r.UserSID, func() error { return nil })
	if err != nil || len(leases) != 1 {
		t.Fatalf("leases: %v", err)
	}
	if err := os.WriteFile(filepath.Join(paths.Leases, "broken.json"), []byte("{"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := readMaintenanceLeases(r.StoreRoot, r.UserSID, func() error { return nil }); err == nil {
		t.Fatal("corrupt lease omitted")
	}
}

func TestMaintenanceTopologyRefusesForeignAndTransientBindings(t *testing.T) {
	r, l := topologyLeaseFixture(t)
	if err := validateMaintenanceLease(l, r); err != nil {
		t.Fatal(err)
	}
	for _, change := range []func(*workspace.LeaseJournal){
		func(l *workspace.LeaseJournal) { l.Retained = false },
		func(l *workspace.LeaseJournal) { l.State = "releasing" },
		func(l *workspace.LeaseJournal) { l.UserSID = "S-1-5-18" },
		func(l *workspace.LeaseJournal) { l.ChildPath = filepath.Join(r.WorkspaceRoot, "other.vhdx") },
		func(l *workspace.LeaseJournal) { l.MountPath = filepath.Join(r.WorkspaceRoot, "other", "Library") },
		func(l *workspace.LeaseJournal) { l.WorkspaceID = "../other" },
		func(l *workspace.LeaseJournal) { l.FileIdentity.FileID = "" },
	} {
		v := l
		change(&v)
		if err := validateMaintenanceLease(v, r); err == nil {
			t.Fatalf("admitted changed lease: %+v", v)
		}
	}
}
