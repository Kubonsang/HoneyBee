//go:build !windows

package main

import (
	"encoding/json"
	"os"
)

func main() {
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{
		"schemaVersion": 1,
		"ok":            false,
		"errorCode":     "native-agent-host.unsupported-platform",
	})
	os.Exit(1)
}
