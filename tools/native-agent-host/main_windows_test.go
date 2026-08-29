//go:build windows

package main

import (
	"bufio"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
)

func TestProviderStartsOnlyAfterDurableRegistration(t *testing.T) {
	root := t.TempDir()
	hostPath := filepath.Join(root, "host.exe")
	providerPath := filepath.Join(root, "provider.exe")
	buildTestBinary(t, hostPath, ".")
	buildTestBinary(t, providerPath, "./testdata/fake-provider")
	hostDigest, err := hashFile(hostPath)
	if err != nil {
		t.Fatal(err)
	}
	providerDigest, err := hashFile(providerPath)
	if err != nil {
		t.Fatal(err)
	}
	receipts := filepath.Join(root, "receipts")
	if err := os.MkdirAll(receipts, 0700); err != nil {
		t.Fatal(err)
	}
	intent := launchIntent{
		SchemaVersion:        1,
		LaunchID:             testUUID(t),
		Nonce:                strings.Repeat("a", 64),
		OwnerRunID:           testUUID(t),
		WorkspaceID:          "test-workspace",
		ProviderID:           "codex",
		Priority:             "interactive",
		ReceiptDirectory:     receipts,
		HostExecutablePath:   hostPath,
		HostExecutableDigest: hostDigest,
		RegistrationTimeout:  10_000,
		ActivationTimeout:    10_000,
		ShutdownTimeout:      10_000,
		CreatedAt:            utcNow(),
	}
	writeTestJSON(t, filepath.Join(receipts, "intent.json"), intent)
	marker := filepath.Join(root, "provider.started")
	command := exec.Command(hostPath, "supervise", "--intent", filepath.Join(receipts, "intent.json"))
	stdin, err := command.StdinPipe()
	if err != nil {
		t.Fatal(err)
	}
	stdout, err := command.StdoutPipe()
	if err != nil {
		t.Fatal(err)
	}
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	readTestEvent(t, scanner, "host-registered")
	environment := environmentMap(os.Environ())
	environment["HONEYBEE_FAKE_MARKER"] = marker
	environment["HONEYBEE_FAKE_WAIT_MS"] = "100"
	writeTestMessage(t, stdin, wireMessage{Type: "activation", Activation: &activationRequest{
		SchemaVersion:    1,
		LaunchID:         intent.LaunchID,
		Nonce:            intent.Nonce,
		ProviderID:       intent.ProviderID,
		Command:          commandSpec{Command: providerPath, Env: environment},
		ExecutableDigest: providerDigest,
	}})
	readTestEvent(t, scanner, "process-registered")
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("provider ran before process receipt verification and activation")
	}
	writeTestMessage(t, stdin, wireMessage{Type: "activate"})
	readTestEvent(t, scanner, "provider-resumed")
	readTestEvent(t, scanner, "activated")
	waitForFile(t, marker)
	readTestEvent(t, scanner, "exited")
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	var receipt exitReceipt
	if err := readStrictJSON(filepath.Join(receipts, "exit-receipt.json"), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Termination != "exited" || !receipt.DescendantsDrained {
		t.Fatalf("unexpected exit receipt: %+v", receipt)
	}
}

func TestProcessIdentityMatchesPowerShellContract(t *testing.T) {
	actual, err := processIdentity(windows.CurrentProcess())
	if err != nil {
		t.Fatal(err)
	}
	script := fmt.Sprintf("$p = Get-Process -Id %d -ErrorAction Stop; [Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)", os.Getpid())
	command := exec.Command("powershell.exe", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script)
	bytes, err := command.Output()
	if err != nil {
		t.Fatal(err)
	}
	if actual != "win32:"+strings.TrimSpace(string(bytes)) {
		t.Fatalf("identity mismatch: Go=%s PowerShell=%s", actual, bytes)
	}
}

