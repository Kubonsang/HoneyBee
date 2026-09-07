//go:build !windows

package main

import (
	"fmt"
	"os"
)

func main() { fmt.Fprintln(os.Stdout, `{"error":"usage measurement requires Windows"}`); os.Exit(1) }
