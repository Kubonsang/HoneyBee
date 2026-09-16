//go:build windows

package main

import (
	"golang.org/x/sys/windows"
	"path/filepath"
	"reflect"
	"testing"
	"unsafe"
)

func TestElevationArgumentsPreserveOriginalIdentityAndQuoting(t *testing.T) {
	root := filepath.Join(t.TempDir(), "작업 with spaces")
	sid := "S-1-5-21-1-2-3-1001"
	args, err := freshInstallArguments(root, sid, "0.0.0+test.hb12")
	if err != nil {
		t.Fatal(err)
	}
	decoded, err := windows.DecomposeCommandLine(windows.ComposeCommandLine(args))
	if err != nil || !reflect.DeepEqual(decoded, args) {
		t.Fatal("argument round-trip failed")
	}
	if args[1] != "--fresh-only" || args[5] != sid || len(args) != 8 {
		t.Fatalf("unexpected elevated contract: %v", args)
	}
	for _, arg := range args {
		if arg == "--replace" {
			t.Fatal("replacement enabled")
		}
	}
}
func TestElevationRejectsIdentityOverrideAndReplacement(t *testing.T) {
	for _, args := range [][]string{{"install-elevated", "--user-sid", "S-1-5-18"}, {"install-elevated", "--replace"}} {
		if _, err := execute(args); err == nil {
			t.Fatal("unsafe option accepted")
		}
	}
	if _, err := freshInstallArguments("relative", "S-1-5-18", "1"); err == nil {
		t.Fatal("relative path accepted")
	}
	if _, err := freshInstallArguments(filepath.Join(t.TempDir(), "work"), "invalid", "1"); err == nil {
		t.Fatal("invalid SID accepted")
	}
}
func TestShellExecuteInfoLayout(t *testing.T) {
	if unsafe.Sizeof(uintptr(0)) == 8 && unsafe.Sizeof(shellExecuteInfo{}) != 112 {
		t.Fatal("invalid x64 ShellExecuteEx structure")
	}
}
