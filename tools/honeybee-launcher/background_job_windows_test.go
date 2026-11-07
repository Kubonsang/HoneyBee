package main

import (
	"context"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestBackgroundUpdateFailureExitsWithoutDialog(t *testing.T) {
	// Build the real GUI bootstrapper; a unit mock would miss MessageBoxW
	// blocking the process after the update operation has already failed.
	binary := filepath.Join(t.TempDir(), "HoneyBeeLauncher.exe")
	build := exec.Command("go", "build", "-buildvcs=false", "-ldflags=-H=windowsgui", "-o", binary, ".")
	if output, err := build.CombinedOutput(); err != nil {
		t.Fatalf("build bootstrapper: %v\n%s", err, output)
	}
	for _, args := range [][]string{{"--update-job", "invalid-job", "invalid-digest"}, {"--verify-recovery-runtime"}} {
		t.Run(args[0], func(t *testing.T) {
			ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
			defer cancel()
			command := exec.CommandContext(ctx, binary, args...)
			output, err := command.CombinedOutput()
			if ctx.Err() != nil {
				t.Fatalf("background failure blocked instead of exiting: %v", ctx.Err())
			}
			if err == nil || !strings.Contains(string(output), "HoneyBee could not launch") {
				t.Fatalf("expected a nonzero exit with diagnostic stderr, got %v: %s", err, output)
			}
		})
	}
}
