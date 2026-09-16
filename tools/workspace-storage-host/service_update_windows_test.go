//go:build windows

package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
	"golang.org/x/sys/windows/svc/mgr"
)

func TestServiceUpdateRequestRejectsUnboundedAndMixedAuthority(t *testing.T) {
	pin := strings.Repeat("a", 64)
	good := serviceUpdateRequest{SchemaVersion: 1, Operation: "status", TransactionSHA256: pin, ContextSHA256: pin}
	data, _ := json.Marshal(good)
	if _, err := decodeServiceUpdateRequest(bytes.NewReader(data)); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"schema", "command", "path", "mixed", "missing-proof", "extra-proof", "trailing", "oversize"} {
		t.Run(kind, func(t *testing.T) {
			request := good
			switch kind {
			case "schema":
				request.SchemaVersion = 2
			case "command":
				request.Operation = "delete"
			case "path":
				request.TransactionSHA256 = `..\broker`
			case "mixed":
				request.Admission = &serviceUpdateAdmission{}
			case "missing-proof":
				request.Operation = "commit"
			case "extra-proof":
				request.DoctorSHA256 = pin
			}
			data, _ := json.Marshal(request)
			if kind == "trailing" {
				data = append(data, []byte("{}")...)
			}
			if kind == "oversize" {
				data = bytes.Repeat([]byte(" "), serviceUpdateRequestLimit+1)
			}
			if _, err := decodeServiceUpdateRequest(bytes.NewReader(data)); err == nil {
				t.Fatal("unsafe request accepted")
			}
		})
	}
}

func TestServiceUpdatePointersBindExactSignedTarget(t *testing.T) {
	pin := strings.Repeat("a", 64)
	source := serviceApplicationPointer{1, 1, "0.1.0-beta.12", pin}
	target := serviceApplicationPointer{1, 2, "0.1.0-beta.13", pin}
	var admitted admittedServiceRelease
	admitted.Release.Version = target.ActiveVersion
	admitted.Release.Recovery.LaunchManifestSHA256 = pin
	request := serviceUpdateAdmission{SchemaVersion: 1, TransactionSHA256: pin, OwnerPID: 1, ApplicationRoot: filepath.Join(t.TempDir(), "HoneyBee"), Source: nativeReleaseSource{AppVersion: source.ActiveVersion}}
	request.SourcePointer, _ = json.Marshal(source)
	request.TargetPointer, _ = json.Marshal(target)
	if err := validateServiceUpdatePointers(request, admitted); err != nil {
		t.Fatal(err)
	}
	for _, kind := range []string{"generation", "version", "launch", "unknown"} {
		r := request
		next := target
		switch kind {
		case "generation":
			next.Generation = 3
		case "version":
			next.ActiveVersion = "0.1.0-beta.14"
		case "launch":
			next.ManifestSHA256 = strings.Repeat("b", 64)
		}
		r.TargetPointer, _ = json.Marshal(next)
		if kind == "unknown" {
			r.TargetPointer = []byte(`{"schemaVersion":1,"generation":2,"activeVersion":"0.1.0-beta.13","manifestSha256":"` + pin + `","command":"run"}`)
		}
		if err := validateServiceUpdatePointers(r, admitted); err == nil {
			t.Fatal(kind, "accepted")
		}
	}
}

func TestRecoveryRegistrationRequiresRunningPinnedWorker(t *testing.T) {
	pin := strings.Repeat("a", 64)
	registration := serviceRecoveryRegistration{pin, pin, filepath.Join(t.TempDir(), "host.exe"), pin}
	fixture := func() *maintenanceSCMFixture {
		return &maintenanceSCMFixture{config: mgr.Config{BinaryPathName: registration.command(), StartType: mgr.StartAutomatic, ServiceType: windows.SERVICE_WIN32_OWN_PROCESS, ServiceStartName: "LocalSystem", ErrorControl: mgr.ErrorNormal}, status: svc.Status{State: svc.Stopped}}
	}
	f := fixture()
	verified := false
	if err := awaitRecoveryService(context.Background(), f, registration, func() error { return nil }, func(pid uint32) error {
		verified = true
		if pid != 42 {
			return errors.New("wrong PID")
		}
		return nil
	}); err != nil {
		t.Fatal(err)
	}
	if !verified || len(f.calls) != 1 || f.calls[0] != "start" {
		t.Fatal("registration mistaken for readiness")
	}
	for _, kind := range []string{"foreign-command", "start-failure", "process-change", "cancelled"} {
		f := fixture()
		ctx, cancel := context.WithCancel(context.Background())
		switch kind {
		case "foreign-command":
			f.config.BinaryPathName = "other.exe"
		case "start-failure":
			f.startErr = errors.New("start failed")
		case "cancelled":
			cancel()
		}
		err := awaitRecoveryService(ctx, f, registration, func() error { return nil }, func(uint32) error {
			if kind == "process-change" {
				f.status.ProcessId++
			}
			return nil
		})
		cancel()
		if err == nil {
			t.Fatal(kind, "accepted")
		}
	}
}

