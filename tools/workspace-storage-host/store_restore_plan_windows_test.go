//go:build windows

package main

import (
	"errors"
	"reflect"
	"testing"

	"golang.org/x/sys/windows"
)

func restorePlanInventory(dirs []string, files map[string]string) storeInventory {
	i := storeInventory{SchemaVersion: 1}
	for _, name := range append([]string{"."}, dirs...) {
		i.Entries = append(i.Entries, storeInventoryEntry{Name: name, Directory: true, Security: maintenanceSDDL, Attributes: windows.FILE_ATTRIBUTE_DIRECTORY})
	}
	for name, data := range files {
		i.Entries = append(i.Entries, storeInventoryEntry{Name: name, Size: int64(len(data)), SHA256: evidenceHash([]byte(data)), Security: maintenanceSDDL, Attributes: windows.FILE_ATTRIBUTE_ARCHIVE})
	}
	return i
}

func TestStoreRestorePlanDeterministicAndPreserving(t *testing.T) {
	current := restorePlanInventory([]string{"extra", "extra/child"}, map[string]string{"same": "a", "changed": "new", "extra/child/post": "preserve"})
	source := restorePlanInventory([]string{"original", "original/child"}, map[string]string{"same": "a", "changed": "old", "original/child/missing": "restore"})
	plan, err := planStoreRestore(current, source)
	if err != nil {
		t.Fatal(err)
	}
	if len(plan.Files) != 4 || len(plan.Metadata) != len(source.Entries) {
		t.Fatal("incomplete inventory plan")
	}
	if plan.CreateDirectories[0].Name != "original" || plan.CreateDirectories[1].Name != "original/child" {
		t.Fatal("parents not created first")
	}
	if plan.PreserveDirectories[0].Name != "extra/child" || plan.PreserveDirectories[1].Name != "extra" {
		t.Fatal("children not preserved first")
	}
	if plan.Metadata[0].Name != "." || plan.Metadata[1].Name != "original" || plan.Metadata[2].Name != "original/child" {
		t.Fatal("unsafe inheritance order")
	}
	for i, j := 0, len(source.Entries)-1; i < j; i, j = i+1, j-1 {
		source.Entries[i], source.Entries[j] = source.Entries[j], source.Entries[i]
	}
	reordered, err := planStoreRestore(current, source)
	if err != nil || !reflect.DeepEqual(plan, reordered) {
		t.Fatal("traversal order changed durable plan", err)
	}
	for _, step := range plan.Files {
		switch step.Name {
		case "same":
			if step.CurrentSHA256 != step.RestoredSHA256 {
				t.Fatal("unchanged file moved")
			}
		case "extra/child/post":
			if step.RestoredSHA256 != "" || step.CurrentSHA256 == "" {
				t.Fatal("post-backup identity lost")
			}
		case "original/child/missing":
			if step.CurrentSHA256 != "" || step.RestoredSHA256 == "" {
				t.Fatal("missing file not restored")
			}
		}
	}
}

func TestStoreRestorePlanRejectsStructuralConflicts(t *testing.T) {
	for _, source := range []storeInventory{
		restorePlanInventory([]string{"file"}, nil),
		restorePlanInventory(nil, map[string]string{"FILE": "data"}),
	} {
		if _, err := planStoreRestore(validRestoreInventory(), source); err == nil {
			t.Fatal("accepted ambiguous path transition")
		}
	}
}

func TestStoreRestoreCoordinatorStopsBeforeHealthOnFailure(t *testing.T) {
	current := restorePlanInventory([]string{"extra"}, map[string]string{"extra/post": "new"})
	source := restorePlanInventory([]string{"original"}, map[string]string{"original/file": "old"})
	for _, failAt := range []string{"persist", "mkdir", "file", "preserve", "metadata", "verify", "none"} {
		t.Run(failAt, func(t *testing.T) {
			failed := errors.New("injected " + failAt)
			var calls []string
			call := func(name string) error {
				calls = append(calls, name)
				if name == failAt {
					return failed
				}
				return nil
			}
			hooks := storeRestoreHooks{
				AssertStopped:     func() error { return nil },
				PersistPlan:       func(storeRestorePlan) error { return call("persist") },
				CreateDirectory:   func(storeInventoryEntry) error { return call("mkdir") },
				RestoreFile:       func(storeRestoreFileStep) error { return call("file") },
				PreserveDirectory: func(storeInventoryEntry) error { return call("preserve") },
				RestoreMetadata:   func(storeInventoryEntry) error { return call("metadata") },
				VerifyStore:       func(storeInventory) error { return call("verify") },
			}
			err := restoreStoreInventory(current, source, hooks)
			if failAt == "none" {
				if err != nil || calls[len(calls)-1] != "verify" {
					t.Fatal("did not verify final store", err)
				}
			} else if !errors.Is(err, failed) || calls[len(calls)-1] != failAt {
				t.Fatal("continued beyond failed restore", calls, err)
			}
		})
	}
}
