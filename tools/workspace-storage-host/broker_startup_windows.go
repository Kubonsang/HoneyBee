//go:build windows

package main

import (
	"context"
	"errors"
	"time"

	"golang.org/x/sys/windows/svc"
)

// Connect to SCM before any store recovery or mount work. Never report Running
// or open the public pipe until initialization has completed successfully.
func (s *managedBrokerService) initializePending(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) error {
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	finished := make(chan error, 1)
	go func() { finished <- s.initialize(ctx, args) }()
	ticker := time.NewTicker(2 * time.Second)
	defer ticker.Stop()
	status := svc.Status{State: svc.StartPending, CheckPoint: 1, WaitHint: 10000}
	for {
		select {
		case err := <-finished:
			if err != nil {
				return err
			}
			return ctx.Err()
		case <-ctx.Done():
			return ctx.Err()
		case <-ticker.C:
			status.CheckPoint++
			changes <- status
		case request, ok := <-requests:
			if !ok {
				return errors.New("service control channel closed during startup")
			}
			switch request.Cmd {
			case svc.Interrogate:
				changes <- status
			case svc.Stop, svc.Shutdown:
				cancel()
				changes <- svc.Status{State: svc.StopPending, WaitHint: 30000}
				// There is no normal service loop to drain yet. Wait for native
				// initialization to observe cancellation before exiting, boundedly.
				timer := time.NewTimer(30 * time.Second)
				defer timer.Stop()
				select {
				case <-finished:
				case <-timer.C:
				}
				return context.Canceled
			}
		}
	}
}
