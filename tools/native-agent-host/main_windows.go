//go:build windows

package main

import (
	"bufio"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"syscall"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

const (
	stillActive          = 259
	waitObject0          = 0
	waitTimeout          = 258
	jobDrainExitCode     = 143
	pollInterval         = 50 * time.Millisecond
	dotNetFileTimeOffset = uint64(504911232000000000)
)

type jobAccounting struct {
	TotalUserTime             int64
	TotalKernelTime           int64
	ThisPeriodTotalUserTime   int64
	ThisPeriodTotalKernelTime int64
	TotalPageFaultCount       uint32
	TotalProcesses            uint32
	ActiveProcesses           uint32
	TotalTerminatedProcesses  uint32
}

type childProcess struct {
	process windows.Handle
	thread  windows.Handle
	pid     uint32
}

func main() {
	if len(os.Args) < 2 {
		fatal("native-agent-host.invalid-arguments", errors.New("missing role"))
	}
	var err error
	switch os.Args[1] {
	case "supervise":
		err = runSupervisor(os.Args[2:])
	case "host":
		err = runHost(os.Args[2:])
	case "version":
		err = json.NewEncoder(os.Stdout).Encode(map[string]any{
			"schemaVersion": 1,
			"component":     "honeybee-native-agent-host",
		})
	default:
		err = errors.New("unknown role")
	}
	if err != nil {
		fatal("native-agent-host.failed", err)
	}
}

func fatal(code string, err error) {
	_ = writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "failed", ErrorCode: code})
	_, _ = fmt.Fprintln(os.Stderr, err)
	os.Exit(1)
}

func parseIntentArgument(args []string) (launchIntent, error) {
	if len(args) != 2 || args[0] != "--intent" || !filepath.IsAbs(args[1]) {
		return launchIntent{}, errors.New("role requires an absolute --intent path")
	}
	var intent launchIntent
	if err := readStrictJSON(args[1], &intent); err != nil {
		return launchIntent{}, err
	}
	if err := validateIntent(intent); err != nil {
		return launchIntent{}, err
	}
	self, err := os.Executable()
	if err != nil {
		return launchIntent{}, err
	}
	if !sameWindowsPath(self, intent.HostExecutablePath) {
		return launchIntent{}, errors.New("running Host does not match the pinned path")
	}
	digest, err := hashFile(self)
	if err != nil {
		return launchIntent{}, err
	}
	if digest != intent.HostExecutableDigest {
		return launchIntent{}, errors.New("running Host does not match the pinned digest")
	}
	return intent, nil
}

func sameWindowsPath(left, right string) bool {
	return strings.EqualFold(filepath.Clean(left), filepath.Clean(right))
}

func setJobKillOnClose(job windows.Handle, enabled bool) error {
	var information windows.JOBOBJECT_EXTENDED_LIMIT_INFORMATION
	if enabled {
		information.BasicLimitInformation.LimitFlags = windows.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
	}
	_, err := windows.SetInformationJobObject(
		job,
		windows.JobObjectExtendedLimitInformation,
		uintptr(unsafe.Pointer(&information)),
		uint32(unsafe.Sizeof(information)),
	)
	return err
}

func newKillOnCloseJob() (windows.Handle, error) {
	job, err := windows.CreateJobObject(nil, nil)
	if err != nil {
		return 0, err
	}
	if err := setJobKillOnClose(job, true); err != nil {
		windows.CloseHandle(job)
		return 0, err
	}
	return job, nil
}

func processIdentity(process windows.Handle) (string, error) {
	var created, exited, kernel, user windows.Filetime
	if err := windows.GetProcessTimes(process, &created, &exited, &kernel, &user); err != nil {
		return "", err
	}
	rawFileTime := uint64(created.HighDateTime)<<32 | uint64(created.LowDateTime)
	return fmt.Sprintf("win32:%d", rawFileTime+dotNetFileTimeOffset), nil
}

func buildCommandLine(executable string, args []string) (*uint16, error) {
	parts := []string{syscall.EscapeArg(executable)}
	for _, arg := range args {
		parts = append(parts, syscall.EscapeArg(arg))
	}
	return windows.UTF16PtrFromString(strings.Join(parts, " "))
}

