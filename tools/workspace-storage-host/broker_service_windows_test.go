//go:build windows

package main

import (
	"context"
	"sync"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

func awaitBrokerState(t *testing.T, states <-chan svc.Status, expected svc.State) {
	t.Helper()
	select {
	case state := <-states:
		if state.State != expected {
			t.Fatalf("state %v, want %v", state.State, expected)
		}
	case <-time.After(2 * time.Second):
		t.Fatalf("waiting for %v", expected)
	}
}

func TestManagedBrokerPauseWaitsForRequestsAndBackgroundRecovery(t *testing.T) {
	requests := make(chan svc.ChangeRequest, 8)
	states := make(chan svc.Status, 16)
	finished := make(chan uint32, 1)
	pipeExit, recoveryExit := make(chan struct{}), make(chan struct{})
	recoveryStarted := make(chan struct{})
	var first, pipeOnce, recoveryOnce sync.Once
	releasePipe := func() { pipeOnce.Do(func() { close(pipeExit) }) }
	releaseRecovery := func() { recoveryOnce.Do(func() { close(recoveryExit) }) }
	t.Cleanup(func() { releasePipe(); releaseRecovery(); close(requests) })
	s := &managedBrokerService{
		serve: func(ctx context.Context) error { <-ctx.Done(); <-pipeExit; return ctx.Err() },
		recover: func(ctx context.Context) error {
			first.Do(func() { close(recoveryStarted) })
			<-recoveryExit
			return ctx.Err()
		},
		wake: func(context.Context) {}, interval: time.Millisecond,
	}
	go func() { _, code := s.Execute(nil, requests, states); finished <- code }()
	awaitBrokerState(t, states, svc.StartPending)
	awaitBrokerState(t, states, svc.Running)
	select {
	case <-recoveryStarted:
	case <-time.After(2 * time.Second):
		t.Fatal("recovery did not start")
	}
	requests <- svc.ChangeRequest{Cmd: svc.Pause}
	awaitBrokerState(t, states, svc.PausePending)
	select {
	case status := <-states:
		t.Fatalf("premature pause: %v", status)
	case <-time.After(20 * time.Millisecond):
	}
	releasePipe()
	select {
	case status := <-states:
		t.Fatalf("recovery still active: %v", status)
	case <-time.After(20 * time.Millisecond):
	}
	releaseRecovery()
	awaitBrokerState(t, states, svc.Paused)
	requests <- svc.ChangeRequest{Cmd: svc.Continue}
	awaitBrokerState(t, states, svc.ContinuePending)
	awaitBrokerState(t, states, svc.Running)
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	awaitBrokerState(t, states, svc.StopPending)
	select {
	case code := <-finished:
		if code != 0 {
			t.Fatal(code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stop did not finish")
	}
}

func TestMaintenancePauseRequiresCapabilityAndCanResume(t *testing.T) {
	s, f := maintenanceSCMTestFixture()
	if err := s.pause(context.Background()); err == nil {
		t.Fatal("legacy broker admitted")
	}
	if err := s.stop(context.Background()); err == nil {
		t.Fatal("running broker stopped before drain")
	}
	f.status.Accepts = svc.AcceptPauseAndContinue
	if err := s.pause(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.status.State != svc.Paused {
		t.Fatal("pause unacknowledged")
	}
	if err := s.resume(context.Background()); err != nil {
		t.Fatal(err)
	}
	if f.status.State != svc.Running {
		t.Fatal("source not resumed")
	}
}

func TestMigrationPauseFailureCannotReserveOrStop(t *testing.T) {
	j, h, calls := migrationFixture(t)
	h.PauseSource = func() error { return context.DeadlineExceeded }
	if err := j.run(h); err == nil {
		t.Fatal("failed pause accepted")
	}
	if hasMigrationCall(*calls, "reserve") || hasMigrationCall(*calls, "stop") || hasMigrationCall(*calls, "backup") || j.state() != "Resumed" {
		t.Fatal(j.state(), *calls)
	}
}
