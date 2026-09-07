//go:build windows

package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestAllocationDeduplicatesHardlinksAcrossEntries(t *testing.T) {
	root := t.TempDir()
	a := filepath.Join(root, "a")
	b := filepath.Join(root, "b")
	if err := os.WriteFile(a, make([]byte, 8193), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Link(a, b); err != nil {
		t.Fatal(err)
	}
	global := map[string]bool{}
	total := int64(0)
	first := scan("a", "files", "workspace", "one", a, nil, false, global, &total)
	second := scan("b", "files", "workspace", "two", b, nil, false, global, &total)
	if !first.Complete || !second.Complete || first.AllocatedBytes == nil || total <= 0 || total != *first.AllocatedBytes {
		t.Fatalf("hardlinks counted twice: %+v %+v total=%d", first, second, total)
	}
}
func TestMissingRequiredIsUnknownOptionalIsZero(t *testing.T) {
	p := filepath.Join(t.TempDir(), "missing")
	global := map[string]bool{}
	total := int64(0)
	required := scan("a", "child-vhdx", "workspace", "one", p, nil, false, global, &total)
	optional := scan("b", "testplay-local", "workspace", "one", p, nil, true, global, &total)
	if required.Complete || required.AllocatedBytes != nil || !optional.Complete || optional.AllocatedBytes == nil || *optional.AllocatedBytes != 0 {
		t.Fatal("unknown and zero conflated")
	}
}
func TestExcludedLibraryIsNotAdded(t *testing.T) {
	root := t.TempDir()
	lib := filepath.Join(root, "Library")
	if err := os.Mkdir(lib, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(lib, "cache"), make([]byte, 8192), 0600); err != nil {
		t.Fatal(err)
	}
	global := map[string]bool{}
	total := int64(0)
	entry := scan("a", "files", "workspace", "one", root, []string{lib}, false, global, &total)
	if !entry.Complete || entry.FileCount != 0 || total != 0 {
		t.Fatalf("Library double counted: %+v", entry)
	}
}
