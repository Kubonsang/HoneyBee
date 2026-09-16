//go:build windows

package main

import (
	"context"
	"errors"
	"time"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows/svc"
)

// Own the service loop so Pause drains BOTH authenticated pipe connections and
// periodic Recover before acknowledging maintenance. The broker remains alive,
// retaining its volume handles until the coordinator reserves them before Stop.
type managedBrokerService struct {
	initialize func(context.Context, []string) error
	serve      func(context.Context) error
	recover    func(context.Context) error
	wake       func(context.Context)
	interval   time.Duration
}

func runManagedBrokerService(configPath string) error {
	var config workspace.ServiceConfig
	var broker *workspace.Broker
	service := &managedBrokerService{
		initialize: func(ctx context.Context, args []string) error {
			var err error
			if _, _, err = brokerResumeArguments(args); err != nil {
				return err
			}
			config, err = workspace.LoadServiceConfig(configPath)
			if err != nil {
				return err
			}
			broker, err = workspace.NewBroker(config.BrokerConfig(), workspace.NewNative())
			if err != nil {
				return err
			}
			if err = resumeInstalledBroker(ctx, args, config, broker); err != nil {
				return err
			}
			_, err = broker.Recover(ctx, 30*time.Second)
			return err
		},
		serve: func(ctx context.Context) error {
			server := &workspace.PipeServer{Name: config.PipeName, AllowedSID: config.UserSID, Broker: broker}
			return server.Serve(ctx)
		},
		recover: func(ctx context.Context) error { _, err := broker.Recover(ctx, 30*time.Second); return err },
		wake: func(ctx context.Context) {
			_, _ = (workspace.PipeClient{Name: config.PipeName}).Call(ctx, workspace.NewRequest(workspace.OperationHello, "maintenance-wake"))
		},
		interval: 5 * time.Second,
	}
	return svc.Run(workspace.WindowsServiceName, service)
}

func (s *managedBrokerService) start() (context.CancelFunc, <-chan error) {
	ctx, cancel := context.WithCancel(context.Background())
	serverDone := make(chan error, 1)
	recoveryDone := make(chan struct{})
	done := make(chan error, 1)
	go func() { serverDone <- s.serve(ctx) }()
	go func() {
		defer close(recoveryDone)
		ticker := time.NewTicker(s.interval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				if ctx.Err() != nil {
					return
				}
				_ = s.recover(ctx)
			}
		}
	}()
	go func() {
		err := <-serverDone
		cancel()
		<-recoveryDone
		done <- err
	}()
	return func() {
		cancel()
		go func() {
			wakeContext, stop := context.WithTimeout(context.Background(), 5*time.Second)
			defer stop()
			s.wake(wakeContext)
		}()
	}, done
}

func (s *managedBrokerService) Execute(args []string, requests <-chan svc.ChangeRequest, changes chan<- svc.Status) (bool, uint32) {
	if s.serve == nil || s.recover == nil || s.wake == nil || s.interval <= 0 {
		return true, 4
	}
	changes <- svc.Status{State: svc.StartPending}
	if s.initialize != nil {
		if err := s.initializePending(args, requests, changes); err != nil {
			return true, 6
		}
	}
	cancel, done := s.start()
	defer func() { cancel() }()
	state := svc.Running
	var stopTimeout <-chan time.Time
	var timer *time.Timer
	defer func() {
		if timer != nil {
			timer.Stop()
		}
	}()
	report := func() {
		accepts := svc.AcceptStop | svc.AcceptShutdown
		if state == svc.Running || state == svc.Paused {
			accepts |= svc.AcceptPauseAndContinue
		}
		changes <- svc.Status{State: state, Accepts: accepts, WaitHint: 30000}
	}
	report()
	for {
		select {
		case request, ok := <-requests:
			if !ok {
				cancel()
				return true, 5
			}
			switch request.Cmd {
			case svc.Interrogate:
				report()
			case svc.Pause:
				if state == svc.Running {
					state = svc.PausePending
					report()
					cancel()
				}
			case svc.Continue:
				if state == svc.Paused {
					state = svc.ContinuePending
					report()
					cancel, done = s.start()
					state = svc.Running
					report()
				}
			case svc.Stop, svc.Shutdown:
				if state == svc.Paused {
					return false, 0
				}
				if state != svc.StopPending {
					state = svc.StopPending
					report()
					cancel()
					timer = time.NewTimer(30 * time.Second)
					stopTimeout = timer.C
				}
			}
		case err := <-done:
			if err != nil && !errors.Is(err, context.Canceled) {
				return true, 1
			}
			switch state {
			case svc.PausePending:
				state = svc.Paused
				done = nil
				report()
			case svc.StopPending:
				return false, 0
			default:
				return true, 3
			}
		case <-stopTimeout:
			return true, 2
		}
	}
}
