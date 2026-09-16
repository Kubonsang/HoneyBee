//go:build windows

package main

import (
	"encoding/json"
	"errors"
	"sort"
	"strings"
)

func hashStoreInventory(inventory storeInventory) string {
	copyInventory := storeInventory{SchemaVersion: inventory.SchemaVersion, Entries: append([]storeInventoryEntry(nil), inventory.Entries...)}
	sort.Slice(copyInventory.Entries, func(i, j int) bool {
		return strings.ToLower(copyInventory.Entries[i].Name) < strings.ToLower(copyInventory.Entries[j].Name)
	})
	data, _ := json.Marshal(copyInventory)
	return evidenceHash(data)
}

// All adapters are mandatory. Persistence must bind the complete plan to the
// protected transaction, and every mutating adapter must replay its own durable
// intent without overwriting an unrelated file. This coordinator is not a CLI.
type storeRestoreHooks struct {
	AssertStopped     func() error
	PersistPlan       func(storeRestorePlan) error
	CreateDirectory   func(storeInventoryEntry) error
	RestoreFile       func(storeRestoreFileStep) error
	PreserveDirectory func(storeInventoryEntry) error
	RestoreMetadata   func(storeInventoryEntry) error
	VerifyStore       func(storeInventory) error
}

func restoreStoreInventory(current, source storeInventory, hooks storeRestoreHooks) error {
	if hooks.AssertStopped == nil || hooks.PersistPlan == nil || hooks.CreateDirectory == nil || hooks.RestoreFile == nil || hooks.PreserveDirectory == nil || hooks.RestoreMetadata == nil || hooks.VerifyStore == nil {
		return errors.New("complete store restore adapters required")
	}
	plan, err := planStoreRestore(current, source)
	if err != nil {
		return err
	}
	if err = hooks.AssertStopped(); err != nil {
		return err
	}
	if err = hooks.PersistPlan(plan); err != nil {
		return err
	}
	run := func(action func() error) error {
		if err := hooks.AssertStopped(); err != nil {
			return err
		}
		return action()
	}
	for _, entry := range plan.CreateDirectories {
		if err = run(func() error { return hooks.CreateDirectory(entry) }); err != nil {
			return err
		}
	}
	for _, entry := range plan.Files {
		if err = run(func() error { return hooks.RestoreFile(entry) }); err != nil {
			return err
		}
	}
	for _, entry := range plan.PreserveDirectories {
		if err = run(func() error { return hooks.PreserveDirectory(entry) }); err != nil {
			return err
		}
	}
	for _, entry := range plan.Metadata {
		if err = run(func() error { return hooks.RestoreMetadata(entry) }); err != nil {
			return err
		}
	}
	if err = run(func() error { return hooks.VerifyStore(source) }); err != nil {
		return err
	}
	return hooks.AssertStopped()
}

type storeRestoreFileStep struct {
	Name           string `json:"name"`
	CurrentSHA256  string `json:"currentSha256"`
	RestoredSHA256 string `json:"restoredSha256"`
}

// Plans are derived from the pinned backup inventory and a separately durable
// observation of the stopped target. Never recalculate that observation midway
// through rollback: absence then could represent an interrupted rename.
type storeRestorePlan struct {
	SchemaVersion          int                    `json:"schemaVersion"`
	CurrentInventorySHA256 string                 `json:"currentInventorySha256"`
	SourceInventorySHA256  string                 `json:"sourceInventorySha256"`
	Files                  []storeRestoreFileStep `json:"files"`
	CreateDirectories      []storeInventoryEntry  `json:"createDirectories"`
	PreserveDirectories    []storeInventoryEntry  `json:"preserveDirectories"`
	Metadata               []storeInventoryEntry  `json:"metadata"`
}

func planStoreRestore(current, source storeInventory) (storeRestorePlan, error) {
	var plan storeRestorePlan
	if err := validateStoreInventory(current); err != nil {
		return plan, err
	}
	if err := validateStoreInventory(source); err != nil {
		return plan, err
	}
	index := func(inventory storeInventory) map[string]storeInventoryEntry {
		result := map[string]storeInventoryEntry{}
		for _, entry := range inventory.Entries {
			result[strings.ToLower(entry.Name)] = entry
		}
		return result
	}
	live, backup := index(current), index(source)
	// Canonical inventory hashes include all metadata, independent of traversal order.
	plan.SchemaVersion = 1
	plan.CurrentInventorySHA256 = hashStoreInventory(current)
	plan.SourceInventorySHA256 = hashStoreInventory(source)
	keys := map[string]bool{}
	for key := range live {
		keys[key] = true
	}
	for key := range backup {
		keys[key] = true
	}
	ordered := make([]string, 0, len(keys))
	for key := range keys {
		ordered = append(ordered, key)
	}
	sort.Strings(ordered)
	for _, key := range ordered {
		before, hasBefore := live[key]
		after, hasAfter := backup[key]
		if hasBefore && hasAfter && (before.Directory != after.Directory || before.Name != after.Name) {
			return storeRestorePlan{}, errors.New("restore type or case-only path transition requires separate admission")
		}
		if (hasBefore && before.Directory) || (hasAfter && after.Directory) {
			if !hasBefore {
				plan.CreateDirectories = append(plan.CreateDirectories, after)
			}
			if !hasAfter {
				plan.PreserveDirectories = append(plan.PreserveDirectories, before)
			}
		} else {
			name := before.Name
			if hasAfter {
				name = after.Name
			}
			plan.Files = append(plan.Files, storeRestoreFileStep{name, before.SHA256, after.SHA256})
		}
		if hasAfter {
			plan.Metadata = append(plan.Metadata, after)
		}
	}
	// Parent directories must exist before files; obsolete directories must be
	// empty and preserved child-first. Apply parent ACLs before child ACLs so
	// inheritance cannot overwrite a child restored earlier.
	sort.Slice(plan.CreateDirectories, func(i, j int) bool { return storeEntryBefore(plan.CreateDirectories[i], plan.CreateDirectories[j]) })
	sort.Slice(plan.PreserveDirectories, func(i, j int) bool { return storeEntryBefore(plan.PreserveDirectories[j], plan.PreserveDirectories[i]) })
	sort.Slice(plan.Metadata, func(i, j int) bool {
		a, b := plan.Metadata[i], plan.Metadata[j]
		if a.Directory != b.Directory {
			return a.Directory
		}
		return storeEntryBefore(a, b)
	})
	return plan, nil
}

func storeEntryBefore(a, b storeInventoryEntry) bool {
	depth := func(name string) int {
		if name == "." {
			return -1
		}
		return strings.Count(name, "/")
	}
	if depth(a.Name) != depth(b.Name) {
		return depth(a.Name) < depth(b.Name)
	}
	return strings.ToLower(a.Name) < strings.ToLower(b.Name)
}