func buildEnvironment(environment map[string]string) ([]uint16, error) {
	keys := make([]string, 0, len(environment))
	for key := range environment {
		if key == "" || strings.ContainsAny(key, "=\x00") || strings.ContainsRune(environment[key], '\x00') {
			return nil, errors.New("invalid environment entry")
		}
		keys = append(keys, key)
	}
	sort.Slice(keys, func(left, right int) bool { return strings.ToUpper(keys[left]) < strings.ToUpper(keys[right]) })
	result := make([]uint16, 0)
	for _, key := range keys {
		entry, err := windows.UTF16FromString(key + "=" + environment[key])
		if err != nil {
			return nil, err
		}
		result = append(result, entry...)
	}
	result = append(result, 0)
	if len(keys) == 0 {
		result = append(result, 0)
	}
	return result, nil
}

func createSuspended(executable string, args []string, cwd string, environment map[string]string, stdin, stdout, stderr windows.Handle, inheritHandles bool, windowFlags uint32) (*childProcess, error) {
	application, err := windows.UTF16PtrFromString(executable)
	if err != nil {
		return nil, err
	}
	commandLine, err := buildCommandLine(executable, args)
	if err != nil {
		return nil, err
	}
	var currentDirectory *uint16
	if cwd != "" {
		currentDirectory, err = windows.UTF16PtrFromString(cwd)
		if err != nil {
			return nil, err
		}
	}
	environmentBlock, err := buildEnvironment(environment)
	if err != nil {
		return nil, err
	}
	startup := windows.StartupInfo{Cb: uint32(unsafe.Sizeof(windows.StartupInfo{}))}
	if stdin != 0 || stdout != 0 || stderr != 0 {
		startup.Flags = windows.STARTF_USESTDHANDLES
		startup.StdInput = stdin
		startup.StdOutput = stdout
		startup.StdErr = stderr
	}
	var information windows.ProcessInformation
	err = windows.CreateProcess(
		application,
		commandLine,
		nil,
		nil,
		inheritHandles,
		windows.CREATE_SUSPENDED|windows.CREATE_UNICODE_ENVIRONMENT|windowFlags,
		&environmentBlock[0],
		currentDirectory,
		&startup,
		&information,
	)
	if err != nil {
		return nil, err
	}
	return &childProcess{process: information.Process, thread: information.Thread, pid: information.ProcessId}, nil
}

func closeChild(child *childProcess) {
	if child == nil {
		return
	}
	if child.thread != 0 {
		windows.CloseHandle(child.thread)
		child.thread = 0
	}
	if child.process != 0 {
		windows.CloseHandle(child.process)
		child.process = 0
	}
}

func inheritedPipe() (readHandle, writeHandle windows.Handle, err error) {
	attributes := windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), InheritHandle: 1}
	err = windows.CreatePipe(&readHandle, &writeHandle, &attributes, 0)
	return
}

func fileFromHandle(handle windows.Handle, name string) *os.File {
	return os.NewFile(uintptr(handle), name)
}

func internalEnvironment() map[string]string {
	allowed := []string{"SystemRoot", "WINDIR", "ComSpec", "TEMP", "TMP", "PATH", "PATHEXT"}
	environment := make(map[string]string, len(allowed))
	for _, key := range allowed {
		if value, ok := os.LookupEnv(key); ok {
			environment[key] = value
		}
	}
	return environment
}

func sendMessage(writer io.Writer, message wireMessage) error {
	return json.NewEncoder(writer).Encode(message)
}

type hostEventResult struct {
	event eventMessage
	err   error
}

func hostEventStream(reader io.Reader) <-chan hostEventResult {
	channel := make(chan hostEventResult, 1)
	go func() {
		defer close(channel)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), maximumMessage)
		for scanner.Scan() {
			var event eventMessage
			if err := decodeStrict(strings.NewReader(scanner.Text()), &event); err != nil {
				channel <- hostEventResult{err: err}
				return
			}
			channel <- hostEventResult{event: event}
		}
		if err := scanner.Err(); err != nil {
			channel <- hostEventResult{err: err}
			return
		}
		channel <- hostEventResult{err: io.EOF}
	}()
	return channel
}

