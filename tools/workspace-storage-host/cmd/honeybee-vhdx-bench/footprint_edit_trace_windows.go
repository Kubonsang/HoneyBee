//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

func traceFootprintEdit(ctx context.Context, log string, run func() (string, int, int, error)) (id string, total, passed int, err error) {
	instance := fmt.Sprintf("HoneyBeeFootprintEdit-%d-%d", os.Getpid(), time.Now().UnixNano())
	start := exec.CommandContext(ctx, "wpr.exe", "-start", "FileIO", "-filemode", "-instancename", instance)
	start.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, e := start.CombinedOutput(); e != nil {
		return "", 0, 0, fmt.Errorf("start owned edit trace: %w: %s", e, out)
	}
	defer func() {
		stopCtx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
		defer cancel()
		stop := exec.CommandContext(stopCtx, "wpr.exe", "-stop", log+".etl", "-instancename", instance)
		stop.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if out, e := stop.CombinedOutput(); e != nil {
			err = errors.Join(err, fmt.Errorf("stop owned edit trace: %w: %s", e, out))
		}
	}()
	return run()
}

func runFootprintEditDiagnostic(root string) (err error) {
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
	var confirmation struct{ OK bool }
	if err = read("confirmation.json", &confirmation); err != nil {
		return err
	}
	if !confirmation.OK {
		return errors.New("edit trace requires terminal confirmation")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	stop := watchStartupFloor(root, cancel)
	defer func() { err = errors.Join(err, stop()) }()
	if err = startupCheckpoint(root, campaign.Evidence); err != nil {
		return err
	}
	sampleCtx := context.WithValue(context.WithValue(ctx, startupKey{}, startupOptions{}), footprintKey{}, footprintOptions{Compression: "none"})
	parent := filepath.Join(root, "parent-fp-64.vhdx")
	row, err := capacitySampleRun(sampleCtx, root, filepath.Join(root, "source"), campaign.Unity, campaign.Testplay, parent, "E-fp-base", 91, 0)
	if err != nil {
		return err
	}
	name := "E-fp-base-91"
	project := filepath.Join(root, name)
	mount := filepath.Join(project, "Library")
	defer func() {
		if err != nil {
			row.Error = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, name+"-sample.json"), row))
	}()
	for _, suffix := range []string{"full-extents", "metadata", "volume", "manifest"} {
		if err = copyFile(filepath.Join(root, name+"-"+suffix+".json"), filepath.Join(root, name+"-before-edit-"+suffix+".json")); err != nil {
			return err
		}
	}
	inspect := exec.CommandContext(ctx, "python", "scripts/benchmarks/vhdx/inspect_vhdx.py", row.Child, "--output", filepath.Join(root, name+"-before-edit-allocation.json"))
	inspect.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, e := inspect.CombinedOutput(); e != nil {
		return fmt.Errorf("before-edit allocation: %w: %.500s", e, out)
	}
	if err = emptyOwnedMount(mount); err != nil {
		return err
	}
	err = withDisk(ctx, row.Child, mount, false, func(a *storage.Attachment) error {
		if e := a.VerifyParent(parent); e != nil {
			return e
		}
		if e := writeCapacityProbe(project, 9101); e != nil {
			return e
		}
		_, _, _, traceErr := traceFootprintEdit(ctx, filepath.Join(root, name+"-edit.log"), func() (string, int, int, error) {
			for _, platform := range []string{"edit_mode", "play_mode"} {
				phaseName := name + "-cycle1-" + platform
				fmt.Println("phase", phaseName)
				phase, e := runCapacityPhase(sampleCtx, root, phaseName, row.Child, row.External, func() (string, int, int, error) {
					return capacityTests(ctx, campaign.Testplay, project, platform, filepath.Join(root, phaseName))
				})
				row.Phases = append(row.Phases, phase)
				if e != nil {
					return "", 0, 0, e
				}
				target, e := junctionTarget(filepath.Join(mount, "Bee"))
				if e != nil || !strings.EqualFold(target, row.External) {
					return "", 0, 0, errors.New("edit trace Bee target changed")
				}
			}
			return "diagnostic-cycle", 52, 52, nil
		})
		return traceErr
	})
	if err != nil {
		return err
	}
	row.Detached, err = storage.FileUsageOf(row.Child)
	if err != nil {
		return err
	}
	verify := filepath.Join(root, name+"-edit-readonly")
	err = withReadOnlyDisk(ctx, row.Child, verify, func(a *storage.Attachment) error {
		m, e := scanCapacityLibrary(verify, row.External)
		if e != nil {
			return e
		}
		if e = save(filepath.Join(root, name+"-manifest.json"), m); e != nil {
			return e
		}
		if e = saveFootprintExtents(verify, filepath.Join(root, name+"-full-extents.json")); e != nil {
			return e
		}
		return saveFootprintMetadata(ctx, a, filepath.Join(root, name+"-metadata.json"))
	})
	if err != nil {
		return err
	}
	row.Verified, err = storage.FileUsageOf(row.Child)
	if err != nil {
		return err
	}
	if row.Detached != row.Verified {
		return errors.New("edit readonly verification changed allocation")
	}
	if err = saveFootprintCompression(row.External, filepath.Join(root, name+"-compression.json")); err != nil {
		return err
	}
	if err = save(filepath.Join(root, name+"-sample.json"), row); err != nil {
		return err
	}
	archive, err := archiveStartupSample(root, campaign.Evidence, row)
	if err != nil {
		return err
	}
	if err = removeStartupSample(root, campaign.Evidence, row, archive); err != nil {
		return err
	}
	// removeStartupSample handles the first-open trace name; the edit trace is also owned.
	editTrace := filepath.Join(root, name+"-edit.log.etl")
	if err = ownedEntry(root, editTrace); err != nil {
		return err
	}
	if err = os.Remove(editTrace); err != nil {
		return err
	}
	return save(filepath.Join(root, "edit-diagnostic.json"), map[string]any{"ok": true, "timingExcluded": true, "sample": name, "archive": archive, "finishedAt": time.Now().UTC()})
}
