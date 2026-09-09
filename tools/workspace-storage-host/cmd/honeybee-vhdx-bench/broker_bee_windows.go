//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"time"
)

// Uses the real broker implementation in an isolated process/store. It never
// calls the installed pipe. Build with the reviewed storage overlay in GOWORK.
func runBrokerBee(root, source, unity, testplay string) (err error) {
	if err = validateRoot(root); err != nil {
		return err
	}
	for _, p := range []string{source, unity, testplay} {
		if !filepath.IsAbs(p) {
			return errors.New("absolute inputs required")
		}
	}
	if _, e := os.Stat(filepath.Join(source, "Library")); !os.IsNotExist(e) {
		return errors.New("frozen authored export required")
	}
	free, e := freeSpace(filepath.Dir(root))
	if e != nil || free < 35<<30 {
		return errors.New("35 GiB free space required")
	}
	if err = os.Mkdir(root, 0700); err != nil {
		return err
	}
	var phases []capacityPhase
	defer func() {
		status := map[string]any{"ok": err == nil, "protocol": "broker-bee-v1", "phases": phases, "finishedAt": time.Now().UTC()}
		if err != nil {
			status["error"] = err.Error()
		}
		err = errors.Join(err, save(filepath.Join(root, "status.json"), status))
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	go func() {
		ticker := time.NewTicker(5 * time.Second)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				free, e := freeSpace(root)
				if e != nil || free < 20<<30 {
					cancel()
					return
				}
			}
		}
	}()
	token, e := windows.OpenCurrentProcessToken()
	if e != nil {
		return e
	}
	defer token.Close()
	user, e := token.GetTokenUser()
	if e != nil {
		return e
	}
	sid := user.User.Sid.String()
	envelopes := filepath.Join(root, "envelopes")
	if err = os.Mkdir(envelopes, 0700); err != nil {
		return err
	}
	cfg := workspace.BrokerConfig{StoreRoot: filepath.Join(root, "store"), WorkspaceRoot: envelopes, UserSID: sid, ParentTTL: time.Nanosecond}
	broker, e := workspace.NewBroker(cfg, workspace.NewNative())
	if e != nil {
		return e
	}
	seq := 0
	call := func(r workspace.Request) (workspace.Response, error) {
		seq++
		r.SchemaVersion = workspace.ProtocolSchemaVersion
		r.RequestID = fmt.Sprintf("bee-gnf-%d", seq)
		v := broker.Handle(ctx, sid, r)
		if !v.OK {
			return v, fmt.Errorf("%s: %v", r.Operation, v.Error)
		}
		return v, nil
	}
	hello, e := call(workspace.Request{Operation: workspace.OperationHello})
	if e != nil {
		return e
	}
	raw, _ := json.Marshal(hello)
	if !strings.Contains(string(raw), "external-bee-dag-v1") {
		return errors.New("build must use external Bee storage overlay")
	}
	frozen := filepath.Join(root, "source")
	for _, dir := range []string{"Assets", "Packages", "ProjectSettings"} {
		if err = copyTree(filepath.Join(source, dir), filepath.Join(frozen, dir)); err != nil {
			return err
		}
	}
	if err = prepareCapacityProbe(frozen); err != nil {
		return err
	}
	for _, phase := range []string{"first", "reopen"} {
		fmt.Println("seed", phase)
		if _, err = launchUnity(ctx, unity, frozen, filepath.Join(root, "seed-"+phase+".log"), false); err != nil {
			return err
		}
	}
	var key workspace.CompatibilityKey
	raw, _ = json.Marshal(map[string]any{"schemaVersion": workspace.ParentSchemaVersion, "layout": "external-bee-dag-v1", "digest": strings.Repeat("e", 64), "provider": workspace.Provider, "filesystem": "NTFS", "virtualBytes": workspace.DefaultVirtualBytes, "blockBytes": workspace.DefaultBlockBytes, "sectorBytes": workspace.DefaultSectorBytes})
	if err = json.Unmarshal(raw, &key); err != nil {
		return err
	}
	if err = os.Mkdir(filepath.Join(envelopes, "seed"), 0700); err != nil {
		return err
	}
	begin, e := call(workspace.Request{Operation: workspace.OperationBeginParentBuild, WorkspaceID: "seed", ParentKey: &key, Source: &workspace.SourceSnapshot{}, ClientPID: os.Getpid()})
	if e != nil {
		return e
	}
	if err = copyTree(filepath.Join(frozen, "Library"), begin.ParentBuild.MountPath); err != nil {
		return err
	}
	parent, e := call(workspace.Request{Operation: workspace.OperationCommitParent, TransactionID: begin.ParentBuild.TransactionID})
	if e != nil {
		return e
	}
	if err = save(filepath.Join(root, "campaign.json"), map[string]any{"protocol": "broker-bee-v1", "parent": parent.Parent, "source": source, "unity": unity, "testplay": testplay}); err != nil {
		return err
	}
	type sample struct {
		id, project, child, external string
		lease                        workspace.Lease
	}
	var samples []sample
	runTests := func(s sample, round int) error {
		if e := writeCapacityProbe(s.project, 4000+round); e != nil {
			return e
		}
		for _, platform := range []string{"edit_mode", "play_mode"} {
			name := fmt.Sprintf("%s-cycle%d-%s", s.id, round, platform)
			fmt.Println("phase", name)
			p, e := runCapacityPhase(ctx, root, name, s.child, s.external, func() (string, int, int, error) {
				return capacityTests(ctx, testplay, s.project, platform, filepath.Join(root, name))
			})
			phases = append(phases, p)
			if e != nil {
				return e
			}
		}
		return nil
	}
	for _, id := range []string{"one", "two"} {
		s := sample{id: id, project: filepath.Join(root, id)}
		for _, dir := range []string{"Assets", "Packages", "ProjectSettings"} {
			if err = copyTree(filepath.Join(frozen, dir), filepath.Join(s.project, dir)); err != nil {
				return err
			}
		}
		if err = capacityConfigs(s.project, unity); err != nil {
			return err
		}
		if err = os.Mkdir(filepath.Join(envelopes, id), 0700); err != nil {
			return err
		}
		v, e := call(workspace.Request{Operation: workspace.OperationAcquire, RunID: id, WorkspaceID: id, ParentKey: &key, ClientPID: os.Getpid()})
		if e != nil {
			return e
		}
		s.lease = *v.Lease
		s.child = filepath.Join(cfg.StoreRoot, sid, "children", s.lease.LeaseID+".vhdx")
		s.external = strings.TrimSuffix(s.child, ".vhdx") + ".bee"
		cmd := exec.CommandContext(ctx, "powershell.exe", "-NoProfile", "-NonInteractive", "-Command", `$ErrorActionPreference='Stop'; New-Item -ItemType Junction -Path $env:HB_BEE_PROJECT_LIBRARY -Target $env:HB_BEE_MOUNT | Out-Null`)
		cmd.Env = append(os.Environ(), "HB_BEE_PROJECT_LIBRARY="+filepath.Join(s.project, "Library"), "HB_BEE_MOUNT="+s.lease.MountPath)
		cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
		if out, e := cmd.CombinedOutput(); e != nil {
			return fmt.Errorf("Library junction: %w: %s", e, out)
		}
		for _, mode := range []string{"first", "reopen"} {
			name := id + "-" + mode
			fmt.Println("phase", name)
			p, e := runCapacityPhase(ctx, root, name, s.child, s.external, func() (string, int, int, error) {
				_, e := launchUnity(ctx, unity, s.project, filepath.Join(root, name+".log"), false)
				return "", 0, 0, e
			})
			phases = append(phases, p)
			if e != nil {
				return e
			}
		}
		for round := 1; round <= 2; round++ {
			if err = runTests(s, round); err != nil {
				return err
			}
		}
		if _, err = call(workspace.Request{Operation: workspace.OperationRelease, LeaseID: s.lease.LeaseID, RetainChild: true}); err != nil {
			return err
		}
		samples = append(samples, s)
	}
	broker, e = workspace.NewBroker(cfg, workspace.NewNative())
	if e != nil {
		return e
	}
	for i, s := range samples {
		v, e := call(workspace.Request{Operation: workspace.OperationAttachRetained, RunID: s.id, WorkspaceID: s.id, ClientPID: os.Getpid()})
		if e != nil {
			return e
		}
		samples[i].lease = *v.Lease
		if err = runTests(samples[i], 3); err != nil {
			return err
		}
	}
	for i, s := range samples {
		if i == 1 {
			if err = runTests(s, 4); err != nil {
				return err
			}
		}
		if _, err = call(workspace.Request{Operation: workspace.OperationPrepareRetainedRemoval, RunID: s.id, WorkspaceID: s.id, TransactionID: "remove-" + s.id}); err != nil {
			return err
		}
		if _, err = call(workspace.Request{Operation: workspace.OperationCommitRetainedRemoval, RunID: s.id, TransactionID: "remove-" + s.id}); err != nil {
			return err
		}
		if err = os.Remove(filepath.Join(s.project, "Library")); err != nil {
			return err
		}
		for _, p := range []string{s.child, s.external} {
			if _, e = os.Stat(p); !os.IsNotExist(e) {
				return errors.New("owned child/cache remained")
			}
		}
	}
	if _, err = call(workspace.Request{Operation: workspace.OperationGC}); err != nil {
		return err
	}
	return nil
}
