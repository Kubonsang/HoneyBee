//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func TestRootBoundary(t *testing.T) {
	base := t.TempDir()
	old, err := os.Getwd()
	if err != nil {
		t.Fatal(err)
	}
	if err = os.Chdir(base); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = os.Chdir(old) })
	if err = os.Mkdir(filepath.Join(base, "tmp"), 0700); err != nil {
		t.Fatal(err)
	}
	if err = validateRoot(filepath.Join(base, "tmp", "new")); err != nil {
		t.Fatal(err)
	}
	for _, root := range []string{base, filepath.Join(base, "tmp"), filepath.Join(base, "tmp-other", "new"), filepath.Join(base, "existing"), "relative"} {
		if err = validateRoot(root); err == nil {
			t.Fatalf("accepted %q", root)
		}
	}
}
func TestManifestDetectsSameSizeContentChangeAndDeletion(t *testing.T) {
	root := t.TempDir()
	p := filepath.Join(root, "ArtifactDB")
	if err := os.WriteFile(p, []byte("old"), 0600); err != nil {
		t.Fatal(err)
	}
	before, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(p, []byte("new"), 0600); err != nil {
		t.Fatal(err)
	}
	after, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if same(before, after) || changes(before, after)["(root)"] != 3 {
		t.Fatal("same-size rewrite was missed")
	}
	if err = os.Remove(p); err != nil {
		t.Fatal(err)
	}
	deleted, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	if same(after, deleted) {
		t.Fatal("deletion was missed")
	}
}
func TestCopyRefusesOverwriteAndPreservesContent(t *testing.T) {
	root := t.TempDir()
	src := filepath.Join(root, "source")
	dst := filepath.Join(root, "dest")
	if err := os.Mkdir(src, 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(src, "asset"), []byte("source"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(src, dst); err != nil {
		t.Fatal(err)
	}
	a, err := scan(src)
	if err != nil {
		t.Fatal(err)
	}
	b, err := scan(dst)
	if err != nil {
		t.Fatal(err)
	}
	if !same(a, b) {
		t.Fatal("copy changed content")
	}
	if err := copyTree(src, dst); err == nil {
		t.Fatal("copy overwrote existing file")
	}
}

// Creates unmounted temporary files only; no admin attach, filesystem format,
// existing images, or installed broker. Opt in on a Windows NTFS host.
func TestNativeChildGeometry(t *testing.T) {
	if os.Getenv("HONEYBEE_VHDX_GEOMETRY_TEST") != "1" {
		t.Skip("set HONEYBEE_VHDX_GEOMETRY_TEST=1 for native unmounted geometry test")
	}
	for _, block := range []uint32{1 << 20, 2 << 20} {
		root := t.TempDir()
		parent := filepath.Join(root, "parent.vhdx")
		child := filepath.Join(root, "child.vhdx")
		if err := storage.CreateDynamicWithOptions(parent, storage.CreateOptions{MaximumSize: 64 << 20, BlockSizeInBytes: 2 << 20, SectorSizeInBytes: 4096}); err != nil {
			t.Fatal(err)
		}
		if err := createChild(child, parent, block); err != nil {
			t.Fatal(err)
		}
		a, err := storage.Open(child, true)
		if err != nil {
			t.Fatal(err)
		}
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		size, err := a.Size()
		closeErr := a.Close(ctx)
		cancel()
		if err != nil {
			t.Fatal(err)
		}
		if closeErr != nil {
			t.Fatal(closeErr)
		}
		if size.BlockSize != block {
			t.Fatalf("requested block=%d child block=%d", block, size.BlockSize)
		}
	}
}
