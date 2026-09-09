//go:build windows

package main

import (
	"context"
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"sync"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func verifyStartupRetained(ctx context.Context, root, evidence, unity, testplay string, rows []capacitySample) (err error) {
	if err = validateRetainedStartupRows(root, rows); err != nil {
		return err
	}
	var phases []capacityPhase
	defer func() {
		r := map[string]any{"ok": err == nil, "phases": phases, "rebootTested": false, "backend": "two independent batch Unity processes"}
		if err != nil {
			r["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "compatibility.json"), r))
	}()
	run := func(row capacitySample, round, identity int) (out []capacityPhase, e error) {
		name := fmt.Sprintf("%s-%d", row.Mode, row.Iteration)
		project := filepath.Join(root, name)
		mount := filepath.Join(project, "Library")
		if e = emptyOwnedMount(mount); e != nil {
			return nil, e
		}
		e = withDisk(ctx, row.Child, mount, false, func(a *storage.Attachment) error {
			if e := a.VerifyParent(row.Parent); e != nil {
				return e
			}
			target, e := junctionTarget(filepath.Join(mount, "Bee"))
			if e != nil || !strings.EqualFold(target, row.External) {
				return errors.New("retained Bee target changed")
			}
			if e = writeCapacityProbe(project, 3000+round*10+identity); e != nil {
				return e
			}
			for _, platform := range []string{"edit_mode", "play_mode"} {
				phaseName := fmt.Sprintf("%s-compat%d-%s", name, round, platform)
				fmt.Println("phase", phaseName)
				phase, e := runCapacityPhase(ctx, root, phaseName, row.Child, row.External, func() (string, int, int, error) {
					return capacityTests(ctx, testplay, project, platform, filepath.Join(root, phaseName))
				})
				out = append(out, phase)
				if e != nil {
					return e
				}
				target, e = junctionTarget(filepath.Join(mount, "Bee"))
				if e != nil || !strings.EqualFold(target, row.External) {
					return errors.New("Unity replaced retained Bee junction")
				}
			}
			return nil
		})
		return
	}
	for round := 1; round <= 3; round++ {
		var wg sync.WaitGroup
		results := make([][]capacityPhase, 2)
		failures := make([]error, 2)
		for i, row := range rows {
			wg.Add(1)
			go func(i int, row capacitySample) { defer wg.Done(); results[i], failures[i] = run(row, round, i) }(i, row)
		}
		wg.Wait()
		for _, r := range results {
			phases = append(phases, r...)
		}
		if err = errors.Join(failures...); err != nil {
			return err
		}
	}
	firstArchive, err := archiveStartupSample(root, evidence, rows[0], "compat")
	if err != nil {
		return err
	}
	if err = removeStartupSample(root, evidence, rows[0], firstArchive); err != nil {
		return err
	}
	survivor, err := run(rows[1], 4, 1)
	phases = append(phases, survivor...)
	if err != nil {
		return err
	}
	secondArchive, err := archiveStartupSample(root, evidence, rows[1], "compat")
	if err != nil {
		return err
	}
	return removeStartupSample(root, evidence, rows[1], secondArchive)
}

func validateRetainedStartupRows(root string, rows []capacitySample) error {
	if len(rows) != 2 {
		return errors.New("two retained startup samples required")
	}
	seen := map[string]bool{}
	for _, row := range rows {
		if strings.HasPrefix(row.Mode, "E-fp-") {
			if err := validateFootprintRetained(root, row); err != nil {
				return err
			}
			identity := strings.ToLower(filepath.Clean(row.Child))
			if seen[identity] {
				return errors.New("retained samples must be independent")
			}
			seen[identity] = true
			continue
		}
		switch row.Mode {
		case "E-control", "E-metadata", "E-pid", "E-graph", "E-dag":
		default:
			return errors.New("unexpected retained startup policy")
		}
		name := fmt.Sprintf("%s-%d", row.Mode, row.Iteration)
		if row.Child != filepath.Join(root, name+".vhdx") || row.External != filepath.Join(root, name+"-bee") || row.Parent != filepath.Join(root, "parent-E.vhdx") {
			return errors.New("retained child/cache ownership mismatch")
		}
		identity := strings.ToLower(filepath.Clean(row.Child))
		if seen[identity] {
			return errors.New("retained samples must be independent")
		}
		seen[identity] = true
	}
	return nil
}