func nextHostEvent(channel <-chan hostEventResult, parent <-chan incomingMessage, expected string, intent launchIntent, timeout time.Duration, monitorParent bool) error {
	if timeout <= 0 {
		return errors.New("Host event deadline expired")
	}
	timer := time.NewTimer(timeout)
	defer timer.Stop()
	if !monitorParent {
		select {
		case value, ok := <-channel:
			if !ok {
				return io.EOF
			}
			if value.err != nil {
				return value.err
			}
			if value.event.SchemaVersion != protocolVersion || value.event.LaunchID != intent.LaunchID || value.event.Type != expected {
				return errors.New("unexpected Host event")
			}
			return writeEvent(os.Stdout, value.event)
		case <-timer.C:
			return errors.New("Host event deadline expired")
		}
	}
	for {
		select {
		case value, ok := <-channel:
			if !ok {
				return io.EOF
			}
			if value.err != nil {
				return value.err
			}
			if value.event.SchemaVersion != protocolVersion || value.event.LaunchID != intent.LaunchID || value.event.Type != expected {
				return errors.New("unexpected Host event")
			}
			return writeEvent(os.Stdout, value.event)
		case parentValue, ok := <-parent:
			if !ok || parentValue.err != nil {
				return errors.New("Desktop disconnected before bootstrap release")
			}
			return errors.New("Desktop sent a message before the expected Host boundary")
		case <-timer.C:
			return errors.New("Host event deadline expired")
		}
	}
}

type incomingMessage struct {
	message wireMessage
	err     error
}

func messageStream(reader io.Reader) <-chan incomingMessage {
	channel := make(chan incomingMessage, 1)
	go func() {
		defer close(channel)
		scanner := bufio.NewScanner(reader)
		scanner.Buffer(make([]byte, 4096), maximumMessage)
		for scanner.Scan() {
			var message wireMessage
			if err := decodeStrict(strings.NewReader(scanner.Text()), &message); err != nil {
				channel <- incomingMessage{err: err}
				return
			}
			channel <- incomingMessage{message: message}
		}
		if err := scanner.Err(); err != nil {
			channel <- incomingMessage{err: err}
			return
		}
		channel <- incomingMessage{err: io.EOF}
	}()
	return channel
}

func nextIncoming(channel <-chan incomingMessage, timeout time.Duration) (wireMessage, error) {
	if timeout <= 0 {
		return wireMessage{}, errors.New("protocol deadline expired")
	}
	select {
	case value, ok := <-channel:
		if !ok {
			return wireMessage{}, io.EOF
		}
		return value.message, value.err
	case <-time.After(timeout):
		return wireMessage{}, errors.New("protocol deadline expired")
	}
}

