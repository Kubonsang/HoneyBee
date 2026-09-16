//go:build windows

package main

import (
	"context"
	"errors"
	"testing"
	"time"

	"golang.org/x/sys/windows/svc"
)

func TestBrokerStartupDoesNotServeBeforeRestoration(t *testing.T) {
	requests := make(chan svc.ChangeRequest, 4)
	states := make(chan svc.Status, 16)
	ready, served, finished := make(chan struct{}), make(chan struct{}), make(chan uint32, 1)
	s := &managedBrokerService{
		initialize: func(ctx context.Context, _ []string) error {
			select {
			case <-ready:
				return nil
			case <-ctx.Done():
				return ctx.Err()
			}
		},
		serve:   func(ctx context.Context) error { close(served); <-ctx.Done(); return ctx.Err() },
		recover: func(context.Context) error { return nil }, wake: func(context.Context) {}, interval: time.Hour,
	}
	go func() { _, code := s.Execute(nil, requests, states); finished <- code }()
	t.Cleanup(func() { close(requests) })
	awaitBrokerState(t, states, svc.StartPending)
	requests <- svc.ChangeRequest{Cmd: svc.Interrogate}
	awaitBrokerState(t, states, svc.StartPending)
	select {
	case <-served:
		t.Fatal("served before restoration")
	default:
	}
	close(ready)
	awaitBrokerState(t, states, svc.Running)
	select {
	case <-served:
	case <-time.After(2 * time.Second):
		t.Fatal("pipe not started")
	}
	requests <- svc.ChangeRequest{Cmd: svc.Stop}
	awaitBrokerState(t, states, svc.StopPending)
	select {
	case code := <-finished:
		if code != 0 {
			t.Fatal(code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("stop timed out")
	}
}

func TestBrokerStartupFailureAndCancellationNeverReportRunning(t *testing.T) {
	for _, stop := range []bool{false, true} {
		t.Run(map[bool]string{false: "failure", true: "stop"}[stop], func(t *testing.T) {
			requests := make(chan svc.ChangeRequest, 4)
			states := make(chan svc.Status, 16)
			finished := make(chan uint32, 1)
			s := &managedBrokerService{
				initialize: func(ctx context.Context, _ []string) error {
					if stop {
						<-ctx.Done()
						return ctx.Err()
					}
					return errors.New("mount restoration failed")
				},
				serve:   func(context.Context) error { t.Error("public pipe opened"); return nil },
				recover: func(context.Context) error { t.Error("periodic recovery started"); return nil }, wake: func(context.Context) {}, interval: time.Hour,
			}
			go func() { _, code := s.Execute(nil, requests, states); finished <- code }()
			awaitBrokerState(t, states, svc.StartPending)
			if stop {
				requests <- svc.ChangeRequest{Cmd: svc.Stop}
				awaitBrokerState(t, states, svc.StopPending)
			}
			select {
			case code := <-finished:
				if code == 0 {
					t.Fatal("failed startup reported success")
				}
			case <-time.After(2 * time.Second):
				t.Fatal("startup did not stop")
			}
			select {
			case state := <-states:
				t.Fatalf("unexpected status: %v", state)
			default:
			}
		})
	}
}
