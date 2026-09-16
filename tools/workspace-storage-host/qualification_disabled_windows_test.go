//go:build windows && !honeybee_qualification

package main

import "testing"

func TestProductionRejectsQualificationCommands(t *testing.T) {
	for _, command := range []string{"qualification-capabilities", "qualification-arm", "qualification-status", "qualification-interrupt", "qualification-disarm"} {
		if _, err := execute([]string{command}); err == nil {
			t.Fatalf("production accepted %s", command)
		}
	}
}
