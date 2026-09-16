//go:build !windows

package main

import (
	"fmt"
	"os"
	"os/exec"
)

func configureRecoveryProcess(_ *exec.Cmd) {}

func isRedirected(info os.FileInfo) bool { return info.Mode()&os.ModeSymlink != 0 }
func reportError(message string, _ bool) { fmt.Fprintln(os.Stderr, message) }
