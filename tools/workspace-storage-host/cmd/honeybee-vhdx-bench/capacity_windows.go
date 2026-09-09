//go:build windows

package main

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
)

var capacityModes = []string{"A-legacy", "B-fresh", "C-no-bee", "D-hot-last", "E-external-bee"}

type capacityPhase struct {
	Name         string            `json:"name"`
	ElapsedMS    int64             `json:"elapsedMs"`
	Child        storage.FileUsage `json:"child"`
	External     storage.FileUsage `json:"external"`
	ObservedPeak int64             `json:"observedPeakAllocatedBytes"`
	TestRunID    string            `json:"testRunId,omitempty"`
	Total        int               `json:"total,omitempty"`
	Passed       int               `json:"passed,omitempty"`
}
type capacitySample struct {
	PreparationMS int64             `json:"preparationMs,omitempty"`
	ReadyMS       int64             `json:"readyMs,omitempty"`
	Mode          string            `json:"mode"`
	Iteration     int               `json:"iteration"`
	Child         string            `json:"child"`
	Parent        string            `json:"parent"`
	External      string            `json:"externalPath,omitempty"`
	Geometry      storage.SizeInfo  `json:"geometry"`
	Phases        []capacityPhase   `json:"phases"`
	Detached      storage.FileUsage `json:"detached"`
	Verified      storage.FileUsage `json:"afterReadonlyVerification"`
	Error         string            `json:"error,omitempty"`
}

func treeUsage(root string) (usage storage.FileUsage, err error) {
	if root == "" {
		return usage, nil
	}
	err = filepath.Walk(root, func(p string, info fs.FileInfo, e error) error {
		if e != nil {
			return e
		}
		if e = regularNode(p, info); e != nil {
			return e
		}
		if info.IsDir() {
			return nil
		}
		u, e := storage.FileUsageOf(p)
		if e != nil {
			return e
		}
		usage.LogicalBytes += u.LogicalBytes
		usage.AllocatedBytes += u.AllocatedBytes
		return nil
	})
	return
}

func capacityOrder(names []string, mode string) []string {
	result := append([]string(nil), names...)
	sort.Strings(result)
	if mode == "D-hot-last" {
		sort.SliceStable(result, func(i, j int) bool {
			hot := func(n string) bool { return n == "Bee" || n == "ScriptAssemblies" }
			return !hot(result[i]) && hot(result[j])
		})
	}
	return result
}

func copyCapacityLibrary(source, dest, mode string) error {
	entries, err := os.ReadDir(source)
	if err != nil {
		return err
	}
	var names []string
	for _, e := range entries {
		if e.Name() == "System Volume Information" || e.Name() == "$RECYCLE.BIN" {
			continue
		}
		if (mode == "C-no-bee" || mode == "E-external-bee") && e.Name() == "Bee" {
			continue
		}
		names = append(names, e.Name())
	}
	for _, name := range capacityOrder(names, mode) {
		p := filepath.Join(source, name)
		info, err := os.Lstat(p)
		if err != nil {
			return err
		}
		if err = regularNode(p, info); err != nil {
			return err
		}
		if info.IsDir() {
			err = copyTree(p, filepath.Join(dest, name))
		} else {
			err = copyFile(p, filepath.Join(dest, name))
		}
		if err != nil {
			return err
		}
	}
	return nil
}

// Only the claimed sample's exact Bee link is permitted. No generic link traversal.
func scanCapacityLibrary(root, external string) (manifest, error) {
	if external == "" {
		return scanParallel(root)
	}
	bee := filepath.Join(root, "Bee")
	resolved, err := junctionTarget(bee)
	if err != nil || !strings.EqualFold(filepath.Clean(resolved), filepath.Clean(external)) {
		return nil, fmt.Errorf("unexpected Bee junction: %s: %w", resolved, err)
	}
	result := manifest{}
	entries, err := os.ReadDir(root)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		name := entry.Name()
		if name == "System Volume Information" || name == "$RECYCLE.BIN" {
			continue
		}
		p := filepath.Join(root, name)
		if name == "Bee" {
			p = external
		}
		info, err := os.Lstat(p)
		if err != nil {
			return nil, err
		}
		if err = regularNode(p, info); err != nil {
			return nil, err
		}
		if info.IsDir() {
			m, e := scanParallel(p)
			if e != nil {
				return nil, e
			}
			for k, v := range m {
				result[name+"/"+k] = v
			}
		} else {
			v, e := hashFileRecord(p)
			if e != nil {
				return nil, e
			}
			result[name] = v
		}
	}
	return result, nil
}

