//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
	"golang.org/x/sys/windows"
	"golang.org/x/sys/windows/svc"
)

// Opt-in, disposable-VM qualification of the real native reservation path.
// No stop, detach, broker RPC, replacement, or automatic-start change is made.
// Protected topology records are retained as evidence, never removed on error.
func TestLegacyRetainedReservationPinnedVM(t *testing.T) {
	if os.Getenv("HONEYBEE_LEGACY_RESERVATION_PROBE") != "HoneyBee-StorageRecovery-20261101" {
		t.Skip("explicit pinned disposable VM qualification only")
	}
	const sid = "S-1-5-21-3436670693-649990488-1728217373-1001"
	if os.Getenv("COMPUTERNAME") != "HB-RECOVERY38" || !workspace.IsElevated() {
		t.Fatal("pinned elevated test guest required")
	}
	user, err := windows.GetCurrentProcessToken().GetTokenUser()
	if err != nil || user.User.Sid.String() != sid {
		t.Fatal("pinned test account required", err)
	}
	programData, err := windows.KnownFolderPath(windows.FOLDERID_ProgramData, 0)
	if err != nil {
		t.Fatal(err)
	}
	store := filepath.Join(programData, "UnityWorkspaceStorage")
	identity, err := queryServiceIdentity()
	if err != nil {
		t.Fatal(err)
	}
	source, err := inspectServiceEvidence(filepath.Join(store, "install-receipt.json"), sid, identity)
	if err != nil || !exactLegacyHb12Source(source) {
		t.Fatal("original published hb12 required", err)
	}
	local, err := windows.KnownFolderPath(windows.FOLDERID_LocalAppData, 0)
	if err != nil || source.Receipt.WorkspaceRoot != filepath.Join(local, "HoneyBee", "Workspaces") {
		t.Fatal("pinned fixture workspace root required", err)
	}
	leases, err := readMaintenanceLeases(store, sid, func() error { return nil })
	if err != nil || len(leases) != 1 {
		t.Fatal("one known synthetic retained child required", err)
	}
	lease := leases[0]
	if lease.LeaseID != "lease-7875a0be090851a4d05439f6e3cfe467" || lease.RunID != "legacy-probe-run-two" || lease.WorkspaceID != "legacy-probe-two" || lease.FileIdentity.FileID != "0a921910:000600000000053c" || lease.State != "ready" {
		t.Fatal("unknown synthetic fixture identity")
	}
	area, err := openMaintenanceArea()
	if err != nil {
		t.Fatal(err)
	}
	defer area.close()
	transaction, err := newServiceTransactionID()
	if err != nil {
		t.Fatal(err)
	}
	bound, err := openBoundMaintenanceService(area, sid, source, transaction, func(serviceSourceRecord) error {
		return errors.New("reservation-only probe cannot arm a service stop")
	})
	if err != nil {
		t.Fatal(err)
	}
	defer bound.close()
	before, err := bound.handle.Query()
	if err != nil || before.State != svc.Running || before.ProcessId == 0 {
		t.Fatal("running original process required", err)
	}
	busy, err := os.Open(filepath.Join(lease.MountPath, "child-probe.txt"))
	if err != nil {
		t.Fatal(err)
	}
	r, busyErr := bound.reserveLegacyRetained(area, transaction)
	closeErr := busy.Close()
	if r != nil {
		_ = r.close()
		t.Fatal("busy workspace acquired an exclusive reservation")
	}
	if closeErr != nil || busyErr == nil || !strings.Contains(busyErr.Error(), "volume is in use; maintenance cancelled") {
		t.Fatal("busy refusal must occur at the native volume lock", busyErr, closeErr)
	}
	t.Log("busy file refused before any service stop")
	transaction, err = newServiceTransactionID()
	if err != nil {
		t.Fatal(err)
	}
	r, err = bound.reserveLegacyRetained(area, transaction)
	if err != nil {
		t.Fatal(err)
	}
	defer r.close()
	data, err := json.Marshal(source)
	if err != nil {
		t.Fatal(err)
	}
	record := serviceSourceRecord{1, transaction, evidenceHash(data), sid, source, bound.service.original}
	if err := area.recordServiceSource(record); err != nil {
		t.Fatal(err)
	}
	if err := area.recordLegacyColdTopology(record); err != nil {
		t.Fatal(err)
	}
	if err := area.assertLegacyReservedSnapshot(context.Background(), source, transaction, r, false); err != nil {
		t.Fatal(err)
	}
	if len(r.volumes) != 1 || r.legacySourcePID != before.ProcessId {
		t.Fatal("original child/process reservation missing")
	}
	if err := r.close(); err != nil {
		t.Fatal(err)
	}
	resumed, err := bound.resumeLegacyRunningTopology(context.Background(), area, transaction, source, false)
	if err != nil || !resumed {
		t.Fatal("unchanged running source cancellation proof failed", err)
	}
	after, err := bound.handle.Query()
	if err != nil || after.State != svc.Running || after.ProcessId != before.ProcessId {
		t.Fatal("reservation changed original service process", err)
	}
	current, err := readMaintenanceLeases(store, sid, area.assertHeld)
	if err != nil || !reflect.DeepEqual(leases, current) {
		t.Fatal("reservation changed workspace journals", err)
	}
	loaded, err := maintenanceImageLoaded(lease.ChildPath)
	if err != nil || !loaded {
		t.Fatal("reservation detached original child", err)
	}
	t.Log("idle native reservation, durable cold rollback, source/target topology proof passed; service and original retained attachment unchanged")
}
