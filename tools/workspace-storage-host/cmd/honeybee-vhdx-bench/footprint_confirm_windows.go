//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"
)

// Explicit fresh confirmation; original pilot and qualification evidence is kept.
// This is needed when a campaign predates precise normal-file allocation counters.
func runFootprintConfirm(root string) (err error) {
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
	var campaign struct{ Protocol, Evidence, Unity, Testplay string }
	if err = read("campaign.json", &campaign); err != nil {
		return err
	}
	if campaign.Protocol != "footprint-v1" || campaign.Evidence != filepath.Join(cwd, "output", filepath.Base(root)+"-evidence") {
		return errors.New("unexpected footprint campaign")
	}
	var status struct {
		OK    bool
		Error string
	}
	if err = read("status.json", &status); err != nil {
		return err
	}
	accountingRecovery := !status.OK && strings.Contains(status.Error, "footprint-accounting-confirmation-required")
	if !status.OK && !accountingRecovery {
		return errors.New("confirmation requires terminal campaign")
	}
	if accountingRecovery {
		var prior []capacitySample
		if err = read("measurements.json", &prior); err != nil {
			return err
		}
		for _, row := range prior {
			if row.Iteration < 10 || row.Iteration > 12 || row.AllocationMeasurement == "native-allocated-v2" {
				continue
			}
			if err = validateFootprintRetained(root, row); err != nil {
				return err
			}
			if _, e := os.Stat(row.Child); errors.Is(e, os.ErrNotExist) {
				continue
			} else if e != nil {
				return e
			}
			archive, e := archiveStartupSample(root, campaign.Evidence, row)
			if e != nil {
				return e
			}
			if e = removeStartupSample(root, campaign.Evidence, row, archive); e != nil {
				return e
			}
		}
		if err = save(filepath.Join(root, "accounting-recovery.json"), map[string]any{"ok": true, "originalFailurePreserved": true, "excludedIterations": []int{10, 11, 12}, "reason": "ordinary-file EOF counter superseded by native allocation; incomplete formal stage explicitly archived as exploratory"}); err != nil {
			return err
		}
	}
	var screening struct {
		Advanced []footprintPolicy
		Policies []footprintPolicy
		Metrics  map[string]map[string]float64
	}
	if err = read("screening.json", &screening); err != nil {
		return err
	}
	policies := []footprintPolicy{{"E-fp-base", 64, "none"}}
	for _, p := range screening.Policies {
		if p.Name != "E-fp-base" && footprintScreenPass(screening.Metrics[p.Name], screening.Metrics["E-fp-base"]) {
			policies = append(policies, p)
		}
	}
	if len(policies) == 1 {
		return errors.New("no screened candidates to confirm")
	}
	seen := map[string]bool{}
	for _, p := range policies {
		if seen[p.Name] {
			return errors.New("duplicate confirmation policy")
		}
		seen[p.Name] = true
		r := capacitySample{Mode: p.Name, Iteration: 200, Child: filepath.Join(root, p.Name+"-200.vhdx"), External: filepath.Join(root, p.Name+"-200-bee"), Parent: filepath.Join(root, fmt.Sprintf("parent-fp-%d.vhdx", p.CapacityGiB))}
		if err = validateFootprintRetained(root, r); err != nil {
			return err
		}
		if p.Compression != "none" && p.Compression != "all" && p.Compression != "artifacts" {
			return errors.New("unsupported confirmation compression")
		}
		if err = ownedEntry(root, r.Parent); err != nil {
			return err
		}
		var original fileRecord
		if err = read(fmt.Sprintf("parent-%d-identity.json", p.CapacityGiB), &original); err != nil {
			return err
		}
		actual, e := hashFileRecord(r.Parent)
		if e != nil {
			return e
		}
		if actual != original {
			return errors.New("confirmation parent changed")
		}
	}
	marker, err := os.OpenFile(filepath.Join(root, "confirmation-started.json"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	err = json.NewEncoder(marker).Encode(map[string]any{"allocationMeasurement": "native-allocated-v2", "policies": policies, "selectionRationale": "Preserve pilot evidence; apply registered >=5% combined savings and <=10% timing screening. Final combined peak gate is evaluated in fresh qualification; a component child peak is not the selected combined-cache objective.", "startedAt": time.Now().UTC()})
	err = errors.Join(err, marker.Close())
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Hour)
	defer cancel()
	stop := watchStartupFloor(root, cancel)
	rows := []capacitySample{}
	metrics := map[string]map[string]float64{}
	selected := ""
	qualified := false
	defer func() {
		err = errors.Join(err, stop())
		r := map[string]any{"ok": err == nil, "qualified": qualified, "selected": selected, "metrics": metrics, "allocationMeasurement": "native-allocated-v2", "finishedAt": time.Now().UTC()}
		if err != nil {
			r["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "confirmation.json"), r))
	}()
	run := func(p footprintPolicy, iteration, cycles int, retain bool) (capacitySample, error) {
		if e := startupCheckpoint(root, campaign.Evidence); e != nil {
			return capacitySample{}, e
		}
		sampleCtx := context.WithValue(context.WithValue(ctx, startupKey{}, startupOptions{}), footprintKey{}, footprintOptions{p.Compression})
		r, e := capacitySampleRun(sampleCtx, root, filepath.Join(root, "source"), campaign.Unity, campaign.Testplay, filepath.Join(root, fmt.Sprintf("parent-fp-%d.vhdx", p.CapacityGiB)), p.Name, iteration, cycles)
		rows = append(rows, r)
		e = errors.Join(e, save(filepath.Join(root, "confirmation-measurements.json"), rows))
		if e != nil {
			return r, e
		}
		archive, e := archiveStartupSample(root, campaign.Evidence, r)
		if e != nil {
			return r, e
		}
		if !retain {
			e = removeStartupSample(root, campaign.Evidence, r, archive)
		}
		return r, e
	}
	groups := map[string][]capacitySample{}
	for i := 0; i < 3; i++ {
		for j := range policies {
			p := policies[(i+j)%len(policies)]
			r, e := run(p, 200+i, 5, false)
			if e != nil {
				return e
			}
			groups[p.Name] = append(groups[p.Name], r)
		}
	}
	base := footprintMetrics(groups["E-fp-base"])
	metrics["E-fp-base"] = base
	winners := []footprintPolicy{}
	for _, p := range policies[1:] {
		m := footprintMetrics(groups[p.Name])
		metrics[p.Name] = m
		if footprintPass(m, base, .20) {
			winners = append(winners, p)
		}
	}
	sort.Slice(winners, func(i, j int) bool {
		return metrics[winners[i].Name]["combinedMedianBytes"] < metrics[winners[j].Name]["combinedMedianBytes"]
	})
	if len(winners) > 0 {
		best := winners[0]
		for _, p := range winners {
			if metrics[p.Name]["combinedMedianBytes"] <= metrics[winners[0].Name]["combinedMedianBytes"]*1.05 && metrics[p.Name]["readyMs"] < metrics[best.Name]["readyMs"] {
				best = p
			}
		}
		selected = best.Name
		var retained []capacitySample
		for i := 0; i < 2; i++ {
			r, e := run(best, 300+i, 1, true)
			if e != nil {
				return e
			}
			retained = append(retained, r)
		}
		if err = verifyStartupRetained(ctx, root, campaign.Evidence, campaign.Unity, campaign.Testplay, retained); err != nil {
			return err
		}
		qualified = true
	}
	return nil
}