func hashFileRecord(p string) (fileRecord, error) {
	f, err := os.Open(p)
	if err != nil {
		return fileRecord{}, err
	}
	defer f.Close()
	h := sha256.New()
	n, err := io.Copy(h, f)
	return fileRecord{Bytes: n, SHA256: hex.EncodeToString(h.Sum(nil))}, err
}

func writeCapacityProbe(project string, revision int) error {
	code := fmt.Sprintf("namespace HoneyBee.Capacity { public static class Probe { public const int Revision = %d; } }\n", revision)
	if err := os.WriteFile(filepath.Join(project, "Assets", "Combat", "Core", "HoneyBeeCapacityProbe.cs"), []byte(code), 0600); err != nil {
		return err
	}
	resources := filepath.Join(project, "Assets", "Resources")
	if err := os.MkdirAll(resources, 0700); err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(resources, "HoneyBeeCapacityProbe.txt"), []byte(fmt.Sprint(revision)), 0600)
}

func prepareCapacityProbe(project string) error {
	if err := writeCapacityProbe(project, 0); err != nil {
		return err
	}
	dir := filepath.Join(project, "Assets", "HoneyBeeCapacityTests")
	if err := os.Mkdir(dir, 0700); err != nil {
		return err
	}
	assembly := `{"name":"HoneyBee.Capacity.Tests","references":["Combat.Core"],"includePlatforms":["Editor"],"optionalUnityReferences":["TestAssemblies"]}`
	if err := os.WriteFile(filepath.Join(dir, "HoneyBee.Capacity.Tests.asmdef"), []byte(assembly), 0600); err != nil {
		return err
	}
	code := `using NUnit.Framework;
using UnityEngine;
using UnityEditor;
public sealed class HoneyBeeCapacityTests {
    [Test] public void RecompileAndReimportMatchThisWorkspace() {
        AssetDatabase.ImportAsset("Assets/Resources/HoneyBeeCapacityProbe.txt", ImportAssetOptions.ForceUpdate);
        var asset = Resources.Load<TextAsset>("HoneyBeeCapacityProbe");
        Assert.That(asset, Is.Not.Null);
        Assert.That(asset.text, Is.EqualTo(HoneyBee.Capacity.Probe.Revision.ToString()));
    }
}
`
	return os.WriteFile(filepath.Join(dir, "HoneyBeeCapacityTests.cs"), []byte(code), 0600)
}

func capacityConfigs(project, unity string) error {
	for _, platform := range []string{"edit_mode", "play_mode"} {
		cfg := map[string]any{"schema_version": "1", "unity_path": unity, "project_path": ".", "test_platform": platform, "timeout": map[string]int{"total_ms": 300000}, "result_dir": ".testplay/results", "retention": map[string]int{"max_runs": 30}}
		if err := save(filepath.Join(project, platform+".json"), cfg); err != nil {
			return err
		}
	}
	return nil
}

