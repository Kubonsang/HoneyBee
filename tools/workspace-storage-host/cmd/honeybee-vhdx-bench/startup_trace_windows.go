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
)

func runStartupTrace(root, unity, testplay, policy string, iteration int) (err error) {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	if err = ownedEntry(filepath.Join(cwd, "tmp"), root); err != nil {
		return err
	}
	if iteration < 90 || iteration > 99 {
		return errors.New("diagnostic trace iteration must be 90..99")
	}
	valid := false
	if policy == "E-dag" {
		valid = true
	}
	for _, p := range startupPolicies {
		if p == policy {
			valid = true
		}
	}
	if !valid {
		return errors.New("unknown startup trace policy")
	}
	raw, err := os.ReadFile(filepath.Join(root, "campaign.json"))
	if err != nil {
		return err
	}
	var campaign struct {
		Protocol, Evidence string
		Parents            map[string]string
	}
	if err = json.Unmarshal(raw, &campaign); err != nil {
		return err
	}
	if campaign.Protocol != "startup-v2" || campaign.Evidence != filepath.Join(cwd, "output", filepath.Base(root)+"-evidence") {
		return errors.New("unexpected study identity")
	}
	raw, err = os.ReadFile(filepath.Join(root, "status.json"))
	if err != nil {
		return err
	}
	var status struct{ OK bool }
	if err = json.Unmarshal(raw, &status); err != nil {
		return err
	}
	if !status.OK {
		return errors.New("trace requires a completed study")
	}
	parent := campaign.Parents["E"]
	if policy == "A-legacy" {
		parent = campaign.Parents["A"]
	}
	if err = ownedEntry(root, parent); err != nil {
		return err
	}
	name := fmt.Sprintf("%s-%d", policy, iteration)
	if _, e := os.Stat(filepath.Join(root, name+"-sample.json")); !errors.Is(e, os.ErrNotExist) {
		return errors.New("trace sample identity exists")
	}
	if err = startupCheckpoint(root, campaign.Evidence); err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 20*time.Minute)
	defer cancel()
	monitor := watchStartupFloor(root, cancel)
	defer func() { err = errors.Join(err, monitor()) }()
	ctx = context.WithValue(ctx, startupKey{}, startupOptions{Diagnostics: true, Trace: true})
	row, err := capacitySampleRun(ctx, root, filepath.Join(root, "source"), unity, testplay, parent, policy, iteration, 1)
	if err != nil {
		return err
	}
	archive, err := archiveStartupSample(root, campaign.Evidence, row)
	if err != nil {
		return err
	}
	if err = removeStartupSample(root, campaign.Evidence, row, archive); err != nil {
		return err
	}
	return save(filepath.Join(root, name+"-trace-status.json"), map[string]any{"ok": true, "traced": true, "qualifiedTiming": false})
}
