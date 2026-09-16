//go:build windows

package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"syscall"
	"testing"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/storage"
	"golang.org/x/sys/windows"
)

// Reproduce handle lifetime on one newly created, bounded diagnostic disk.
// Never opens a registered workspace, a service disk, or SCM. Keep the fixture
// and transcript even on failure; there is no recursive cleanup or repair.
func TestMaintenanceQuiesceIsolatedDiagnostic(t *testing.T) {
	if os.Getenv("COMPUTERNAME") != "DESKTOP-9LT0JVV" {
		t.Skip("requires the existing QA VM")
	}
	if !windows.GetCurrentProcessToken().IsElevated() {
		t.Fatal("administrator is required for the new diagnostic VHDX only")
	}
	base := `C:\HoneyBeeQA\final-integrated-20260914\Diagnostics`
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	runMaintenanceQuiesceFixture(t, base, user.User.Sid.String(), false)
}

// The real native migration worker runs as LocalSystem, not an elevated user.
// This entry requires a separate protected fixture tree and never visits the
// installed service's store or the user-writable QA dataset as SYSTEM.
func TestMaintenanceQuiesceSystemDiagnostic(t *testing.T) {
	base := requireQuiesceSystemDirectory(t)
	t.Log("Diagnostic worker identity: LocalSystem; separate fixture-owner process")
	if err := inspectLocalPath(base); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "quiesce-process-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Process diagnostic evidence: %s", root)
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	cmd := exec.CommandContext(ctx, executable, "-test.run=^TestMaintenanceQuiesceFixtureOwner$", "-test.v", "-test.timeout=120s")
	cmd.SysProcAttr = &syscall.SysProcAttr{HideWindow: true}
	cmd.Env = append(os.Environ(), "HONEYBEE_QUIESCE_FIXTURE_OWNER="+root)
	log, err := os.OpenFile(filepath.Join(root, "owner.log"), os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0600)
	if err != nil {
		t.Fatal(err)
	}
	defer log.Close()
	cmd.Stdout, cmd.Stderr = log, log
	input, err := cmd.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	if err = cmd.Start(); err != nil {
		t.Fatal(err)
	}
	done := make(chan error, 1)
	go func() { done <- cmd.Wait() }()
	waited := false
	defer func() {
		input.Close()
		if !waited {
			<-done
		}
	}()
	var ready struct{ Image, Volume string }
	for {
		bytes, readErr := os.ReadFile(filepath.Join(root, "ready.json"))
		if readErr == nil {
			if json.Unmarshal(bytes, &ready) == nil {
				break
			}
		} else if !os.IsNotExist(readErr) {
			t.Fatal(readErr)
		}
		select {
		case err = <-done:
			waited = true
			t.Fatalf("fixture owner exited before ready: %v; retain owner.log", err)
		case <-ctx.Done():
			t.Fatal(ctx.Err())
		case <-time.After(50 * time.Millisecond):
		}
	}
	if filepath.Dir(filepath.Dir(ready.Image)) != root || filepath.Base(ready.Image) != "diagnostic.vhdx" {
		t.Fatal("unexpected fixture image")
	}
	t.Logf("Fixture owner PID=%d; coordinator PID=%d; volume=%s", cmd.Process.Pid, os.Getpid(), ready.Volume)
	v, err := openMaintenanceVolume(ready.Image, ready.Volume, func() error { return ctx.Err() })
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	bindQuiesceFixtureProof(t, v, ready.Image, func() error { return ctx.Err() })
	if err = v.lock(); err != nil {
		t.Fatal(err)
	}
	t.Log("Reserved: new fixture volume locked while owner is alive")
	input.Close()
	err = <-done
	waited = true
	if err != nil {
		t.Fatalf("fixture owner exit: %v", err)
	}
	t.Log("Fixture owner process exited; reserved handles remain in coordinator")
	if err = v.detach(); err != nil {
		t.Fatal(err)
	}
	t.Log("Separate-process quiesce completed; not integrated qualification")
}

func TestMaintenanceQuiesceFixtureOwner(t *testing.T) {
	root := os.Getenv("HONEYBEE_QUIESCE_FIXTURE_OWNER")
	if root == "" {
		t.Skip("only launched by the protected diagnostic coordinator")
	}
	base := requireQuiesceSystemDirectory(t)
	if filepath.Dir(root) != base || !strings.HasPrefix(filepath.Base(root), "quiesce-process-") {
		t.Fatal("invalid fixture owner root")
	}
	runMaintenanceQuiesceFixture(t, root, "S-1-5-21-4199076252-3622841657-4011401391-1001", true)
}