func runSupervisor(args []string) error {
	intent, err := parseIntentArgument(args)
	if err != nil {
		return err
	}
	bootstrapJob, err := newKillOnCloseJob()
	if err != nil {
		return err
	}
	bootstrapOpen := true
	defer func() {
		if bootstrapOpen {
			windows.CloseHandle(bootstrapJob)
		}
	}()

	toHostRead, toHostWrite, err := inheritedPipe()
	if err != nil {
		return err
	}
	defer func() {
		if toHostRead != 0 {
			windows.CloseHandle(toHostRead)
		}
		if toHostWrite != 0 {
			windows.CloseHandle(toHostWrite)
		}
	}()
	fromHostRead, fromHostWrite, err := inheritedPipe()
	if err != nil {
		return err
	}
	defer func() {
		if fromHostRead != 0 {
			windows.CloseHandle(fromHostRead)
		}
		if fromHostWrite != 0 {
			windows.CloseHandle(fromHostWrite)
		}
	}()
	if err := windows.SetHandleInformation(toHostWrite, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return err
	}
	if err := windows.SetHandleInformation(fromHostRead, windows.HANDLE_FLAG_INHERIT, 0); err != nil {
		return err
	}
	stderr, _ := windows.GetStdHandle(windows.STD_ERROR_HANDLE)
	self, err := os.Executable()
	if err != nil {
		return err
	}
	host, err := createSuspended(self, []string{"host", "--intent", filepath.Join(intent.ReceiptDirectory, "intent.json")}, "", internalEnvironment(), toHostRead, fromHostWrite, stderr, true, windows.CREATE_NO_WINDOW)
	if err != nil {
		return err
	}
	defer closeChild(host)
	if err := windows.AssignProcessToJobObject(bootstrapJob, host.process); err != nil {
		return err
	}
	if _, err := windows.ResumeThread(host.thread); err != nil {
		return err
	}
	windows.CloseHandle(host.thread)
	host.thread = 0
	windows.CloseHandle(toHostRead)
	toHostRead = 0
	windows.CloseHandle(fromHostWrite)
	fromHostWrite = 0
	hostInput := fileFromHandle(toHostWrite, "host-input")
	toHostWrite = 0
	defer hostInput.Close()
	hostOutput := fileFromHandle(fromHostRead, "host-output")
	fromHostRead = 0
	defer hostOutput.Close()
	parentMessages := messageStream(os.Stdin)
	hostEvents := hostEventStream(hostOutput)

	if err := nextHostEvent(hostEvents, parentMessages, "host-registered", intent, time.Duration(intent.RegistrationTimeout)*time.Millisecond, true); err != nil {
		return err
	}
	activationMessage, err := nextIncoming(parentMessages, time.Duration(intent.RegistrationTimeout)*time.Millisecond)
	if err != nil {
		return err
	}
	if activationMessage.Type != "activation" || activationMessage.Activation == nil {
		return errors.New("expected activation request")
	}
	if err := validateActivation(*activationMessage.Activation, intent); err != nil {
		return err
	}
	if err := sendMessage(hostInput, activationMessage); err != nil {
		return err
	}
	if err := nextHostEvent(hostEvents, parentMessages, "process-registered", intent, time.Duration(intent.ActivationTimeout)*time.Millisecond, true); err != nil {
		return err
	}
	activate, err := nextIncoming(parentMessages, time.Duration(intent.ActivationTimeout)*time.Millisecond)
	if err != nil {
		return err
	}
	if activate.Type != "activate" {
		return errors.New("expected activation permission")
	}
	if err := sendMessage(hostInput, activate); err != nil {
		return err
	}
	if err := nextHostEvent(hostEvents, parentMessages, "provider-resumed", intent, time.Duration(intent.ActivationTimeout)*time.Millisecond, true); err != nil {
		return err
	}

	// A process cannot be detached from a Windows Job. The safe activation boundary is
	// clearing KILL_ON_JOB_CLOSE, then closing the supervisor's sole bootstrap Job handle.
	if err := setJobKillOnClose(bootstrapJob, false); err != nil {
		return err
	}
	windows.CloseHandle(bootstrapJob)
	bootstrapOpen = false
	if err := sendMessage(hostInput, wireMessage{Type: "bootstrap-released"}); err != nil {
		return err
	}
	if err := nextHostEvent(hostEvents, parentMessages, "activated", intent, time.Duration(intent.ActivationTimeout)*time.Millisecond, false); err != nil {
		return err
	}

	// After activation, the Host owns containment. The supervisor only forwards bounded
	// lifecycle metadata and may disappear with the Desktop without killing the provider.
	for value := range hostEvents {
		if value.err != nil {
			if errors.Is(value.err, io.EOF) {
				return nil
			}
			return value.err
		}
		event := value.event
		if event.SchemaVersion != protocolVersion || event.LaunchID != intent.LaunchID {
			return errors.New("unexpected Host event")
		}
		if err := writeEvent(os.Stdout, event); err != nil {
			// Desktop is gone. Host remains authoritative and continues through receipts.
			return nil
		}
	}
	return nil
}

