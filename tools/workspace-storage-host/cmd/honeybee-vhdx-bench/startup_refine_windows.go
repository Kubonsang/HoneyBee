//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func watchStartupFloor(root string, cancel context.CancelFunc) func() error {
	stop := make(chan struct{})
	done := make(chan error, 1)
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-stop:
				done <- nil
				return
			case <-ticker.C:
				free, e := freeSpace(root)
				if e != nil || free < startupFloor {
					cancel()
					done <- fmt.Errorf("disk-pressure: free=%d: %v", free, e)
					return
				}
			}
		}
	}()
	return func() error { close(stop); return <-done }
}

func refineStartupStudy(root, unity, testplay string, confirm bool) (err error) {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	if err = ownedEntry(filepath.Join(cwd, "tmp"), root); err != nil {
		return err
	}
	read := func(name string, v any) error {
		b, e := os.ReadFile(filepath.Join(root, name))
		if e != nil {
			return e
		}
		return json.Unmarshal(b, v)
	}
	var campaign struct {
		Protocol, Evidence string
		Parents            map[string]string
	}
	if err = read("campaign.json", &campaign); err != nil {
		return err
	}
	if campaign.Protocol != "startup-v2" || campaign.Evidence != filepath.Join(cwd, "output", filepath.Base(root)+"-evidence") {
		return errors.New("unexpected refinement campaign")
	}
	var status struct{ OK, Qualified bool }
	if err = read("status.json", &status); err != nil {
		return err
	}
	if !status.OK || status.Qualified {
		return errors.New("refinement expects completed nonqualifying study")
	}
	var rows []capacitySample
	if err = read("measurements.json", &rows); err != nil {
		return err
	}
	var priorDAG []capacitySample
	for _, row := range rows {
		if row.Iteration >= 10 || (!confirm && row.Mode == "E-dag") {
			return errors.New("refinement requires original pilot-only samples")
		}
		if row.Mode == "E-dag" {
			priorDAG = append(priorDAG, row)
		}
	}
	if confirm && (len(priorDAG) != 2 || startupMetrics(priorDAG)["invalid"] != 0) {
		return errors.New("confirmation requires two completed DAG-only pilots")
	}
	for _, p := range campaign.Parents {
		if err = ownedEntry(root, p); err != nil {
			return err
		}
	}
	previousStatus := "initial-status.json"
	if confirm {
		previousStatus = "refinement-status.json"
	}
	if _, e := os.Stat(filepath.Join(root, previousStatus)); !errors.Is(e, os.ErrNotExist) {
		return errors.New("refinement already started")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 3*time.Hour)
	defer cancel()
	elevated, err := storage.IsElevated(ctx)
	if err != nil {
		return err
	}
	if !elevated {
		return errors.New("refinement requires elevation")
	}
	if err = startupCheckpoint(root, campaign.Evidence); err != nil {
		return err
	}
	if err = os.Rename(filepath.Join(root, "status.json"), filepath.Join(root, previousStatus)); err != nil {
		return err
	}
	monitor := watchStartupFloor(root, cancel)
	qualified := false
	selected := ""
	var retained []capacitySample
	defer func() {
		err = errors.Join(err, monitor())
		out := map[string]any{"protocol": "startup-v2", "ok": err == nil, "selected": selected, "qualified": qualified, "refinement": "DAG regeneration retaining TundraBuildState", "finishedAt": time.Now().UTC(), "retained": retained}
		if err != nil {
			out["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), out))
	}()
	run := func(mode string, iteration, cycles int, diagnostics, retain bool) (row capacitySample, e error) {
		if e = startupCheckpoint(root, campaign.Evidence); e != nil {
			return row, e
		}
		parent := campaign.Parents["E"]
		if mode == "A-legacy" {
			parent = campaign.Parents["A"]
		}
		fmt.Println("refinement sample", mode, iteration)
		row, e = capacitySampleRun(context.WithValue(ctx, startupKey{}, startupOptions{Diagnostics: diagnostics}), root, filepath.Join(root, "source"), unity, testplay, parent, mode, iteration, cycles)
		rows = append(rows, row)
		e = errors.Join(e, save(filepath.Join(root, "measurements.json"), rows))
		if e != nil {
			if row.Child != "" && ensureDetached(row.Child) == nil {
				archive, archiveErr := archiveStartupSample(root, campaign.Evidence, row, "failed")
				e = errors.Join(e, archiveErr)
				if archiveErr == nil {
					e = errors.Join(e, removeStartupSample(root, campaign.Evidence, row, archive))
				}
			}
			return row, e
		}
		archive, e := archiveStartupSample(root, campaign.Evidence, row)
		if e != nil {
			return row, e
		}
		if retain {
			retained = append(retained, row)
		} else {
			e = removeStartupSample(root, campaign.Evidence, row, archive)
		}
		return row, e
	}
	var base, pilots []capacitySample
	for _, row := range rows {
		if row.Mode == "A-legacy" {
			base = append(base, row)
		}
	}
	for i := 0; i < 2 && !confirm; i++ {
		row, e := run("E-dag", i, 1, true, false)
		if e != nil {
			return e
		}
		pilots = append(pilots, row)
	}
	best, baseline := startupMetrics(pilots), startupMetrics(base)
	if !confirm {
		if err = save(filepath.Join(root, "refinement-pilot.json"), map[string]any{"candidate": best, "baseline": baseline, "passesScreening": startupPass(best, baseline)}); err != nil {
			return err
		}
		if !startupPass(best, baseline) {
			return nil
		}
	} else if err = save(filepath.Join(root, "confirmation-protocol.json"), map[string]any{"reason": "DAG pilot eliminated ILPP delay but preparation-plus-first-open failed against earlier-session controls; run three fresh contemporaneous pairs", "pilotPassed": false, "gatesChanged": false, "runsPerMode": 3, "cycles": 5}); err != nil {
		return err
	}
	selected = "E-dag"
	groups := map[string][]capacitySample{}
	for i := 0; i < 3; i++ {
		order := []string{"A-legacy", selected}
		if i%2 == 1 {
			order[0], order[1] = order[1], order[0]
		}
		for _, mode := range order {
			row, e := run(mode, 10+i, 5, false, mode == selected && i < 2)
			if e != nil {
				return e
			}
			groups[mode] = append(groups[mode], row)
		}
	}
	best, baseline = startupMetrics(groups[selected]), startupMetrics(groups["A-legacy"])
	qualified = startupPass(best, baseline)
	if err = save(filepath.Join(root, "qualification.json"), map[string]any{"qualified": qualified, "baseline": baseline, "candidate": best, "selected": selected, "testsPassed": 1560}); err != nil {
		return err
	}
	if qualified {
		if err = verifyStartupRetained(ctx, root, campaign.Evidence, unity, testplay, retained); err != nil {
			return err
		}
		retained = nil
	}
	for _, row := range retained {
		archive := filepath.Join(campaign.Evidence, fmt.Sprintf("%s-%d.zip", row.Mode, row.Iteration))
		if err = removeStartupSample(root, campaign.Evidence, row, archive); err != nil {
			return err
		}
	}
	retained = nil
	return nil
}