func requireQuiesceSystemDirectory(t *testing.T) string {
	if os.Getenv("COMPUTERNAME") != "DESKTOP-9LT0JVV" {
		t.Skip("requires the existing QA VM")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil {
		t.Fatal(err)
	}
	if user.User.Sid.String() != "S-1-5-18" {
		t.Fatal("requires the dedicated SYSTEM diagnostic runner")
	}
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	base := filepath.Dir(executable)
	if !strings.EqualFold(filepath.Dir(base), `C:\Program Files\HoneyBeeQuiesceDiagnostics`) {
		t.Fatal("protected diagnostic directory required")
	}
	return base
}

func runMaintenanceQuiesceFixture(t *testing.T, base, initiatingSID string, owner bool) {
	if err := inspectLocalPath(base); err != nil {
		t.Fatal(err)
	}
	root, err := os.MkdirTemp(base, "quiesce-fixture-")
	if err != nil {
		t.Fatal(err)
	}
	t.Logf("Fixture retained: %s", root)
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	disk, mount := filepath.Join(root, "diagnostic.vhdx"), filepath.Join(root, "mount")
	if err = storage.CreateDynamicWithOptions(disk, storage.CreateOptions{MaximumSize: 64 << 20, BlockSizeInBytes: 2 << 20, SectorSizeInBytes: 4096}); err != nil {
		t.Fatal(err)
	}
	// Match the broker's explicit user security descriptor, rather than the
	// provider's default descriptor used by the initial diagnostic.
	a, err := storage.Open(disk, false)
	if err != nil {
		t.Fatal(err)
	}
	defer a.CloseHandle() // No explicit detach of any image in cleanup.
	if err = a.AttachForUser(false, initiatingSID); err != nil {
		t.Fatal(err)
	}
	if _, err = a.ResolvePhysicalPath(); err != nil {
		t.Fatal(err)
	}
	t.Logf("Fixture attachment uses broker-style security for %s", initiatingSID)
	if err = os.Mkdir(mount, 0700); err != nil {
		t.Fatal(err)
	}
	if err = a.InitializeAndMount(ctx, mount); err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(mount, "sentinel.txt"), []byte("isolated HoneyBee diagnostic\n"), 0600); err != nil {
		t.Fatal(err)
	}
	t.Logf("New fixture volume: %s", a.VolumeGUIDPath())
	if owner {
		bytes, err := json.Marshal(struct{ Image, Volume string }{disk, a.VolumeGUIDPath()})
		if err != nil {
			t.Fatal(err)
		}
		if err = os.WriteFile(filepath.Join(base, "ready.json"), bytes, 0600); err != nil {
			t.Fatal(err)
		}
		if _, err = io.Copy(io.Discard, os.Stdin); err != nil {
			t.Fatal(err)
		}
		return // deferred CloseHandle and process exit model source shutdown
	}
	v, err := openMaintenanceVolume(disk, a.VolumeGUIDPath(), func() error { return ctx.Err() })
	if err != nil {
		t.Fatal(err)
	}
	defer v.close()
	bindQuiesceFixtureProof(t, v, disk, func() error { return ctx.Err() })
	if err = v.lock(); err != nil {
		t.Fatal(err)
	}
	t.Log("Reserved: new fixture volume exclusively locked")
	if err = a.CloseHandle(); err != nil {
		t.Fatal(err)
	}
	t.Log("Original attachment handle closed, simulating source process exit")
	if err = v.detach(); err != nil {
		t.Fatal(err)
	}
	t.Log("Isolated quiesce completed; this is not an integrated qualification pass")
}

func bindQuiesceFixtureProof(t *testing.T, volume *maintenanceVolume, image string, held func() error) {
	t.Helper()
	identity, err := storage.FileIdentity(image)
	if err != nil {
		t.Fatal(err)
	}
	volume.confirmDetached = func() error {
		return proveMaintenanceImageDetached(identity, held,
			func() (string, error) { return storage.FileIdentity(image) },
			func() (bool, error) { return maintenanceImageLoaded(image) })
	}
}
