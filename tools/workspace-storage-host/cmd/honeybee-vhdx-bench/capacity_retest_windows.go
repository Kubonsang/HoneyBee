//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"time"
)

func retestCapacity(root, unity, testplay, mode string, iteration, cycles int) error {
	cwd, err := os.Getwd()
	if err != nil {
		return err
	}
	rel, e := filepath.Rel(filepath.Join(cwd, "tmp"), root)
	if e != nil || !filepath.IsAbs(root) || rel == "." || rel == ".." || strings.HasPrefix(rel, ".."+string(os.PathSeparator)) {
		return errors.New("pilot root outside checkout/tmp")
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
		if m == mode {
			valid = true
		}
	}
	if !valid || iteration < 0 || iteration > 9 || cycles < 1 || cycles > 5 {
		return errors.New("invalid pilot selection")
	}
	raw, err := os.ReadFile(filepath.Join(root, "campaign.json"))
	if err != nil {
		return err
	}
	var campaign struct {
		Parents map[string]string `json:"parents"`
	}
	if err = json.Unmarshal(raw, &campaign); err != nil {
		return err
	}
	parent := campaign.Parents[mode]
	parentRel, e := filepath.Rel(root, parent)
	if e != nil || strings.ContainsAny(parentRel, "/\\") {
		return errors.New("parent outside pilot root")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	_, err = capacitySampleRun(ctx, root, filepath.Join(root, "source"), unity, testplay, parent, mode, iteration, cycles)
	return err
}
