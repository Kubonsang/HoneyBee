//go:build windows

package main

import (
	"errors"
	"fmt"
)

// Opening and complete-topology admission happen before this operation. The
// coordinator persists the original topology before taking any volume offline.
// Every handle is retained until the entire batch has finished or failed.
type maintenanceVolumeOperation interface {
	lock() error
	detach() error
	close() error
}

type maintenanceVolumeReservation struct {
	volumes       []maintenanceVolumeOperation
	assertHeld    func() error
	closed        bool
	releaseGuards func() error
}

func (r *maintenanceVolumeReservation) close() (result error) {
	if r.closed {
		return nil
	}
	r.closed = true
	for index := len(r.volumes) - 1; index >= 0; index-- {
		if r.volumes[index] != nil {
			result = errors.Join(result, r.volumes[index].close())
		}
	}
	if r.releaseGuards != nil {
		result = errors.Join(result, r.releaseGuards())
		r.releaseGuards = nil
	}
	return result
}

func reserveMaintenanceVolumes(volumes []maintenanceVolumeOperation, persistResume, assertHeld func() error) (*maintenanceVolumeReservation, error) {
	if persistResume == nil || assertHeld == nil || len(volumes) > 10000 {
		return nil, errors.New("bounded volume set and durable resume authority required")
	}
	// Ownership of admitted handles transfers to this call. Never abandon an
	// acquired lock after another volume turns out to be busy.
	r := &maintenanceVolumeReservation{volumes: volumes, assertHeld: assertHeld}
	reject := func(err error) (*maintenanceVolumeReservation, error) { return nil, errors.Join(err, r.close()) }
	if err := assertHeld(); err != nil {
		return reject(err)
	}
	for _, volume := range volumes {
		if volume == nil {
			return reject(errors.New("missing maintenance volume"))
		}
	}
	if err := persistResume(); err != nil {
		return reject(err)
	}
	for _, volume := range volumes {
		if err := assertHeld(); err != nil {
			return reject(err)
		}
		if err := volume.lock(); err != nil {
			return reject(err)
		}
	}
	return r, nil
}

// Called only after SCM confirms that the source process has exited. Reservation
// handles span that exit so it cannot silently discard our pre-stop lock proof.
func (r *maintenanceVolumeReservation) quiesce(assertStopped func() error) (result error) {
	if r.closed || assertStopped == nil {
		return errors.New("open reservation and stopped-service proof required")
	}
	defer func() { result = errors.Join(result, r.close()) }()
	if err := assertStopped(); err != nil {
		return fmt.Errorf("confirm source service stopped before quiesce: %w", err)
	}
	for _, volume := range r.volumes {
		if err := r.assertHeld(); err != nil {
			return err
		}
		if err := assertStopped(); err != nil {
			return fmt.Errorf("confirm source service stopped before volume detach: %w", err)
		}
		if err := volume.detach(); err != nil {
			return err
		}
		if err := assertStopped(); err != nil {
			return fmt.Errorf("confirm source service stopped after volume detach: %w", err)
		}
	}
	return r.assertHeld()
}
