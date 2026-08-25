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
		"error":         map[string]string{"code": "platform-unsupported"},
	})
	os.Exit(1)
}
