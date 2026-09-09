//go:build windows

package main

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestStartupGraphResetPreservesArtifactsAndUnrelatedFiles(t *testing.T) {
	root := t.TempDir()
	bee := filepath.Join(root, "Bee")
	if err := os.MkdirAll(filepath.Join(bee, "artifacts"), 0700); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"abc.dag", "abc.dag.json", "abc.dag.payloads", "abc.dag_derived", "abc.dag_fsmtime", "abc-inputdata.json", "TundraBuildState.state", "tundra.digestcache", "keep.txt", "artifacts/keep.dll"} {
		if err := os.WriteFile(filepath.Join(bee, n), []byte(n), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.WithValue(context.Background(), startupKey{}, startupOptions{})
	if err := applyStartupPolicy(ctx, "E-graph", root, bee, ""); err != nil {
		t.Fatal(err)
	}
	for _, n := range []string{"tundra.digestcache", "keep.txt", "artifacts/keep.dll"} {
		if _, err := os.Stat(filepath.Join(bee, n)); err != nil {
			t.Fatal(err)
		}
	}
	if _, err := os.Stat(filepath.Join(bee, "abc.dag")); !os.IsNotExist(err) {
		t.Fatal("stale DAG retained")
	}
}

func TestStartupMetadataPreservesTimesAndAttributes(t *testing.T) {
	root := t.TempDir()
	source := filepath.Join(root, "source")
	dest := filepath.Join(root, "dest")
	if err := os.Mkdir(source, 0700); err != nil {
		t.Fatal(err)
	}
	p := filepath.Join(source, "file")
	if err := os.WriteFile(p, []byte("payload"), 0600); err != nil {
		t.Fatal(err)
	}
	at := time.Unix(1600000000, 0)
	if err := os.Chtimes(p, at, at); err != nil {
		t.Fatal(err)
	}
	if err := copyTree(source, dest); err != nil {
		t.Fatal(err)
	}
	sp, _ := windows.UTF16PtrFromString(p)
	dp, _ := windows.UTF16PtrFromString(filepath.Join(dest, "file"))
	if err := windows.SetFileAttributes(sp, windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_READONLY); err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() {
		windows.SetFileAttributes(sp, windows.FILE_ATTRIBUTE_NORMAL)
		windows.SetFileAttributes(dp, windows.FILE_ATTRIBUTE_NORMAL)
	})
	if err := metadataCopy(source, dest); err != nil {
		t.Fatal(err)
	}
	info, err := os.Stat(filepath.Join(dest, "file"))
	if err != nil {
		t.Fatal(err)
	}
	if !info.ModTime().Equal(at) {
		t.Fatal("mtime not preserved")
	}
	attr, err := windows.GetFileAttributes(dp)
	if err != nil {
		t.Fatal(err)
	}
	if attr&(windows.FILE_ATTRIBUTE_HIDDEN|windows.FILE_ATTRIBUTE_READONLY) != (windows.FILE_ATTRIBUTE_HIDDEN | windows.FILE_ATTRIBUTE_READONLY) {
		t.Fatal("attributes lost")
	}
	a, err := scanParallel(source)
	if err != nil {
		t.Fatal(err)
	}
	b, err := scanParallel(dest)
	if err != nil {
		t.Fatal(err)
	}
	if !same(a, b) {
		t.Fatal("metadata policy changed content")
	}
}

func TestStartupDAGResetRetainsBuildState(t *testing.T) {
	root := t.TempDir()
	for _, name := range []string{"abc.dag", "abc-inputdata.json", "TundraBuildState.state", "TundraBuildState.state.map", "tundra.digestcache"} {
		if err := os.WriteFile(filepath.Join(root, name), []byte(name), 0600); err != nil {
			t.Fatal(err)
		}
	}
	ctx := context.WithValue(context.Background(), startupKey{}, startupOptions{})
	if err := applyStartupPolicy(ctx, "E-dag", root, root, ""); err != nil {
		t.Fatal(err)
	}
	for _, name := range []string{"TundraBuildState.state", "TundraBuildState.state.map", "tundra.digestcache"} {
		got, err := os.ReadFile(filepath.Join(root, name))
		if err != nil || string(got) != name {
			t.Fatalf("build cache changed: %s: %v", name, err)
		}
	}
	for _, name := range []string{"abc.dag", "abc-inputdata.json"} {
		if _, err := os.Stat(filepath.Join(root, name)); !os.IsNotExist(err) {
			t.Fatalf("graph seed retained: %s", name)
		}
	}
}

func TestStartupStorageRejectsPressureAndEscapingCleanup(t *testing.T) {
	if admission(startupFloor-1, 0, 0) == nil {
		t.Fatal("free-space floor ignored")
	}
	if admission(100<<30, startupBudget, 1) == nil {
		t.Fatal("budget ignored")
	}
	if admission(40<<30, 3<<30, 2<<30) != nil {
		t.Fatal("safe admission rejected")
	}
	root := t.TempDir()
	if ownedEntry(root, root) == nil || ownedEntry(root, filepath.Dir(root)) == nil {
		t.Fatal("cleanup escaped root")
	}
}

func TestStartupQualificationCountsExternalPeakAndPreparation(t *testing.T) {
	base := map[string]float64{"firstMs": 100, "reopenMs": 100, "editMs": 100, "readyMs": 100}
	candidate := map[string]float64{"firstMs": 100, "reopenMs": 100, "editMs": 100, "readyMs": 100, "childMedianBytes": 340e6, "peakBytes": 390e6, "combinedMedianBytes": 500e6}
	if !startupPass(candidate, base) {
		t.Fatal("valid candidate rejected")
	}
	if startupPass(startupMetrics(nil), base) || startupPass(map[string]float64{}, base) {
		t.Fatal("missing evidence passed")
	}
	for _, key := range []string{"readyMs", "peakBytes", "combinedMedianBytes"} {
		old := candidate[key]
		candidate[key] = old * 2
		if startupPass(candidate, base) {
			t.Fatalf("ignored %s", key)
		}
		candidate[key] = old
	}
}

func TestRetainedStartupRejectsDuplicateAndSharedCache(t *testing.T) {
	root := t.TempDir()
	rows := []capacitySample{
		{Mode: "E-dag", Iteration: 10, Child: filepath.Join(root, "E-dag-10.vhdx"), External: filepath.Join(root, "E-dag-10-bee"), Parent: filepath.Join(root, "parent-E.vhdx")},
		{Mode: "E-dag", Iteration: 11, Child: filepath.Join(root, "E-dag-11.vhdx"), External: filepath.Join(root, "E-dag-11-bee"), Parent: filepath.Join(root, "parent-E.vhdx")},
	}
	if err := validateRetainedStartupRows(root, rows); err != nil {
		t.Fatal(err)
	}
	original := rows[1]
	rows[1].External = rows[0].External
	if validateRetainedStartupRows(root, rows) == nil {
		t.Fatal("shared external Bee accepted")
	}
	rows[1] = rows[0]
	if validateRetainedStartupRows(root, rows) == nil {
		t.Fatal("duplicate child accepted")
	}
	rows[1] = original
	rows[1].Parent = filepath.Join(filepath.Dir(root), "unowned.vhdx")
	if validateRetainedStartupRows(root, rows) == nil {
		t.Fatal("unowned parent accepted")
	}
}
