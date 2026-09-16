//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strconv"
	"time"
	"unsafe"

	"golang.org/x/sys/windows"
)

// One UAC process serves one authenticated initiating process. Frames carry only
// the bounded service-update protocol; there is no arbitrary command execution.
// Client SQOS prevents the unelevated server impersonating the elevated token.
// See Microsoft ConnectNamedPipe / GetNamedPipeClientProcessId documentation.
func serviceUpdatePipeName(nonce string) (string, error) {
	if !migrationDigest(nonce) {
		return "", errors.New("invalid update pipe nonce")
	}
	return `\\.\pipe\HoneyBee-Service-Update-` + nonce, nil
}

func readServiceUpdateFrame(reader io.Reader) ([]byte, error) {
	var header [4]byte
	if _, err := io.ReadFull(reader, header[:]); err != nil {
		return nil, err
	}
	size := binary.LittleEndian.Uint32(header[:])
	if size == 0 || size > serviceUpdateRequestLimit {
		return nil, errors.New("invalid update frame size")
	}
	data := make([]byte, int(size))
	_, err := io.ReadFull(reader, data)
	return data, err
}

func writeServiceUpdateFrame(writer io.Writer, data []byte) error {
	if len(data) == 0 || len(data) > serviceUpdateRequestLimit {
		return errors.New("invalid update frame size")
	}
	var header [4]byte
	binary.LittleEndian.PutUint32(header[:], uint32(len(data)))
	for _, part := range [][]byte{header[:], data} {
		for len(part) > 0 {
			n, err := writer.Write(part)
			if err != nil {
				return err
			}
			if n == 0 {
				return io.ErrShortWrite
			}
			part = part[n:]
		}
	}
	return nil
}

func updatePipeIO(ctx context.Context, pipe, peer windows.Handle, buffer []byte, write bool) (uint32, error) {
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return 0, err
	}
	defer windows.CloseHandle(event)
	overlap := windows.Overlapped{HEvent: event}
	var count uint32
	if write {
		err = windows.WriteFile(pipe, buffer, &count, &overlap)
	} else {
		err = windows.ReadFile(pipe, buffer, &count, &overlap)
	}
	if err == nil {
		return count, nil
	}
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		return 0, err
	}
	return awaitUpdatePipeIO(ctx, pipe, peer, &overlap)
}

func awaitUpdatePipeIO(ctx context.Context, pipe, peer windows.Handle, overlap *windows.Overlapped) (uint32, error) {
	var count uint32
	cancel := func(cause error) (uint32, error) {
		_ = windows.CancelIoEx(pipe, overlap)
		// The buffer/OVERLAPPED must remain alive until cancellation completes.
		_ = windows.GetOverlappedResult(pipe, overlap, &count, true)
		return 0, cause
	}
	for {
		if err := ctx.Err(); err != nil {
			return cancel(err)
		}
		state, err := windows.WaitForMultipleObjects([]windows.Handle{overlap.HEvent, peer}, false, 100)
		if err != nil {
			return cancel(err)
		}
		switch state {
		case windows.WAIT_OBJECT_0:
			err = windows.GetOverlappedResult(pipe, overlap, &count, false)
			return count, err
		case windows.WAIT_OBJECT_0 + 1:
			return cancel(errors.New("update IPC peer exited"))
		case uint32(windows.WAIT_TIMEOUT):
		default:
			return cancel(errors.New("unexpected update IPC wait state"))
		}
	}
}

type serviceUpdatePipeStream struct {
	ctx        context.Context
	pipe, peer windows.Handle
}

func (s serviceUpdatePipeStream) Read(data []byte) (int, error) {
	n, err := updatePipeIO(s.ctx, s.pipe, s.peer, data, false)
	if err == nil && n == 0 {
		err = io.EOF
	}
	return int(n), err
}
func (s serviceUpdatePipeStream) Write(data []byte) (int, error) {
	n, err := updatePipeIO(s.ctx, s.pipe, s.peer, data, true)
	return int(n), err
}