func publishImmutableJSON(finalPath string, value any) error {
	directory := filepath.Dir(finalPath)
	if err := os.MkdirAll(directory, 0700); err != nil {
		return err
	}
	temporaryID, err := randomUUID()
	if err != nil {
		return err
	}
	temporaryPath := filepath.Join(directory, "."+temporaryID+".tmp")
	defer os.Remove(temporaryPath)
	file, err := os.OpenFile(temporaryPath, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if err != nil {
		return err
	}
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	if err := encoder.Encode(value); err != nil {
		file.Close()
		return err
	}
	if err := file.Sync(); err != nil {
		file.Close()
		return err
	}
	if err := file.Close(); err != nil {
		return err
	}
	if err := os.Link(temporaryPath, finalPath); err != nil {
		return err
	}
	_ = os.Remove(temporaryPath)
	return nil
}

func lockedExecutableDigest(filePath string) (string, *os.File, error) {
	pathPointer, err := windows.UTF16PtrFromString(filePath)
	if err != nil {
		return "", nil, err
	}
	handle, err := windows.CreateFile(
		pathPointer,
		windows.GENERIC_READ,
		windows.FILE_SHARE_READ,
		nil,
		windows.OPEN_EXISTING,
		windows.FILE_ATTRIBUTE_NORMAL,
		0,
	)
	if err != nil {
		return "", nil, err
	}
	file := os.NewFile(uintptr(handle), "provider-executable")
	digest, err := hashOpenFile(file)
	if err != nil {
		file.Close()
		return "", nil, err
	}
	return digest, file, nil
}

func hashOpenFile(file *os.File) (string, error) {
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	hasher := sha256.New()
	written, err := io.Copy(hasher, io.LimitReader(file, maximumExecutableBytes+1))
	if err != nil {
		return "", err
	}
	if written > maximumExecutableBytes {
		return "", errors.New("executable exceeds the hashing limit")
	}
	if _, err := file.Seek(0, io.SeekStart); err != nil {
		return "", err
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func runHost(args []string) error {
	intent, err := parseIntentArgument(args)
	if err != nil {
		return err
	}
	hostIdentity, err := processIdentity(windows.CurrentProcess())
	if err != nil {
		return err
	}
	hostPID := os.Getpid()
	hostReceiptPath := receiptPath(intent, "host-receipt.json")
	if err := publishImmutableJSON(hostReceiptPath, hostReceipt{
		SchemaVersion:       protocolVersion,
		LaunchID:            intent.LaunchID,
		Nonce:               intent.Nonce,
		HostPID:             hostPID,
		ProcessIdentity:     hostIdentity,
		ContainmentProtocol: "native-agent-host-v1",
		WorkspaceID:         intent.WorkspaceID,
		PublishedAt:         utcNow(),
	}); err != nil {
		return err
	}
	if err := writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "host-registered", LaunchID: intent.LaunchID, ReceiptPath: hostReceiptPath}); err != nil {
		return err
	}

	scanner := bufio.NewScanner(os.Stdin)
	scanner.Buffer(make([]byte, 4096), maximumMessage)
	activationMessage, err := scanWireMessage(scanner)
	if err != nil {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "launch-failed")
	}
	if activationMessage.Type != "activation" || activationMessage.Activation == nil {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "launch-failed")
	}
	activation := *activationMessage.Activation
	if err := validateActivation(activation, intent); err != nil {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "launch-failed")
	}
	digest, lockedExecutable, err := lockedExecutableDigest(activation.Command.Command)
	if err != nil || digest != activation.ExecutableDigest {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "launch-failed")
	}
	defer lockedExecutable.Close()

	targetJob, err := newKillOnCloseJob()
	if err != nil {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "host-failed")
	}
	targetJobOpen := true
	defer func() {
		if targetJobOpen {
			windows.CloseHandle(targetJob)
		}
	}()
	target, err := createSuspended(
		activation.Command.Command,
		activation.Command.Args,
		activation.Command.Cwd,
		activation.Command.Env,
		0,
		0,
		0,
		false,
		windows.CREATE_NEW_CONSOLE,
	)
	if err != nil {
		return publishHostOnlyExit(intent, hostPID, hostIdentity, "launch-failed")
	}
	defer closeChild(target)
	if err := windows.AssignProcessToJobObject(targetJob, target.process); err != nil {
		_ = windows.TerminateProcess(target.process, jobDrainExitCode)
		_ = waitForProcessExit(target.process, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExit(intent, hostPID, hostIdentity, target, "launch-failed", nil)
	}
	targetIdentity, err := processIdentity(target.process)
	if err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExit(intent, hostPID, hostIdentity, target, "host-failed", nil)
	}
	processReceiptPath := receiptPath(intent, "process-receipt.json")
	if err := publishImmutableJSON(processReceiptPath, processReceipt{
		SchemaVersion:            protocolVersion,
		LaunchID:                 intent.LaunchID,
		Nonce:                    intent.Nonce,
		ProviderID:               intent.ProviderID,
		TargetPID:                int(target.pid),
		ProcessIdentity:          targetIdentity,
		ExecutableDigest:         activation.ExecutableDigest,
		CreatedSuspendedAt:       utcNow(),
		ProviderSessionDirectory: activation.ProviderSessionDirectory,
	}); err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}
	if err := writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "process-registered", LaunchID: intent.LaunchID, ReceiptPath: processReceiptPath}); err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}

	activateMessage, err := scanWireMessage(scanner)
	if err != nil || activateMessage.Type != "activate" {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "launch-failed", nil)
	}
	if _, err := windows.ResumeThread(target.thread); err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}
	windows.CloseHandle(target.thread)
	target.thread = 0
	if err := writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "provider-resumed", LaunchID: intent.LaunchID}); err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}
	bootstrapReleased, err := scanWireMessage(scanner)
	if err != nil || bootstrapReleased.Type != "bootstrap-released" {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}
	activationReceiptPath := receiptPath(intent, "activation-receipt.json")
	if err := publishImmutableJSON(activationReceiptPath, activationReceipt{
		SchemaVersion:               protocolVersion,
		LaunchID:                    intent.LaunchID,
		Nonce:                       intent.Nonce,
		TargetPID:                   int(target.pid),
		ProcessIdentity:             targetIdentity,
		BootstrapKillOnCloseCleared: true,
		BootstrapJobHandleClosed:    true,
		ActivatedAt:                 utcNow(),
	}); err != nil {
		_ = windows.TerminateJobObject(targetJob, jobDrainExitCode)
		_ = waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond)
		return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, "host-failed", nil)
	}
	if err := writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "activated", LaunchID: intent.LaunchID, ReceiptPath: activationReceiptPath}); err != nil {
		// Activation is already durable. The Host remains authoritative even if the
		// supervisor/Desktop pipe disappears here.
	}

	exitCode, termination, err := waitForTarget(intent, targetJob, target.process)
	if err != nil {
		return err
	}
	if err := waitForJobEmpty(targetJob, time.Duration(intent.ShutdownTimeout)*time.Millisecond); err != nil {
		return err
	}
	windows.CloseHandle(targetJob)
	targetJobOpen = false
	return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, targetIdentity, termination, exitCode)
}

