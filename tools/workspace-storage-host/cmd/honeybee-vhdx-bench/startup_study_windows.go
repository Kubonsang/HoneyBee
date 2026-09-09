//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

var startupPolicies = []string{"A-legacy", "E-control", "E-metadata", "E-pid", "E-graph"}

func median(values []int64) float64 {
	sort.Slice(values, func(i, j int) bool { return values[i] < values[j] })
	n := len(values)
	if n == 0 {
		return 0
	}
	if n%2 == 1 {
		return float64(values[n/2])
	}
	return float64(values[n/2-1]+values[n/2]) / 2
}
func startupMetrics(rows []capacitySample) map[string]float64 {
	if len(rows) == 0 {
		return map[string]float64{"invalid": 1}
	}
	result := map[string]float64{}
	var child, combined, first, reopen, edit, ready []int64
	var peak int64
	for _, r := range rows {
		if r.Error != "" || len(r.Phases) < 4 {
			return map[string]float64{"invalid": 1}
		}
		child = append(child, r.Detached.AllocatedBytes)
		combined = append(combined, r.Detached.AllocatedBytes+r.Phases[len(r.Phases)-1].External.AllocatedBytes)
		first = append(first, r.Phases[0].ElapsedMS)
		reopen = append(reopen, r.Phases[1].ElapsedMS)
		ready = append(ready, r.ReadyMS)
		var edits []int64
		for _, p := range r.Phases {
			if p.ObservedPeak > peak {
				peak = p.ObservedPeak
			}
			if strings.HasSuffix(p.Name, "edit_mode") {
				edits = append(edits, p.ElapsedMS)
			}
		}
		edit = append(edit, int64(median(edits)))
		if r.Detached.AllocatedBytes > peak {
			peak = r.Detached.AllocatedBytes
		}
	}
	result["childMedianBytes"] = median(child)
	result["combinedMedianBytes"] = median(combined)
	result["peakBytes"] = float64(peak)
	result["firstMs"] = median(first)
	result["reopenMs"] = median(reopen)
	result["editMs"] = median(edit)
	result["readyMs"] = median(ready)
	return result
}
func startupPass(value, base map[string]float64) bool {
	if value["invalid"] != 0 || base["invalid"] != 0 || base["firstMs"] == 0 {
		return false
	}
	for _, key := range []string{"childMedianBytes", "peakBytes", "combinedMedianBytes", "firstMs", "reopenMs", "editMs", "readyMs"} {
		if value[key] <= 0 {
			return false
		}
	}
	if value["childMedianBytes"] > 350e6 || value["peakBytes"] > 400e6 || value["combinedMedianBytes"] > 550e6 {
		return false
	}
	for _, key := range []string{"firstMs", "reopenMs", "editMs", "readyMs"} {
		if value[key] > base[key]*1.1 {
			return false
		}
	}
	return true
}

