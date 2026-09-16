package main

import (
	"archive/zip"
	"bytes"
	"crypto/sha256"
	"fmt"
	"os"
	"path/filepath"
	"testing"
)

func fixture(t *testing.T, names []string, mode os.FileMode) (string, string) {
	t.Helper()
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	for _, name := range names {
		h := &zip.FileHeader{Name: name, Method: zip.Store}
		h.SetMode(mode)
		w, e := z.CreateHeader(h)
		if e != nil {
			t.Fatal(e)
		}
		w.Write([]byte("payload"))
	}
	if e := z.Close(); e != nil {
		t.Fatal(e)
	}
	p := filepath.Join(t.TempDir(), "app.zip")
	if e := os.WriteFile(p, b.Bytes(), 0600); e != nil {
		t.Fatal(e)
	}
	return p, fmt.Sprintf("%x", sha256.Sum256(b.Bytes()))
}
func TestUnsafePaths(t *testing.T) {
	for _, name := range []string{"../escape", "desktop/../escape", "/desktop/a", "desktop\\a", "desktop/a:stream", "desktop/NUL.txt", "desktop/COM1.exe", "desktop/a.", "desktop/a ", "desktop//a", "desktop/\x01", "current.json", "bin/honeybee.exe", "HoneyBeeLauncher.exe", "data/user.json", "versions/1.0.0/launch.json"} {
		t.Run(name, func(t *testing.T) {
			if safeName(name) == nil {
				t.Fatal("accepted unsafe path")
			}
		})
	}
}
func TestExtract(t *testing.T) {
	p, h := fixture(t, []string{"desktop/app.exe", "cli/dist/cli.js", "launch.json"}, 0600)
	dest := filepath.Join(t.TempDir(), "new")
	inventory, e := extract(p, dest, h)
	if e != nil {
		t.Fatal(e)
	}
	if len(inventory) != 3 {
		t.Fatal(inventory)
	}
	if inventory["desktop/app.exe"].SHA256 != fmt.Sprintf("%x", sha256.Sum256([]byte("payload"))) {
		t.Fatal("bad hash")
	}
	if _, e := extract(p, dest, h); e == nil {
		t.Fatal("overwrote existing destination")
	}
}
func TestRejectBeforeExtraction(t *testing.T) {
	for _, c := range []struct {
		name  string
		names []string
		mode  os.FileMode
	}{
		{"traversal", []string{"desktop/../../escape"}, 0600},
		{"duplicate", []string{"desktop/a", "desktop/a"}, 0600},
		{"case", []string{"desktop/A", "desktop/a"}, 0600},
		{"case-directory", []string{"desktop/Folder/a", "desktop/folder/b"}, 0600},
		{"file-directory", []string{"desktop/a", "desktop/a/b"}, 0600},
		{"symlink", []string{"desktop/a"}, os.ModeSymlink | 0777},
		{"directory", []string{"desktop/a/"}, os.ModeDir | 0700},
		{"launcher", []string{"HoneyBeeLauncher.exe"}, 0600},
	} {
		t.Run(c.name, func(t *testing.T) {
			p, h := fixture(t, c.names, c.mode)
			dest := filepath.Join(t.TempDir(), "new")
			if _, e := extract(p, dest, h); e == nil {
				t.Fatal("accepted")
			}
			if _, e := os.Stat(dest); !os.IsNotExist(e) {
				t.Fatal("created destination before admission")
			}
		})
	}
}
func TestDigestAndCRC(t *testing.T) {
	p, h := fixture(t, []string{"desktop/a"}, 0600)
	dest := filepath.Join(t.TempDir(), "new")
	if _, e := extract(p, dest, fmt.Sprintf("%064d", 0)); e == nil {
		t.Fatal("accepted wrong digest")
	}
	b, _ := os.ReadFile(p)
	i := bytes.Index(b, []byte("payload"))
	b[i] = 'X'
	os.WriteFile(p, b, 0600)
	h = fmt.Sprintf("%x", sha256.Sum256(b))
	if _, e := extract(p, dest, h); e == nil {
		t.Fatal("accepted corrupt CRC")
	}
}
func TestPackRoundtrip(t *testing.T) {
	source := t.TempDir()
	os.Mkdir(filepath.Join(source, "runtime"), 0700)
	os.WriteFile(filepath.Join(source, "runtime", "node.exe"), []byte("node"), 0600)
	archive := filepath.Join(t.TempDir(), "app.zip")
	if e := pack(source, archive); e != nil {
		t.Fatal(e)
	}
	b, _ := os.ReadFile(archive)
	dest := filepath.Join(t.TempDir(), "new")
	if _, e := extract(archive, dest, fmt.Sprintf("%x", sha256.Sum256(b))); e != nil {
		t.Fatal(e)
	}
	if e := pack(source, archive); e == nil {
		t.Fatal("overwrote archive")
	}
}
func TestExpandedLimit(t *testing.T) {
	var b bytes.Buffer
	z := zip.NewWriter(&b)
	h := &zip.FileHeader{Name: "desktop/bomb", Method: zip.Store, UncompressedSize64: uint64(maxFile) + 1}
	w, e := z.CreateRaw(h)
	if e != nil {
		t.Fatal(e)
	}
	w.Write([]byte("x"))
	z.Close()
	archive := filepath.Join(t.TempDir(), "app.zip")
	os.WriteFile(archive, b.Bytes(), 0600)
	if _, e := extract(archive, filepath.Join(t.TempDir(), "new"), fmt.Sprintf("%x", sha256.Sum256(b.Bytes()))); e == nil {
		t.Fatal("accepted oversized entry")
	}
}