func scanWireMessage(scanner *bufio.Scanner) (wireMessage, error) {
	if !scanner.Scan() {
		if err := scanner.Err(); err != nil {
			return wireMessage{}, err
		}
		return wireMessage{}, io.EOF
	}
	var message wireMessage
	if err := decodeStrict(strings.NewReader(scanner.Text()), &message); err != nil {
		return wireMessage{}, err
	}
	return message, nil
}

func waitForTarget(intent launchIntent, job windows.Handle, process windows.Handle) (*int, string, error) {
	ticker := time.NewTicker(pollInterval)
	defer ticker.Stop()
	for range ticker.C {
		waited, err := windows.WaitForSingleObject(process, 0)
		if err != nil {
			return nil, "host-failed", err
		}
		if waited == waitObject0 {
			var code uint32
			if err := windows.GetExitCodeProcess(process, &code); err != nil {
				return nil, "host-failed", err
			}
			value := int(int32(code))
			if err := windows.TerminateJobObject(job, jobDrainExitCode); err != nil {
				return nil, "host-failed", err
			}
			return &value, "exited", nil
		}
		if waited != waitTimeout {
			return nil, "host-failed", errors.New("unexpected process wait result")
		}
		request, err := readCancelRequest(intent)
		if err != nil {
			return nil, "host-failed", err
		}
		if request == nil {
			continue
		}
		acceptedPath := receiptPath(intent, "cancel-accepted-"+request.RequestID+".json")
		if err := publishImmutableJSON(acceptedPath, cancelAccepted{
			SchemaVersion: protocolVersion,
			RequestID:     request.RequestID,
			LaunchID:      intent.LaunchID,
			Nonce:         intent.Nonce,
			AcceptedAt:    utcNow(),
		}); err != nil && !errors.Is(err, os.ErrExist) {
			return nil, "host-failed", err
		}
		if err := windows.TerminateJobObject(job, jobDrainExitCode); err != nil {
			return nil, "host-failed", err
		}
		return nil, "cancelled", nil
	}
	return nil, "host-failed", errors.New("unreachable target wait")
}

