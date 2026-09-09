//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func emptyOwnedMount(mount string) error {
	info, err := os.Lstat(mount)
	if errors.Is(err, os.ErrNotExist) {
		return nil
	}
	if err != nil {
		return err
	}
	if err = regularNode(mount, info); err != nil {
		return err
	}
	entries, err := os.ReadDir(mount)
	if err != nil {
		return err
	}
	if len(entries) != 0 {
		return errors.New("retained mount is not empty")
	}
	return os.Remove(mount) // nonrecursive; only the exact claimed empty mount leaf
}

func verifyCapacity(root, unity, testplay, mode string) (err error) {
	cwd, err := os.Getwd()
	if err != nil {
		return
	}
	rel, e := filepath.Rel(filepath.Join(cwd, "tmp"), root)
	if e != nil || !filepath.IsAbs(root) || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("verification root outside checkout/tmp")
	}
	for p := root; ; p = filepath.Dir(p) {
		info, e := os.Lstat(p)
		if e != nil {
			return e
		}
		if e = regularNode(p, info); e != nil {
			return e
		}
		if filepath.Dir(p) == p {
			break
		}
	}
	valid := false
	for _, m := range capacityModes {
		if mode == m {
			valid = true
		}
	}
	if !valid {
		return errors.New("unknown capacity mode")
	}
	statusRaw, e := os.ReadFile(filepath.Join(root, "status.json"))
	if e != nil {
		return e
	}
	var status struct {
		OK       bool   `json:"ok"`
		Protocol string `json:"protocol"`
		Runs     int    `json:"runs"`
		Cycles   int    `json:"cycles"`
	}
	if e = json.Unmarshal(statusRaw, &status); e != nil {
		return e
	}
	if !status.OK || status.Protocol != "capacity-v1" || status.Runs != 3 || status.Cycles != 5 {
		return errors.New("retained verification requires a successful full capacity campaign")
	}
	raw, e := os.ReadFile(filepath.Join(root, "measurements.json"))
	if e != nil {
		return e
	}
	var all []capacitySample
	if e = json.Unmarshal(raw, &all); e != nil {
		return e
	}
	var rows []capacitySample
	for _, row := range all {
		if row.Mode == mode && row.Iteration >= 0 && row.Iteration < 2 {
			rows = append(rows, row)
		}
	}
	if len(rows) != 2 || rows[0].Iteration == rows[1].Iteration {
		return errors.New("two different completed samples required")
	}
	for _, row := range rows {
		name := fmt.Sprintf("%s-%d", mode, row.Iteration)
		if row.Error != "" || row.Child != filepath.Join(root, name+".vhdx") {
			return errors.New("invalid completed child")
		}
		parentRel, e := filepath.Rel(root, row.Parent)
		if e != nil || parentRel == "." || parentRel == ".." || strings.ContainsAny(parentRel, "/\\") {
			return errors.New("parent outside claimed root")
		}
		expectedExternal := ""
		if mode == "E-external-bee" {
			expectedExternal = filepath.Join(root, name+"-bee")
		}
		if row.External != expectedExternal {
			return errors.New("external cache outside claimed sample")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Hour)
	defer cancel()
	elevated, e := storage.IsElevated(ctx)
	if e != nil {
		return e
	}
	if !elevated {
		return errors.New("retained verification requires elevation")
	}
	var results []map[string]any
	defer func() {
		report := map[string]any{"mode": mode, "ok": err == nil, "rounds": results}
		if err != nil {
			report["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, mode+"-compatibility.json"), report))
	}()
	for round := 1; round <= 3; round++ {
		var wg sync.WaitGroup
		outcomes := make([]map[string]any, 2)
		failures := make([]error, 2)
		for i, row := range rows {
			wg.Add(1)
			go func(i int, row capacitySample) {
				defer wg.Done()
				name := fmt.Sprintf("%s-%d", mode, row.Iteration)
				project := filepath.Join(root, name)
				mount := filepath.Join(project, "Library")
				phases := []capacityPhase{}
				e := emptyOwnedMount(mount)
				if e == nil {
					e = withDisk(ctx, row.Child, mount, false, func(a *storage.Attachment) error {
						if e := a.VerifyParent(row.Parent); e != nil {
							return e
						}
						if row.External != "" {
							target, e := junctionTarget(filepath.Join(mount, "Bee"))
							if e != nil || !strings.EqualFold(target, row.External) {
								return errors.New("retained external Bee target changed")
							}
						}
						if e := writeCapacityProbe(project, 2000+round*10+i); e != nil {
							return e
						}
						for _, platform := range []string{"edit_mode", "play_mode"} {
							phaseName := fmt.Sprintf("%s-compat%d-%s", name, round, platform)
							fmt.Println("phase", phaseName)
							phase, e := runCapacityPhase(ctx, root, phaseName, row.Child, row.External, func() (string, int, int, error) {
								return capacityTests(ctx, testplay, project, platform, filepath.Join(root, phaseName))
							})
							phases = append(phases, phase)
							if e != nil {
								return e
							}
							if row.External != "" {
								target, e := junctionTarget(filepath.Join(mount, "Bee"))
								if e != nil || !strings.EqualFold(target, row.External) {
									return errors.New("Unity replaced retained external Bee junction")
								}
							}
						}
						return nil
					})
				}
				usage, ue := storage.FileUsageOf(row.Child)
				e = errors.Join(e, ue)
				outcomes[i] = map[string]any{"round": round, "iteration": row.Iteration, "phases": phases, "detached": usage, "ok": e == nil}
				if e != nil {
					outcomes[i]["error"] = e.Error()
				}
				failures[i] = e
			}(i, row)
		}
		wg.Wait()
		results = append(results, outcomes...)
		if err = errors.Join(failures...); err != nil {
			return
		}
	}
	return nil
}