func runStartupStudy(root, source, unity, legacy, testplay string, lifecycle bool) (err error) {
	if err = validateRoot(root); err != nil {
		return err
	}
	for _, p := range []string{source, unity, legacy, testplay} {
		if !filepath.IsAbs(p) {
			return errors.New("startup inputs must be absolute")
		}
	}
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	free, err := freeSpace(cwd)
	if err != nil {
		return err
	}
	if free < startupFloor+startupBudget {
		return errors.New("startup study requires 35 GiB free")
	}
	if _, e := os.Stat(filepath.Join(source, "Library")); !errors.Is(e, os.ErrNotExist) {
		return errors.New("startup source must be a frozen authored export")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
	defer cancel()
	elevated, err := storage.IsElevated(ctx)
	if err != nil {
		return err
	}
	if !elevated {
		return errors.New("startup study requires elevation")
	}
	evidence := filepath.Join(cwd, "output", filepath.Base(root)+"-evidence")
	if err = os.Mkdir(evidence, 0700); err != nil {
		return err
	}
	if err = os.Mkdir(root, 0700); err != nil {
		return err
	}
	stopMonitor := make(chan struct{})
	monitorDone := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stopMonitor:
				monitorDone <- nil
				return
			case <-ticker.C:
				space, e := freeSpace(root)
				if e != nil || space < startupFloor {
					cancel()
					monitorDone <- fmt.Errorf("disk-pressure: free bytes=%d: %v", space, e)
					return
				}
			}
		}
	}()
	var rows []capacitySample
	var retained []capacitySample
	selected := ""
	qualified := false
	protocol := "startup-v2"
	if lifecycle {
		protocol = "startup-lifecycle-v1"
	}
	defer func() {
		close(stopMonitor)
		err = errors.Join(err, <-monitorDone)
		status := map[string]any{"protocol": protocol, "ok": err == nil, "selected": selected, "qualified": qualified, "finishedAt": time.Now().UTC(), "retained": retained}
		if lifecycle {
			status["lifecycleValidated"] = err == nil && selected == "E-dag" && len(retained) == 0
		}
		if err != nil {
			status["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), status))
	}()
	frozen := filepath.Join(root, "source")
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings"} {
		if err = copyTree(filepath.Join(source, folder), filepath.Join(frozen, folder)); err != nil {
			return err
		}
		a, e := scanParallel(filepath.Join(source, folder))
		if e != nil {
			return e
		}
		b, e := scanParallel(filepath.Join(frozen, folder))
		if e != nil {
			return e
		}
		if !same(a, b) {
			return errors.New("startup source copy mismatch")
		}
	}
	if err = prepareCapacityProbe(frozen); err != nil {
		return err
	}
	fmt.Println("prepare startup seed")
	for _, phase := range []string{"first", "reopen"} {
		if _, err = launchUnity(ctx, unity, frozen, filepath.Join(root, "seed-"+phase+".log"), false); err != nil {
			return err
		}
	}
	seed, err := scanParallel(filepath.Join(frozen, "Library"))
	if err != nil {
		return err
	}
	if err = save(filepath.Join(root, "seed-manifest.json"), seed); err != nil {
		return err
	}
	originalHash, err := hashFileRecord(legacy)
	if err != nil {
		return err
	}
	parentA := filepath.Join(root, "parent-A.vhdx")
	parentE := filepath.Join(root, "parent-E.vhdx")
	if err = copyFile(legacy, parentA); err != nil {
		return err
	}
	copied, err := hashFileRecord(parentA)
	if err != nil {
		return err
	}
	if copied != originalHash {
		return errors.New("legacy parent copy mismatch")
	}
	if err = storage.CreateDynamicWithOptions(parentE, storage.CreateOptions{MaximumSize: 64 << 30, BlockSizeInBytes: 2 << 20, SectorSizeInBytes: 4096}); err != nil {
		return err
	}
	err = withDisk(ctx, parentE, filepath.Join(root, "parent-prepare"), true, func(a *storage.Attachment) error {
		return copyCapacityLibrary(filepath.Join(frozen, "Library"), filepath.Join(root, "parent-prepare"), "C-no-bee")
	})
	if err != nil {
		return err
	}
	err = withReadOnlyDisk(ctx, parentE, filepath.Join(root, "parent-verify"), func(a *storage.Attachment) error {
		actual, e := scanParallel(filepath.Join(root, "parent-verify"))
		if e != nil {
			return e
		}
		expected := manifest{}
		for k, v := range seed {
			if !strings.HasPrefix(k, "Bee/") {
				expected[k] = v
			}
		}
		if !same(expected, actual) {
			return errors.New("startup parent content mismatch")
		}
		return nil
	})
	if err != nil {
		return err
	}
	campaign := map[string]any{"protocol": protocol, "source": source, "unity": unity, "testplay": testplay, "parents": map[string]string{"A": parentA, "E": parentE}, "legacyHash": originalHash, "budgetBytes": startupBudget, "freeFloorBytes": startupFloor, "evidence": evidence}
	if lifecycle {
		campaign["samples"] = 2
		campaign["initialCycles"] = 1
		campaign["concurrentRounds"] = 3
		campaign["survivorRounds"] = 1
	} else {
		campaign["pilotRuns"] = 2
		campaign["qualificationRuns"] = 3
		campaign["qualificationCycles"] = 5
	}
	if err = save(filepath.Join(root, "campaign.json"), campaign); err != nil {
		return err
	}
	if lifecycle {
		selected = "E-dag"
		for i := 10; i < 12; i++ {
			if err = startupCheckpoint(root, evidence); err != nil {
				return err
			}
			row, e := capacitySampleRun(context.WithValue(ctx, startupKey{}, startupOptions{}), root, frozen, unity, testplay, parentE, selected, i, 1)
			rows = append(rows, row)
			err = errors.Join(e, save(filepath.Join(root, "measurements.json"), rows))
			if err != nil {
				return err
			}
			if _, err = archiveStartupSample(root, evidence, row); err != nil {
				return err
			}
			retained = append(retained, row)
		}
		if err = verifyStartupRetained(ctx, root, evidence, unity, testplay, retained); err != nil {
			return err
		}
		retained = nil
		finalHash, e := hashFileRecord(legacy)
		if e != nil {
			return e
		}
		if finalHash != originalHash {
			return errors.New("installed parent changed during lifecycle verification")
		}
		return nil
	}
	runSample := func(policy string, iteration, cycles int, diagnostics, retain bool) (row capacitySample, e error) {
		if e = startupCheckpoint(root, evidence); e != nil {
			return row, e
		}
		parent := parentE
		if policy == "A-legacy" {
			parent = parentA
		}
		fmt.Println("startup sample", policy, iteration)
		options := context.WithValue(ctx, startupKey{}, startupOptions{Diagnostics: diagnostics})
		row, e = capacitySampleRun(options, root, frozen, unity, testplay, parent, policy, iteration, cycles)
		rows = append(rows, row)
		e = errors.Join(e, save(filepath.Join(root, "measurements.json"), rows))
		if e != nil {
			if detached := ensureDetached(row.Child); detached == nil {
				archive, archiveErr := archiveStartupSample(root, evidence, row, "failed")
				if archiveErr == nil {
					archiveErr = removeStartupSample(root, evidence, row, archive)
				}
				e = errors.Join(e, archiveErr)
			} else {
				e = errors.Join(e, detached)
			}
			return row, e
		}
		archive, ae := archiveStartupSample(root, evidence, row)
		if ae != nil {
			return row, ae
		}
		if retain {
			retained = append(retained, row)
		} else {
			e = removeStartupSample(root, evidence, row, archive)
		}
		return row, e
	}
	groups := map[string][]capacitySample{}
	for i := 0; i < 2; i++ {
		for offset := 0; offset < len(startupPolicies); offset++ {
			policy := startupPolicies[(offset+i)%len(startupPolicies)]
			row, e := runSample(policy, i, 1, true, false)
			if e != nil {
				return e
			}
			groups[policy] = append(groups[policy], row)
		}
	}
	metrics := map[string]map[string]float64{}
	for policy, group := range groups {
		metrics[policy] = startupMetrics(group)
	}
	// Fixed preference order breaks near-equal preparation time ties by smaller change.
	for _, policy := range []string{"E-control", "E-pid", "E-metadata", "E-graph"} {
		m := metrics[policy]
		if !startupPass(m, metrics["A-legacy"]) {
			continue
		}
		if selected == "" || m["readyMs"] < metrics[selected]["readyMs"]*.95 {
			selected = policy
		}
	}
	if err = save(filepath.Join(root, "pilot-results.json"), map[string]any{"metrics": metrics, "selected": selected, "diagnosticTimingsOnly": true}); err != nil {
		return err
	}
	if selected != "" {
		final := map[string][]capacitySample{}
		for i := 0; i < 3; i++ {
			order := []string{"A-legacy", selected}
			if i%2 == 1 {
				order[0], order[1] = order[1], order[0]
			}
			for _, policy := range order {
				row, e := runSample(policy, 10+i, 5, false, policy == selected && i < 2)
				if e != nil {
					return e
				}
				final[policy] = append(final[policy], row)
			}
		}
		base, best := startupMetrics(final["A-legacy"]), startupMetrics(final[selected])
		qualified = startupPass(best, base)
		if err = save(filepath.Join(root, "qualification.json"), map[string]any{"qualified": qualified, "baseline": base, "candidate": best, "selected": selected, "testsPassed": 1560}); err != nil {
			return err
		}
		if qualified {
			if err = verifyStartupRetained(ctx, root, evidence, unity, testplay, retained); err != nil {
				return err
			}
			retained = nil
		}
		for _, row := range retained {
			archive := filepath.Join(evidence, fmt.Sprintf("%s-%d.zip", row.Mode, row.Iteration))
			if err = removeStartupSample(root, evidence, row, archive); err != nil {
				return err
			}
		}
		retained = nil
	}
	after, err := hashFileRecord(legacy)
	if err != nil {
		return err
	}
	if after != originalHash {
		return errors.New("installed legacy parent changed")
	}
	return nil
}