func readCancelRequest(intent launchIntent) (*cancelRequest, error) {
	var request cancelRequest
	err := readStrictJSON(receiptPath(intent, "cancel-request.json"), &request)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	if request.SchemaVersion != protocolVersion || request.LaunchID != intent.LaunchID || request.Nonce != intent.Nonce || !uuidPattern.MatchString(request.RequestID) {
		return nil, errors.New("invalid cancel request")
	}
	return &request, nil
}

func waitForJobEmpty(job windows.Handle, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		var information jobAccounting
		if err := windows.QueryInformationJobObject(
			job,
			windows.JobObjectBasicAccountingInformation,
			uintptr(unsafe.Pointer(&information)),
			uint32(unsafe.Sizeof(information)),
			nil,
		); err != nil {
			return err
		}
		if information.ActiveProcesses == 0 {
			return nil
		}
		if time.Now().After(deadline) {
			return errors.New("provider Job did not drain before the deadline")
		}
		time.Sleep(pollInterval)
	}
}

func waitForProcessExit(process windows.Handle, timeout time.Duration) error {
	deadline := time.Now().Add(timeout)
	for {
		result, err := windows.WaitForSingleObject(process, uint32(pollInterval/time.Millisecond))
		if err != nil {
			return err
		}
		if result == waitObject0 {
			return nil
		}
		if result != waitTimeout || time.Now().After(deadline) {
			return errors.New("process did not exit before the deadline")
		}
	}
}

func publishHostOnlyExit(intent launchIntent, hostPID int, hostIdentity, termination string) error {
	return publishImmutableJSON(receiptPath(intent, "exit-receipt.json"), exitReceipt{
		SchemaVersion:       protocolVersion,
		LaunchID:            intent.LaunchID,
		Nonce:               intent.Nonce,
		HostPID:             hostPID,
		HostProcessIdentity: hostIdentity,
		ExitCode:            nil,
		Termination:         termination,
		DescendantsDrained:  true,
		ExitedAt:            utcNow(),
	})
}

func publishTargetExit(intent launchIntent, hostPID int, hostIdentity string, target *childProcess, termination string, exitCode *int) error {
	identity, err := processIdentity(target.process)
	if err != nil {
		return err
	}
	return publishTargetExitWithIdentity(intent, hostPID, hostIdentity, target, identity, termination, exitCode)
}

func publishTargetExitWithIdentity(intent launchIntent, hostPID int, hostIdentity string, target *childProcess, targetIdentity, termination string, exitCode *int) error {
	targetPID := int(target.pid)
	exitPath := receiptPath(intent, "exit-receipt.json")
	if err := publishImmutableJSON(exitPath, exitReceipt{
		SchemaVersion:         protocolVersion,
		LaunchID:              intent.LaunchID,
		Nonce:                 intent.Nonce,
		HostPID:               hostPID,
		HostProcessIdentity:   hostIdentity,
		TargetPID:             &targetPID,
		TargetProcessIdentity: targetIdentity,
		ExitCode:              exitCode,
		Termination:           termination,
		DescendantsDrained:    true,
		ExitedAt:              utcNow(),
	}); err != nil {
		return err
	}
	_ = writeEvent(os.Stdout, eventMessage{SchemaVersion: 1, Type: "exited", LaunchID: intent.LaunchID, ReceiptPath: exitPath})
	return nil
}