func TestCancellationDrainsProviderDescendants(t *testing.T) {
	root := t.TempDir()
	hostPath := filepath.Join(root, "host.exe")
	providerPath := filepath.Join(root, "provider.exe")
	buildTestBinary(t, hostPath, ".")
	buildTestBinary(t, providerPath, "./testdata/fake-provider")
	hostDigest, _ := hashFile(hostPath)
	providerDigest, _ := hashFile(providerPath)
	receipts := filepath.Join(root, "receipts")
	if err := os.MkdirAll(receipts, 0700); err != nil {
		t.Fatal(err)
	}
	intent := launchIntent{
		SchemaVersion:        1,
		LaunchID:             testUUID(t),
		Nonce:                strings.Repeat("b", 64),
		OwnerRunID:           testUUID(t),
		WorkspaceID:          "tree-drain-workspace",
		ProviderID:           "codex",
		Priority:             "validation",
		ReceiptDirectory:     receipts,
		HostExecutablePath:   hostPath,
		HostExecutableDigest: hostDigest,
		RegistrationTimeout:  10_000,
		ActivationTimeout:    10_000,
		ShutdownTimeout:      10_000,
		CreatedAt:            utcNow(),
	}
	writeTestJSON(t, filepath.Join(receipts, "intent.json"), intent)
	marker := filepath.Join(root, "provider.started")
	childMarker := filepath.Join(root, "child.pid")
	command := exec.Command(hostPath, "supervise", "--intent", filepath.Join(receipts, "intent.json"))
	stdin, _ := command.StdinPipe()
	stdout, _ := command.StdoutPipe()
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	readTestEvent(t, scanner, "host-registered")
	environment := environmentMap(os.Environ())
	environment["HONEYBEE_FAKE_MARKER"] = marker
	environment["HONEYBEE_FAKE_SPAWN_CHILD"] = "1"
	environment["HONEYBEE_FAKE_CHILD_MARKER"] = childMarker
	environment["HONEYBEE_FAKE_WAIT_MS"] = "30000"
	writeTestMessage(t, stdin, wireMessage{Type: "activation", Activation: &activationRequest{
		SchemaVersion:    1,
		LaunchID:         intent.LaunchID,
		Nonce:            intent.Nonce,
		ProviderID:       intent.ProviderID,
		Command:          commandSpec{Command: providerPath, Env: environment},
		ExecutableDigest: providerDigest,
	}})
	readTestEvent(t, scanner, "process-registered")
	writeTestMessage(t, stdin, wireMessage{Type: "activate"})
	readTestEvent(t, scanner, "provider-resumed")
	readTestEvent(t, scanner, "activated")
	waitForFile(t, marker)
	waitForFile(t, childMarker)
	requestID := testUUID(t)
	if err := publishImmutableJSON(filepath.Join(receipts, "cancel-request.json"), cancelRequest{
		SchemaVersion: 1,
		RequestID:     requestID,
		LaunchID:      intent.LaunchID,
		Nonce:         intent.Nonce,
		RequestedAt:   utcNow(),
	}); err != nil {
		t.Fatal(err)
	}
	readTestEvent(t, scanner, "exited")
	if err := command.Wait(); err != nil {
		t.Fatal(err)
	}
	bytes, err := os.ReadFile(childMarker)
	if err != nil {
		t.Fatal(err)
	}
	childPID, err := strconv.Atoi(strings.TrimSpace(string(bytes)))
	if err != nil {
		t.Fatal(err)
	}
	process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(childPID))
	if err == nil {
		defer windows.CloseHandle(process)
		var exitCode uint32
		if windows.GetExitCodeProcess(process, &exitCode) == nil && exitCode == stillActive {
			t.Fatal("provider descendant survived a durable cancelled exit")
		}
	}
	var receipt exitReceipt
	if err := readStrictJSON(filepath.Join(receipts, "exit-receipt.json"), &receipt); err != nil {
		t.Fatal(err)
	}
	if receipt.Termination != "cancelled" || !receipt.DescendantsDrained {
		t.Fatalf("unexpected cancellation receipt: %+v", receipt)
	}
}

func TestSupervisorDeathBeforeActivationKillsRegisteredTree(t *testing.T) {
	root := t.TempDir()
	hostPath := filepath.Join(root, "host.exe")
	providerPath := filepath.Join(root, "provider.exe")
	buildTestBinary(t, hostPath, ".")
	buildTestBinary(t, providerPath, "./testdata/fake-provider")
	hostDigest, err := hashFile(hostPath)
	if err != nil {
		t.Fatal(err)
	}
	providerDigest, err := hashFile(providerPath)
	if err != nil {
		t.Fatal(err)
	}
	receipts := filepath.Join(root, "receipts")
	if err := os.MkdirAll(receipts, 0700); err != nil {
		t.Fatal(err)
	}
	intent := launchIntent{
		SchemaVersion:        1,
		LaunchID:             testUUID(t),
		Nonce:                strings.Repeat("c", 64),
		OwnerRunID:           testUUID(t),
		WorkspaceID:          "bootstrap-crash-workspace",
		ProviderID:           "codex",
		Priority:             "validation",
		ReceiptDirectory:     receipts,
		HostExecutablePath:   hostPath,
		HostExecutableDigest: hostDigest,
		RegistrationTimeout:  10_000,
		ActivationTimeout:    10_000,
		ShutdownTimeout:      10_000,
		CreatedAt:            utcNow(),
	}
	writeTestJSON(t, filepath.Join(receipts, "intent.json"), intent)
	marker := filepath.Join(root, "provider.started")
	command := exec.Command(hostPath, "supervise", "--intent", filepath.Join(receipts, "intent.json"))
	stdin, _ := command.StdinPipe()
	stdout, _ := command.StdoutPipe()
	command.Stderr = os.Stderr
	if err := command.Start(); err != nil {
		t.Fatal(err)
	}
	scanner := bufio.NewScanner(stdout)
	readTestEvent(t, scanner, "host-registered")
	environment := environmentMap(os.Environ())
	environment["HONEYBEE_FAKE_MARKER"] = marker
	environment["HONEYBEE_FAKE_WAIT_MS"] = "30000"
	writeTestMessage(t, stdin, wireMessage{Type: "activation", Activation: &activationRequest{
		SchemaVersion:    1,
		LaunchID:         intent.LaunchID,
		Nonce:            intent.Nonce,
		ProviderID:       intent.ProviderID,
		Command:          commandSpec{Command: providerPath, Env: environment},
		ExecutableDigest: providerDigest,
	}})
	readTestEvent(t, scanner, "process-registered")
	var hostReceiptValue hostReceipt
	if err := readStrictJSON(filepath.Join(receipts, "host-receipt.json"), &hostReceiptValue); err != nil {
		t.Fatal(err)
	}
	var processReceiptValue processReceipt
	if err := readStrictJSON(filepath.Join(receipts, "process-receipt.json"), &processReceiptValue); err != nil {
		t.Fatal(err)
	}
	if err := command.Process.Kill(); err != nil {
		t.Fatal(err)
	}
	_ = command.Wait()
	waitForProcessMissing(t, hostReceiptValue.HostPID)
	waitForProcessMissing(t, processReceiptValue.TargetPID)
	if _, err := os.Stat(marker); !os.IsNotExist(err) {
		t.Fatal("suspended provider ran after bootstrap supervisor death")
	}
}