func connectUpdatePipe(ctx context.Context, pipe, peer windows.Handle) error {
	event, err := windows.CreateEvent(nil, 1, 0, nil)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(event)
	overlap := windows.Overlapped{HEvent: event}
	err = windows.ConnectNamedPipe(pipe, &overlap)
	if err == nil || errors.Is(err, windows.ERROR_PIPE_CONNECTED) {
		return nil
	}
	if !errors.Is(err, windows.ERROR_IO_PENDING) {
		return err
	}
	_, err = awaitUpdatePipeIO(ctx, pipe, peer, &overlap)
	return err
}

// stdin/stdout use length-prefixed JSON. Keeping this process alive keeps the
// single elevated service session alive across stage/prepare/validate/commit.
func runServiceUpdateElevated(input io.Reader, output io.Writer) error {
	first, err := readServiceUpdateFrame(input)
	if err != nil {
		return err
	}
	if _, err = decodeServiceUpdateRequest(bytes.NewReader(first)); err != nil {
		return err
	}
	sid, err := currentUserSID()
	if err != nil {
		return err
	}
	nonce, err := newServiceTransactionID()
	if err != nil {
		return err
	}
	name, err := serviceUpdatePipeName(nonce)
	if err != nil {
		return err
	}
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	sd, err := windows.SecurityDescriptorFromString("D:P(A;;GA;;;SY)(A;;GA;;;BA)(A;;GRGW;;;" + sid + ")")
	if err != nil {
		return err
	}
	security := &windows.SecurityAttributes{Length: uint32(unsafe.Sizeof(windows.SecurityAttributes{})), SecurityDescriptor: sd}
	pipe, err := windows.CreateNamedPipe(namePtr, windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_FIRST_PIPE_INSTANCE|windows.FILE_FLAG_OVERLAPPED, windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_WAIT|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 64<<10, 64<<10, 5000, security)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pipe)
	executable, err := os.Executable()
	if err != nil {
		return err
	}
	code, err := executeRunAsExchange(executable, []string{"service-update-session", "--pipe", nonce, "--parent-pid", strconv.Itoa(os.Getpid())}, func(process windows.Handle) error {
		defer windows.DisconnectNamedPipe(pipe)
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
		defer cancel()
		connectCtx, connectCancel := context.WithTimeout(ctx, 30*time.Second)
		defer connectCancel()
		if err := connectUpdatePipe(connectCtx, pipe, process); err != nil {
			return err
		}
		pid, err := windows.GetProcessId(process)
		if err != nil {
			return err
		}
		var client uint32
		if err = windows.GetNamedPipeClientProcessId(pipe, &client); err != nil {
			return err
		}
		if client != pid {
			return errors.New("update pipe client is not the UAC process")
		}
		stream := serviceUpdatePipeStream{ctx, pipe, process}
		data := first
		for {
			if _, err = decodeServiceUpdateRequest(bytes.NewReader(data)); err != nil {
				return err
			}
			if err = writeServiceUpdateFrame(stream, data); err != nil {
				return err
			}
			response, err := readServiceUpdateFrame(stream)
			if err != nil {
				return err
			}
			if err = writeServiceUpdateFrame(output, response); err != nil {
				return err
			}
			data, err = readServiceUpdateFrame(input)
			if errors.Is(err, io.EOF) {
				return nil
			}
			if err != nil {
				return err
			}
		}
	})
	if errors.Is(err, windows.ERROR_CANCELLED) {
		return hostError{code: "workspace-storage.elevation-cancelled", message: "HoneyBee service update was cancelled", exitCode: 24}
	}
	if err != nil {
		return err
	}
	if code != 0 {
		return fmt.Errorf("elevated service update exited with code %d", code)
	}
	return nil
}

type serviceUpdateResponse struct {
	SchemaVersion int                  `json:"schemaVersion"`
	OK            bool                 `json:"ok"`
	Result        *serviceUpdateResult `json:"result,omitempty"`
	Error         string               `json:"error,omitempty"`
}

