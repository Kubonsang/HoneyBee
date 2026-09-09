//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"reflect"
	"testing"
	"time"
)

func TestNativeSeededBeeJunction(t *testing.T) {
	root := t.TempDir()
	mount, external, seed := filepath.Join(root, "Library"), filepath.Join(root, "external"), filepath.Join(root, "seed")
	for _, p := range []string{mount, seed} {
		if err := os.Mkdir(p, 0700); err != nil {
			t.Fatal(err)
		}
	}
	if err := os.WriteFile(filepath.Join(seed, "build.dag"), []byte("seed"), 0600); err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := makeBeeLink(ctx, mount, external, seed); err != nil {
		t.Fatal(err)
	}
	target, err := junctionTarget(filepath.Join(mount, "Bee"))
	if err != nil || target != external {
		t.Fatalf("target=%q err=%v", target, err)
	}
	m, err := scanCapacityLibrary(mount, external)
	if err != nil {
		t.Fatal(err)
	}
	if m["Bee/build.dag"].Bytes != 4 {
		t.Fatal("seed content not preserved")
	}
	if err = os.Remove(filepath.Join(mount, "Bee")); err != nil {
		t.Fatal(err)
	}
	if _, err = os.Stat(filepath.Join(external, "build.dag")); err != nil {
		t.Fatal("removing link removed external content")
	}
}

func TestCapacityParentVariantsPreserveContent(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	for _, name := range []string{"Bee/build.dag", "PackageCache/package", "ScriptAssemblies/game.dll", "ArtifactDB"} {
		p := filepath.Join(source, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte("content:"+name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	original, err := scan(source)
	if err != nil {
		t.Fatal(err)
	}
	for _, mode := range []string{"B-fresh", "C-no-bee", "D-hot-last", "E-external-bee"} {
		dest := filepath.Join(root, mode)
		if err = os.Mkdir(dest, 0700); err != nil {
			t.Fatal(err)
		}
		if err = copyCapacityLibrary(source, dest, mode); err != nil {
			t.Fatal(err)
		}
		actual, err := scan(dest)
		if err != nil {
			t.Fatal(err)
		}
		expected := manifest{}
		for k, v := range original {
			if (mode == "C-no-bee" || mode == "E-external-bee") && k == "Bee/build.dag" {
				continue
			}
			expected[k] = v
		}
		if !same(expected, actual) {
			t.Fatalf("%s changed contents", mode)
		}
	}
}

func TestHotLastOrder(t *testing.T) {
	input := []string{"ScriptAssemblies", "PackageCache", "Bee", "ArtifactDB"}
	got := capacityOrder(input, "D-hot-last")
	want := []string{"ArtifactDB", "PackageCache", "Bee", "ScriptAssemblies"}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("got %v", got)
	}
	if input[0] != "ScriptAssemblies" {
		t.Fatal("mutated caller input")
	}
}

func TestParallelVerificationMatchesSerial(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"Bee/cache", "nested/sub/file", "empty", "top"} {
		p := filepath.Join(root, filepath.FromSlash(name))
		if err := os.MkdirAll(filepath.Dir(p), 0700); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(p, []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	want, err := scan(root)
	if err != nil {
		t.Fatal(err)
	}
	got, err := scanParallel(root)
	if err != nil {
		t.Fatal(err)
	}
	if !same(want, got) {
		t.Fatal("parallel manifest differs")
	}
	if _, err := scanParallel(filepath.Join(root, "missing")); err == nil {
		t.Fatal("missing root accepted")
	}
}

func TestExternalLibraryRequiresExactLink(t *testing.T) {
	root := t.TempDir()
	library := filepath.Join(root, "Library")
	external := filepath.Join(root, "external")
	if err := os.MkdirAll(filepath.Join(library, "Bee"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.Mkdir(external, 0700); err != nil {
		t.Fatal(err)
	}
	if _, err := scanCapacityLibrary(library, external); err == nil {
		t.Fatal("accepted different Bee target")
	}
}