func TestServiceUpdateNativePipeRoundTripAndCancellation(t *testing.T) {
	nonce, err := newServiceTransactionID()
	if err != nil {
		t.Fatal(err)
	}
	name, _ := serviceUpdatePipeName(nonce)
	namePtr, _ := windows.UTF16PtrFromString(name)
	server, err := windows.CreateNamedPipe(namePtr, windows.PIPE_ACCESS_DUPLEX|windows.FILE_FLAG_FIRST_PIPE_INSTANCE|windows.FILE_FLAG_OVERLAPPED, windows.PIPE_TYPE_BYTE|windows.PIPE_READMODE_BYTE|windows.PIPE_REJECT_REMOTE_CLIENTS, 1, 4096, 4096, 5000, nil)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(server)
	client, err := windows.CreateFile(namePtr, windows.GENERIC_READ|windows.GENERIC_WRITE, 0, nil, windows.OPEN_EXISTING, windows.FILE_FLAG_OVERLAPPED|windows.SECURITY_SQOS_PRESENT|windows.SECURITY_IDENTIFICATION, 0)
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(client)
	peer, err := windows.OpenProcess(windows.SYNCHRONIZE|windows.PROCESS_QUERY_LIMITED_INFORMATION, false, uint32(os.Getpid()))
	if err != nil {
		t.Fatal(err)
	}
	defer windows.CloseHandle(peer)
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	if err = connectUpdatePipe(ctx, server, peer); err != nil {
		t.Fatal(err)
	}
	var clientPID, serverPID uint32
	if err = windows.GetNamedPipeClientProcessId(server, &clientPID); err != nil {
		t.Fatal(err)
	}
	if err = windows.GetNamedPipeServerProcessId(client, &serverPID); err != nil {
		t.Fatal(err)
	}
	if clientPID != uint32(os.Getpid()) || serverPID != clientPID {
		t.Fatal("pipe peer identity differs")
	}
	data := bytes.Repeat([]byte("bounded-pipe-frame"), 4096)
	written := make(chan error, 1)
	go func() { written <- writeServiceUpdateFrame(serviceUpdatePipeStream{ctx, server, peer}, data) }()
	got, err := readServiceUpdateFrame(serviceUpdatePipeStream{ctx, client, peer})
	if err != nil {
		t.Fatal(err)
	}
	if err = <-written; err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(data, got) {
		t.Fatal("partial transfer changed frame")
	}
	short, stop := context.WithCancel(ctx)
	stop()
	if _, err = updatePipeIO(short, client, peer, make([]byte, 4), false); !errors.Is(err, context.Canceled) {
		t.Fatal("pending read did not cancel", err)
	}
}

func TestServiceUpdateFrameRejectsTruncationAndOversize(t *testing.T) {
	for _, data := range [][]byte{{1, 2}, {0, 0, 0, 0}, {255, 255, 255, 127}, {4, 0, 0, 0, 1}} {
		if _, err := readServiceUpdateFrame(bytes.NewReader(data)); err == nil {
			t.Fatal("bad frame accepted")
		}
	}
	if _, err := readServiceUpdateFrame(bytes.NewReader(nil)); !errors.Is(err, io.EOF) {
		t.Fatal(err)
	}
}

func TestServiceRecoveryOwnerDetectsPIDReuseAndWrongSID(t *testing.T) {
	sid, err := currentUserSID()
	if err != nil {
		t.Fatal(err)
	}
	owner, err := captureServiceRecoveryOwner(uint32(os.Getpid()), sid)
	if err != nil {
		t.Fatal(err)
	}
	if alive, err := serviceRecoveryOwnerAlive(owner); err != nil || !alive {
		t.Fatal(alive, err)
	}
	owner.Created++
	if alive, err := serviceRecoveryOwnerAlive(owner); err != nil || alive {
		t.Fatal("reused PID accepted", alive, err)
	}
	if _, err = captureServiceRecoveryOwner(uint32(os.Getpid()), "S-1-5-18"); err == nil {
		t.Fatal("wrong original user accepted")
	}
}