func buildTestBinary(t *testing.T, output, target string) {
	t.Helper()
	command := exec.Command("go", "build", "-buildvcs=false", "-trimpath", "-ldflags=-buildid=", "-o", output, target)
	command.Dir = "."
	command.Env = append(os.Environ(), "CGO_ENABLED=0")
	if bytes, err := command.CombinedOutput(); err != nil {
		t.Fatalf("build %s: %v\n%s", target, err, bytes)
	}
}

func testUUID(t *testing.T) string {
	t.Helper()
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		t.Fatal(err)
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value)
	return hexValue[0:8] + "-" + hexValue[8:12] + "-" + hexValue[12:16] + "-" + hexValue[16:20] + "-" + hexValue[20:]
}

func writeTestJSON(t *testing.T, filePath string, value any) {
	t.Helper()
	file, err := os.Create(filePath)
	if err != nil {
		t.Fatal(err)
	}
	if err := json.NewEncoder(file).Encode(value); err != nil {
		file.Close()
		t.Fatal(err)
	}
	if err := file.Close(); err != nil {
		t.Fatal(err)
	}
}

func writeTestMessage(t *testing.T, writer io.Writer, value wireMessage) {
	t.Helper()
	if err := json.NewEncoder(writer).Encode(value); err != nil {
		t.Fatal(err)
	}
}

func readTestEvent(t *testing.T, scanner *bufio.Scanner, expected string) eventMessage {
	t.Helper()
	type result struct {
		event eventMessage
		err   error
	}
	channel := make(chan result, 1)
	go func() {
		if !scanner.Scan() {
			channel <- result{err: scanner.Err()}
			return
		}
		var event eventMessage
		err := json.Unmarshal(scanner.Bytes(), &event)
		channel <- result{event: event, err: err}
	}()
	select {
	case value := <-channel:
		if value.err != nil || value.event.Type != expected {
			t.Fatalf("expected %s, got %+v (%v)", expected, value.event, value.err)
		}
		return value.event
	case <-time.After(15 * time.Second):
		t.Fatalf("timed out waiting for %s", expected)
		return eventMessage{}
	}
}

func waitForFile(t *testing.T, filePath string) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		if _, err := os.Stat(filePath); err == nil {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatal("timed out waiting for provider marker")
}

func waitForProcessMissing(t *testing.T, pid int) {
	t.Helper()
	deadline := time.Now().Add(5 * time.Second)
	for time.Now().Before(deadline) {
		process, err := windows.OpenProcess(windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(pid))
		if err != nil {
			return
		}
		var exitCode uint32
		err = windows.GetExitCodeProcess(process, &exitCode)
		windows.CloseHandle(process)
		if err != nil || exitCode != stillActive {
			return
		}
		time.Sleep(20 * time.Millisecond)
	}
	t.Fatalf("process %d survived bootstrap supervisor death", pid)
}

func environmentMap(entries []string) map[string]string {
	result := make(map[string]string, len(entries))
	for _, entry := range entries {
		index := strings.Index(entry, "=")
		if index > 0 {
			result[entry[:index]] = entry[index+1:]
		}
	}
	return result
}
