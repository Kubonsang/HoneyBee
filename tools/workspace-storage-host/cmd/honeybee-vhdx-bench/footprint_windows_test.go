//go:build windows

package main

import (
	"bytes"
	"os"
	"path/filepath"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func TestFootprintCompressionPreservesContentAndNewFileInheritance(t *testing.T) {
	root := filepath.Join(t.TempDir(), "bee")
	if err := os.MkdirAll(filepath.Join(root, "artifacts"), 0700); err != nil {
		t.Fatal(err)
	}
	payload := bytes.Repeat([]byte("HoneyBee compressed cache data\n"), 40000)
	first := filepath.Join(root, "artifacts", "existing.bin")
	if err := os.WriteFile(first, payload, 0600); err != nil {
		t.Fatal(err)
	}
	before, err := storage.FileUsageOf(first)
	if err != nil {
		t.Fatal(err)
	}
	if err = compressFootprintBee(root, "all"); err != nil {
		t.Fatal(err)
	}
	second := filepath.Join(root, "new.bin")
	if err = os.WriteFile(second, payload, 0600); err != nil {
		t.Fatal(err)
	}
	// Buffered compressed writes can retain uncompressed reservations until flush.
	f, err := os.OpenFile(second, os.O_RDWR, 0600)
	if err != nil {
		t.Fatal(err)
	}
	if err = f.Sync(); err != nil {
		t.Fatal(err)
	}
	if err = f.Close(); err != nil {
		t.Fatal(err)
	}
	for _, p := range []string{first, second} {
		got, e := os.ReadFile(p)
		if e != nil || !bytes.Equal(got, payload) {
			t.Fatalf("content changed: %v", e)
		}
		usage, e := storage.FileUsageOf(p)
		if e != nil {
			t.Fatal(e)
		}
		if usage.AllocatedBytes >= before.AllocatedBytes/2 {
			t.Fatalf("compression/inheritance not measured: %s %+v", p, usage)
		}
	}
}

func TestFootprintGateRejectsPlayModePreparationAndMovedBytes(t *testing.T) {
	base := map[string]float64{"firstMs": 100, "reopenMs": 100, "editMs": 100, "playMs": 100, "readyMs": 150, "combinedMedianBytes": 500, "peakBytes": 400, "observedCombinedPeakBytes": 550}
	candidate := map[string]float64{}
	for k, v := range base {
		candidate[k] = v
	}
	candidate["combinedMedianBytes"] = 400
	if !footprintPass(candidate, base, .20) {
		t.Fatal("valid candidate failed")
	}
	for _, k := range []string{"playMs", "readyMs", "combinedMedianBytes", "observedCombinedPeakBytes"} {
		old := candidate[k]
		candidate[k] *= 1.2
		if footprintPass(candidate, base, .20) {
			t.Fatalf("ignored %s", k)
		}
		candidate[k] = old
	}
	if footprintPass(map[string]float64{}, base, .20) {
		t.Fatal("missing evidence accepted")
	}
}

func TestFootprintScreeningDoesNotApplyFinalPeakGate(t *testing.T) {
	base := map[string]float64{"firstMs": 100, "reopenMs": 100, "editMs": 100, "playMs": 100, "readyMs": 150, "combinedMedianBytes": 500, "peakBytes": 400, "observedCombinedPeakBytes": 550}
	candidate := map[string]float64{}
	for k, v := range base {
		candidate[k] = v
	}
	candidate["combinedMedianBytes"] = 400
	candidate["peakBytes"] = 401
	candidate["observedCombinedPeakBytes"] = 551
	if !footprintScreenPass(candidate, base) || footprintPass(candidate, base, .20) {
		t.Fatal("pilot and final gates conflated")
	}
	candidate["observedCombinedPeakBytes"] = 500
	if !footprintPass(candidate, base, .20) {
		t.Fatal("component peak incorrectly overrides total-cache objective")
	}
}

func TestFootprintOrdinaryAllocationIncludesClusterSlack(t *testing.T) {
	p := filepath.Join(t.TempDir(), "plain.bin")
	if err := os.WriteFile(p, bytes.Repeat([]byte{1}, 4097), 0600); err != nil {
		t.Fatal(err)
	}
	actual, err := measuredFileUsage(p)
	if err != nil {
		t.Fatal(err)
	}
	if actual.LogicalBytes != 4097 || actual.AllocatedBytes <= actual.LogicalBytes {
		t.Fatalf("ordinary file allocation was confused with EOF: %+v", actual)
	}
}

func TestFootprintCapacityHeadroom(t *testing.T) {
	if !footprintCapacityFits(8, 4<<30) || footprintCapacityFits(8, 5<<30) || footprintCapacityFits(64, ^uint64(0)) {
		t.Fatal("capacity reserve/overflow guard failed")
	}
}