func makeBeeLink(ctx context.Context, mount, external, seed string) error {
	link := filepath.Join(mount, "Bee")
	if _, err := os.Lstat(link); !errors.Is(err, os.ErrNotExist) {
		return errors.New("Bee link destination exists")
	}
	if err := os.Mkdir(external, 0700); err != nil {
		return err
	}
	if err := copyTree(seed, external); err != nil {
		return err
	}
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:HB_CAPACITY_LINK -Target $env:HB_CAPACITY_EXTERNAL | Out-Null`)
	cmd.Env = append(os.Environ(), "HB_CAPACITY_LINK="+link, "HB_CAPACITY_EXTERNAL="+external)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("Bee junction: %w: %s", err, out)
	}
	target, e := junctionTarget(link)
	if e != nil || !strings.EqualFold(target, external) {
		return fmt.Errorf("created Bee junction target %q: %w", target, e)
	}
	return nil
}

func runCapacityPhase(ctx context.Context, root, name, child, external string, fn func() (string, int, int, error)) (phase capacityPhase, err error) {
	phase.Name = name
	stop := make(chan struct{})
	type peakResult struct {
		bytes int64
		err   error
	}
	done := make(chan peakResult, 1)
	go func() {
		var result peakResult
		ticker := time.NewTicker(250 * time.Millisecond)
		defer ticker.Stop()
		for {
			u, e := storage.FileUsageOf(child)
			if e != nil {
				result.err = e
			}
			if u.AllocatedBytes > result.bytes {
				result.bytes = u.AllocatedBytes
			}
			select {
			case <-stop:
				done <- result
				return
			case <-ticker.C:
			}
		}
	}()
	started := time.Now()
	phase.TestRunID, phase.Total, phase.Passed, err = fn()
	phase.ElapsedMS = time.Since(started).Milliseconds()
	close(stop)
	peak := <-done
	phase.ObservedPeak = peak.bytes
	err = errors.Join(err, peak.err)
	phase.Child, peak.err = storage.FileUsageOf(child)
	err = errors.Join(err, peak.err)
	phase.External, peak.err = treeUsage(external)
	err = errors.Join(err, peak.err)
	if phase.Child.AllocatedBytes > phase.ObservedPeak {
		phase.ObservedPeak = phase.Child.AllocatedBytes
	}
	err = errors.Join(err, save(filepath.Join(root, name+"-phase.json"), phase))
	return
}

func capacityTests(ctx context.Context, testplay, project, platform, log string) (string, int, int, error) {
	cmd := ownedCommand(ctx, testplay, "run", "--config", filepath.Join(project, platform+".json"), "--no-bridge")
	cmd.Dir = project
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	stderr, err := os.Create(log + ".stderr.log")
	if err != nil {
		return "", 0, 0, err
	}
	defer stderr.Close()
	cmd.Stderr = stderr
	out, err := cmd.Output()
	if e := os.WriteFile(log+".json", out, 0600); e != nil {
		return "", 0, 0, errors.Join(err, e)
	}
	var result struct {
		RunID                          string `json:"run_id"`
		Backend                        string `json:"backend"`
		Total, Passed, Failed, Skipped int
		ExitCode                       int `json:"exit_code"`
	}
	if e := json.Unmarshal(out, &result); e != nil {
		return "", 0, 0, errors.Join(err, e)
	}
	expected := 37
	if platform == "play_mode" {
		expected = 15
	}
	if err != nil || result.Backend != "process" || result.ExitCode != 0 || result.Total != expected || result.Passed != expected || result.Failed != 0 || result.Skipped != 0 {
		return result.RunID, result.Total, result.Passed, fmt.Errorf("%s validation failed: backend=%s total=%d passed=%d: %w", platform, result.Backend, result.Total, result.Passed, err)
	}
	return result.RunID, result.Total, result.Passed, nil
}

func capacitySampleRun(ctx context.Context, root, frozen, unity, testplay, parent, mode string, iteration, cycles int) (row capacitySample, err error) {
	preparedAt := time.Now()
	name := fmt.Sprintf("%s-%d", mode, iteration)
	project := filepath.Join(root, name)
	child := filepath.Join(root, name+".vhdx")
	row = capacitySample{Mode: mode, Iteration: iteration, Child: child, Parent: parent}
	defer func() {
		if err != nil {
			row.Error = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, name+"-sample.json"), row))
	}()
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings"} {
		if err = copyTree(filepath.Join(frozen, folder), filepath.Join(project, folder)); err != nil {
			return
		}
	}
	if err = capacityConfigs(project, unity); err != nil {
		return
	}
	if err = createChild(child, parent, 1<<20); err != nil {
		return
	}
	mount := filepath.Join(project, "Library")
	if strings.HasPrefix(mode, "E-") {
		row.External = filepath.Join(root, name+"-bee")
	}
	err = withDisk(ctx, child, mount, false, func(a *storage.Attachment) error {
		if e := a.VerifyParent(parent); e != nil {
			return e
		}
		var e error
		row.Geometry, e = a.Size()
		if e != nil {
			return e
		}
		if row.Geometry.BlockSize != 1<<20 {
			return errors.New("unexpected child geometry")
		}
		if row.External != "" {
			if e = makeBeeLink(ctx, mount, row.External, filepath.Join(frozen, "Library", "Bee")); e != nil {
				return e
			}
		}
		if e = applyStartupPolicy(ctx, mode, mount, row.External, filepath.Join(frozen, "Library", "Bee")); e != nil {
			return e
		}
		row.PreparationMS = time.Since(preparedAt).Milliseconds()
		if e = startupSnapshot(ctx, root, name+"-before", row.External); e != nil {
			return e
		}
		for _, p := range []string{"first", "reopen"} {
			phaseName := name + "-" + p
			fmt.Println("phase", phaseName)
			phase, e := runCapacityPhase(ctx, root, phaseName, child, row.External, func() (string, int, int, error) {
				opts, _ := ctx.Value(startupKey{}).(startupOptions)
				_, e := launchUnity(ctx, unity, project, filepath.Join(root, phaseName+".log"), opts.Trace && p == "first")
				return "", 0, 0, e
			})
			row.Phases = append(row.Phases, phase)
			if e != nil {
				return e
			}
			if p == "first" {
				row.ReadyMS = row.PreparationMS + phase.ElapsedMS
				if e = startupSnapshot(ctx, root, name+"-after", row.External); e != nil {
					return e
				}
				if e = startupProfiles(ctx, root, name, row.External); e != nil {
					return e
				}
			}
			if row.External != "" {
				target, e := junctionTarget(filepath.Join(mount, "Bee"))
				if e != nil || !strings.EqualFold(target, row.External) {
					return fmt.Errorf("Unity replaced external Bee junction after %s: %w", p, e)
				}
			}
		}
		for cycle := 1; cycle <= cycles; cycle++ {
			if e = writeCapacityProbe(project, cycle+iteration*100); e != nil {
				return e
			}
			for _, platform := range []string{"edit_mode", "play_mode"} {
				phaseName := fmt.Sprintf("%s-cycle%d-%s", name, cycle, platform)
				fmt.Println("phase", phaseName)
				phase, e := runCapacityPhase(ctx, root, phaseName, child, row.External, func() (string, int, int, error) {
					return capacityTests(ctx, testplay, project, platform, filepath.Join(root, phaseName))
				})
				row.Phases = append(row.Phases, phase)
				if e != nil {
					return e
				}
				if row.External != "" {
					target, e := junctionTarget(filepath.Join(mount, "Bee"))
					if e != nil || !strings.EqualFold(target, row.External) {
						return fmt.Errorf("Unity replaced external Bee junction after %s: %w", platform, e)
					}
				}
			}
			if e = save(filepath.Join(root, name+"-progress.json"), row); e != nil {
				return e
			}
		}
		return nil
	})
	if err != nil {
		return
	}
	row.Detached, err = storage.FileUsageOf(child)
	if err != nil {
		return
	}
	verify := filepath.Join(root, name+"-readonly")
	err = withReadOnlyDisk(ctx, child, verify, func(a *storage.Attachment) error {
		if e := a.VerifyParent(parent); e != nil {
			return e
		}
		m, e := scanCapacityLibrary(verify, row.External)
		if e != nil {
			return e
		}
		if e = save(filepath.Join(root, name+"-manifest.json"), m); e != nil {
			return e
		}
		if e = saveCapacityExtents(verify, filepath.Join(root, name+"-extents.json"), row.External); e != nil {
			return e
		}
		return saveCapacityVolume(ctx, a, filepath.Join(root, name+"-volume.json"))
	})
	if err != nil {
		return
	}
	row.Verified, err = storage.FileUsageOf(child)
	if row.Verified != row.Detached {
		err = errors.Join(err, errors.New("readonly verification changed allocation"))
	}
	return
}

func runCapacity(root, source, unity, legacyParent, testplay string, runs, cycles int) (err error) {
	if runs < 1 || runs > 3 || cycles < 1 || cycles > 5 {
		return errors.New("capacity requires runs 1..3 and cycles 1..5")
	}
	if err = validateRoot(root); err != nil {
		return
	}
	for _, p := range []string{source, unity, legacyParent, testplay} {
		if !filepath.IsAbs(p) {
			return errors.New("capacity inputs must be absolute")
		}
	}
	ctx, cancel := context.WithTimeout(context.Background(), 6*time.Hour)
	defer cancel()
	elevated, e := storage.IsElevated(ctx)
	if e != nil {
		return e
	}
	if !elevated {
		return errors.New("capacity requires elevation for disposable disks")
	}
	if err = os.Mkdir(root, 0700); err != nil {
		return
	}
	defer func() {
		status := map[string]any{"ok": err == nil, "finishedAt": time.Now().UTC(), "protocol": "capacity-v1", "runs": runs, "cycles": cycles}
		if err != nil {
			status["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), status))
	}()
	frozen := filepath.Join(root, "source")
	for _, folder := range []string{"Assets", "Packages", "ProjectSettings"} {
		before, e := scanParallel(filepath.Join(source, folder))
		if e != nil {
			return e
		}
		if e = copyTree(filepath.Join(source, folder), filepath.Join(frozen, folder)); e != nil {
			return e
		}
		after, e := scanParallel(filepath.Join(frozen, folder))
		if e != nil {
			return e
		}
		if !same(before, after) {
			return errors.New("frozen source copy mismatch")
		}
	}
	if err = prepareCapacityProbe(frozen); err != nil {
		return
	}
	// Import only an isolated snapshot. User Library and dirty authored files are never copied.
	fmt.Println("prepare fresh Library")
	if _, err = launchUnity(ctx, unity, frozen, filepath.Join(root, "seed-first.log"), false); err != nil {
		return
	}
	if _, err = launchUnity(ctx, unity, frozen, filepath.Join(root, "seed-reopen.log"), false); err != nil {
		return
	}
	seed, err := scanParallel(filepath.Join(frozen, "Library"))
	if err != nil {
		return
	}
	if err = save(filepath.Join(root, "seed-manifest.json"), seed); err != nil {
		return
	}
	parents := map[string]string{}
	legacyHash, e := hashFileRecord(legacyParent)
	if e != nil {
		return e
	}
	old := filepath.Join(root, "parent-A-legacy.vhdx")
	if err = copyFile(legacyParent, old); err != nil {
		return
	}
	copied, e := hashFileRecord(old)
	if e != nil {
		return e
	}
	if legacyHash != copied {
		return errors.New("legacy parent copy mismatch")
	}
	parents["A-legacy"] = old
	for _, mode := range []string{"B-fresh", "C-no-bee", "D-hot-last"} {
		fmt.Println("prepare parent", mode)
		parent := filepath.Join(root, "parent-"+mode+".vhdx")
		if err = storage.CreateDynamicWithOptions(parent, storage.CreateOptions{MaximumSize: 64 << 30, BlockSizeInBytes: 2 << 20, SectorSizeInBytes: 4096}); err != nil {
			return
		}
		err = withDisk(ctx, parent, filepath.Join(root, mode+"-prepare"), true, func(a *storage.Attachment) error {
			return copyCapacityLibrary(filepath.Join(frozen, "Library"), filepath.Join(root, mode+"-prepare"), mode)
		})
		if err != nil {
			return
		}
		err = withReadOnlyDisk(ctx, parent, filepath.Join(root, mode+"-verify"), func(a *storage.Attachment) error {
			actual, e := scanParallel(filepath.Join(root, mode+"-verify"))
			if e != nil {
				return e
			}
			expected := manifest{}
			for k, v := range seed {
				if mode == "C-no-bee" && strings.HasPrefix(k, "Bee/") {
					continue
				}
				expected[k] = v
			}
			if !same(expected, actual) {
				return errors.New("parent seed content mismatch")
			}
			return nil
		})
		if err != nil {
			return
		}
		parents[mode] = parent
	}
	parents["E-external-bee"] = parents["C-no-bee"]
	parentUsage := map[string]storage.FileUsage{}
	for mode, p := range parents {
		u, e := storage.FileUsageOf(p)
		if e != nil {
			return e
		}
		parentUsage[mode] = u
	}
	if err = save(filepath.Join(root, "campaign.json"), map[string]any{"protocol": "capacity-v1", "source": source, "unity": unity, "testplay": testplay, "runs": runs, "cycles": cycles, "parents": parents, "parentUsage": parentUsage, "legacyParentHash": legacyHash, "targetBytes": 300000000, "peakPollMS": 250}); err != nil {
		return
	}
	var failures []error
	var rows []capacitySample
	for iteration := 0; iteration < runs; iteration++ {
		for offset := 0; offset < len(capacityModes); offset++ {
			mode := capacityModes[(offset+iteration)%len(capacityModes)]
			row, e := capacitySampleRun(ctx, root, frozen, unity, testplay, parents[mode], mode, iteration, cycles)
			rows = append(rows, row)
			if e != nil {
				failures = append(failures, fmt.Errorf("%s-%d: %w", mode, iteration, e))
				fmt.Println("sample failed", mode, iteration, e)
			}
			if err = save(filepath.Join(root, "measurements.json"), rows); err != nil {
				return
			}
		}
	}
	after, e := hashFileRecord(legacyParent)
	if e != nil {
		return e
	}
	if legacyHash != after {
		return errors.New("original legacy parent changed")
	}
	return errors.Join(failures...)
}