func runServiceUpdateSession(nonce string, parentPID uint32) error {
	name, err := serviceUpdatePipeName(nonce)
	if err != nil {
		return err
	}
	if parentPID == 0 {
		return errors.New("update session parent required")
	}
	parent, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, parentPID)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(parent)
	var token windows.Token
	if err = windows.OpenProcessToken(parent, windows.TOKEN_QUERY, &token); err != nil {
		return err
	}
	user, err := token.GetTokenUser()
	token.Close()
	if err != nil {
		return err
	}
	sid := user.User.Sid.String()
	namePtr, err := windows.UTF16PtrFromString(name)
	if err != nil {
		return err
	}
	pipe, err := windows.CreateFile(namePtr, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		return err
	}
	defer windows.CloseHandle(pipe)
	var server uint32
	if err = windows.GetNamedPipeServerProcessId(pipe, &server); err != nil {
		return err
	}
	if server != parentPID {
		return errors.New("update IPC server differs from initiating process")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	monitorDone := make(chan struct{})
	defer func() { cancel(); <-monitorDone }()
	go func() {
		defer close(monitorDone)
		ticker := time.NewTicker(100 * time.Millisecond)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				state, err := windows.WaitForSingleObject(parent, 0)
				if err != nil || state != uint32(windows.WAIT_TIMEOUT) {
					cancel()
					return
				}
			}
		}
	}()
	stream := serviceUpdatePipeStream{ctx, pipe, parent}
	for {
		data, err := readServiceUpdateFrame(stream)
		if errors.Is(err, windows.ERROR_BROKEN_PIPE) || errors.Is(err, windows.ERROR_PIPE_NOT_CONNECTED) || errors.Is(err, windows.ERROR_NO_DATA) || errors.Is(err, io.EOF) {
			return nil
		}
		if err != nil {
			return err
		}
		request, err := decodeServiceUpdateRequest(bytes.NewReader(data))
		response := serviceUpdateResponse{SchemaVersion: 1}
		if err == nil {
			err = authorizeServiceUpdateSession(request, sid)
		}
		if err == nil {
			result, runErr := executeServiceUpdateRequest(ctx, request)
			err = runErr
			if err == nil {
				response.OK = true
				response.Result = &result
			}
		}
		if err != nil {
			response.Error = err.Error()
		}
		encoded, err := json.Marshal(response)
		if err != nil {
			return err
		}
		if err = writeServiceUpdateFrame(stream, encoded); err != nil {
			return err
		}
	}
}

func authorizeServiceUpdateSession(request serviceUpdateRequest, sid string) error {
	if request.Operation == "repair-start" {
		programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
		if err != nil {
			return err
		}
		receipt, err := loadReceipt(filepath.Join(programData, "UnityWorkspaceStorage", "install-receipt.json"))
		if err != nil {
			return err
		}
		if receipt.UserSID != sid {
			return errors.New("service Repair belongs to another user")
		}
		return nil
	}
	if request.Operation == "stage" {
		_, err := captureServiceRecoveryOwner(request.Admission.OwnerPID, sid)
		return err
	}
	areaPath, records, closeReader, err := openMaintenanceReader()
	if err != nil {
		return err
	}
	defer closeReader()
	if request.Operation == "lookup" {
		data, err := records.read("service-recovery-" + request.TransactionSHA256 + ".json")
		if os.IsNotExist(err) {
			receipt, err := loadReceipt(filepath.Join(filepath.Dir(areaPath), "install-receipt.json"))
			if err != nil {
				return err
			}
			if receipt.UserSID != sid {
				return errors.New("service lookup belongs to another installed user")
			}
			return nil
		}
		if err != nil {
			return err
		}
		request.ContextSHA256 = evidenceHash(data)
	}
	record, err := readServiceRecoveryContext(request.TransactionSHA256, request.ContextSHA256, areaPath, records)
	if err != nil {
		return err
	}
	source, err := loadServiceSourceRecord(filepath.Dir(areaPath), record.TransactionSHA256, record.SourceEvidenceSHA256, records, func() error { return nil })
	if err != nil {
		return err
	}
	if source.InitiatingSID != sid {
		return errors.New("update session belongs to another installed user")
	}
	return nil
}
