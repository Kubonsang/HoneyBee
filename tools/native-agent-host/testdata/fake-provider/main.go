package main

import (
	"fmt"
	"os"
	"os/exec"
	"strconv"
	"time"
)

func main() {
	if marker := os.Getenv("HONEYBEE_FAKE_MARKER"); marker != "" {
		_ = os.WriteFile(marker, []byte("started\n"), 0600)
	}
	if os.Getenv("HONEYBEE_FAKE_CHILD") == "1" {
		if marker := os.Getenv("HONEYBEE_FAKE_CHILD_MARKER"); marker != "" {
			_ = os.WriteFile(marker, []byte(fmt.Sprintf("%d\n", os.Getpid())), 0600)
		}
		time.Sleep(readDuration("HONEYBEE_FAKE_CHILD_WAIT_MS", 30_000))
		return
	}
	if os.Getenv("HONEYBEE_FAKE_SPAWN_CHILD") == "1" {
		self, _ := os.Executable()
		command := exec.Command(self)
		command.Env = append(os.Environ(), "HONEYBEE_FAKE_CHILD=1")
		_ = command.Start()
	}
	time.Sleep(readDuration("HONEYBEE_FAKE_WAIT_MS", 250))
	if value, err := strconv.Atoi(os.Getenv("HONEYBEE_FAKE_EXIT_CODE")); err == nil && value != 0 {
		os.Exit(value)
	}
}

func readDuration(key string, fallback int) time.Duration {
	value, err := strconv.Atoi(os.Getenv(key))
	if err != nil || value < 0 {
		value = fallback
	}
	return time.Duration(value) * time.Millisecond
}
