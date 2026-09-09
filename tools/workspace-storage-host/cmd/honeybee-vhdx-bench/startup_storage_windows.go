//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"

	"golang.org/x/sys/windows"
)

const startupBudget uint64 = 15 << 30
const startupFloor uint64 = 20 << 30

func freeSpace(path string) (uint64, error) {
	p, err := windows.UTF16PtrFromString(path)
	if err != nil {
		return 0, err
	}
	var free, total, available uint64
	err = windows.GetDiskFreeSpaceEx(p, &free, &total, &available)
	return free, err
}
func admission(free, used, reserve uint64) error {
	if free < startupFloor+reserve {
		return errors.New("disk-pressure: insufficient free-space reserve")
	}
	if used+reserve > startupBudget {
		return errors.New("disk-pressure: experiment budget exceeded")
	}
	return nil
}
func startupCheckpoint(root, evidence string) error {
	free, err := freeSpace(root)
	if err != nil {
		return err
	}
	a, err := treeUsage(root)
	if err != nil {
		return err
	}
	b, err := treeUsage(evidence)
	if err != nil {
		return err
	}
	return admission(free, uint64(a.AllocatedBytes+b.AllocatedBytes), 2<<30)
}

func ownedEntry(root, p string) error {
	rel, err := filepath.Rel(root, p)
	if err != nil || rel == "." || rel == ".." || strings.ContainsAny(rel, "/\\") {
		return errors.New("cleanup entry outside owned root")
	}
	for at := root; ; at = filepath.Dir(at) {
		info, e := os.Lstat(at)
		if e != nil {
			return e
		}
		if e = regularNode(at, info); e != nil {
			return e
		}
		if filepath.Dir(at) == at {
			break
		}
	}
	return filepath.Walk(p, func(path string, info fs.FileInfo, e error) error {
		if errors.Is(e, os.ErrNotExist) && path == p {
			return nil
		}
		if e != nil {
			return e
		}
		return regularNode(path, info)
	})
}

func ensureDetached(child string) error {
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; (Get-DiskImage -ImagePath $env:HB_CHECK_IMAGE).Attached | ConvertTo-Json -Compress`)
	cmd.Env = append(os.Environ(), "HB_CHECK_IMAGE="+child)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("detach check: %w: %s", err, out)
	}
	var attached bool
	if err = json.Unmarshal(out, &attached); err != nil {
		return err
	}
	if attached {
		return errors.New("refusing cleanup of attached image")
	}
	return nil
}

func archiveStartupSample(root, evidence string, row capacitySample, suffix ...string) (string, error) {
	name := fmt.Sprintf("%s-%d", row.Mode, row.Iteration)
	tag := ""
	if len(suffix) > 0 {
		if suffix[0] != "compat" && suffix[0] != "failed" {
			return "", errors.New("unsupported archive suffix")
		}
		tag = "-" + suffix[0]
	}
	archive := filepath.Join(evidence, name+tag+".zip")
	if _, err := os.Stat(archive); err == nil {
		return "", errors.New("sample archive already exists")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, "python", "scripts/benchmarks/vhdx/inspect_vhdx.py", row.Child, "--output", filepath.Join(root, name+tag+"-allocation.json"))
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		if row.Error == "" {
			return "", fmt.Errorf("allocation inspection: %w: %.500s", err, out)
		}
		if e := save(filepath.Join(root, name+tag+"-allocation.json"), map[string]any{"error": fmt.Sprintf("%v: %.500s", err, out)}); e != nil {
			return "", e
		}
	}
	cmd = exec.CommandContext(ctx, "python", "scripts/benchmarks/vhdx/archive_capacity.py", root, archive, "--sample", name)
	if strings.HasPrefix(row.Mode, "E-fp-") && row.AllocationMeasurement != "native-allocated-v2" {
		cmd.Args = append(cmd.Args, "--exploratory")
	}
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("sample archive: %w: %.500s", err, out)
	}
	return archive, nil
}

func removeStartupSample(root, evidence string, row capacitySample, archive string) error {
	name := fmt.Sprintf("%s-%d", row.Mode, row.Iteration)
	if row.Child != filepath.Join(root, name+".vhdx") || (archive != filepath.Join(evidence, name+".zip") && archive != filepath.Join(evidence, name+"-compat.zip") && archive != filepath.Join(evidence, name+"-failed.zip")) {
		return errors.New("cleanup identity mismatch")
	}
	receiptPath := strings.TrimSuffix(archive, ".zip") + ".receipt.json"
	raw, err := os.ReadFile(receiptPath)
	if err != nil {
		return err
	}
	var receipt struct {
		Root, Archive, Sample, SHA256 string
		Verified                      bool
	}
	if err = json.Unmarshal(raw, &receipt); err != nil {
		return err
	}
	if !receipt.Verified || receipt.Root != root || receipt.Archive != archive || receipt.Sample != name {
		return errors.New("unverified sample archive")
	}
	hash, err := hashFileRecord(archive)
	if err != nil {
		return err
	}
	if hash.SHA256 != receipt.SHA256 {
		return errors.New("sample archive changed")
	}
	if err = ensureDetached(row.Child); err != nil {
		return err
	}
	paths := []string{row.Child, filepath.Join(root, name), filepath.Join(root, name+"-readonly")}
	paths = append(paths, filepath.Join(root, name+"-first.log.etl"))
	if row.External != "" {
		if row.External != filepath.Join(root, name+"-bee") {
			return errors.New("external cleanup identity mismatch")
		}
		paths = append(paths, row.External)
	}
	for _, p := range paths {
		if err = ownedEntry(root, p); err != nil {
			return err
		}
	}
	for _, p := range paths {
		if err = os.RemoveAll(p); err != nil {
			return err
		}
	}
	return save(filepath.Join(root, name+"-cleanup.json"), map[string]any{"ok": true, "archiveSHA256": hash.SHA256, "removed": paths, "finishedAt": time.Now().UTC()})
}

func ownedCommand(ctx context.Context, name string, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, name, args...)
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Cancel = func() error {
		if cmd.Process == nil {
			return nil
		}
		stopCtx, cancel := context.WithTimeout(context.Background(), 20*time.Second)
		defer cancel()
		script := `$p=Get-Process -Id ([int]$env:HB_STOP_PID) -ErrorAction SilentlyContinue; if($p){if($p.CloseMainWindow()){if($p.WaitForExit(10000)){exit 0}}; & taskkill.exe /PID $p.Id /T /F | Out-Null}`
		stop := exec.CommandContext(stopCtx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", script)
		stop.Env = append(os.Environ(), fmt.Sprintf("HB_STOP_PID=%d", cmd.Process.Pid))
		stop.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if err := stop.Run(); err != nil {
			return cmd.Process.Kill()
		}
		return nil
	}
	return cmd
}
