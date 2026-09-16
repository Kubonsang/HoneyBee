//go:build windows

package main

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/Kubonsang/unity-workspace-storage/workspace"
)

func writeResumeRecord(t *testing.T, name string, value any) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(name), 0700); err != nil {
		t.Fatal(err)
	}
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
}

func recordResumeLease(t *testing.T, receipt installReceipt, lease workspace.LeaseJournal) {
	t.Helper()
	paths, err := workspace.NewPaths(receipt.StoreRoot, receipt.UserSID)
	if err != nil {
		t.Fatal(err)
	}
	writeResumeRecord(t, filepath.Join(paths.Leases, lease.LeaseID+".json"), lease)
	retained, err := paths.RetainedRecord(lease.RunID)
	if err != nil {
		t.Fatal(err)
	}
	writeResumeRecord(t, retained, workspace.RetainedRecord{SchemaVersion: workspace.RetainedRecordSchemaVersion, RunID: lease.RunID, LeaseID: lease.LeaseID, OwnershipToken: lease.OwnershipToken, ParentKey: lease.ParentKey, ChildPath: lease.ChildPath})
	writeResumeRecord(t, filepath.Join(lease.WorkspacePath, ".testplay-vhdx-workspace-owner.json"), workspace.WorkspaceOwner{SchemaVersion: workspace.WorkspaceOwnerSchemaVersion, Provider: workspace.Provider, LeaseID: lease.LeaseID, RunID: lease.RunID, WorkspaceID: lease.WorkspaceID, WorkspacePath: lease.WorkspacePath, MountPath: lease.MountPath, OwnershipToken: lease.OwnershipToken})
}

func TestBrokerResumeRestoresOnlyPreviouslyAttachedWorkspaces(t *testing.T) {
	r, lease := topologyLeaseFixture(t)
	recordResumeLease(t, r, lease)
	topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}
	attached := 0
	ops := brokerResumeOperations{
		imageLoaded: func(string) (bool, error) { return false, nil },
		verifyImage: func(string) (string, error) { return lease.FileIdentity.FileID, nil },
		attach: func(_ context.Context, sid string, request workspace.Request) workspace.Response {
			attached++
			if sid != r.UserSID || request.Operation != workspace.OperationAttachRetained || request.RunID != lease.RunID || request.WorkspaceID != lease.WorkspaceID || request.ClientPID != os.Getpid() {
				t.Fatal("incorrect broker ownership")
			}
			return workspace.Response{OK: true, Lease: &workspace.Lease{LeaseID: lease.LeaseID, MountPath: lease.MountPath}}
		},
	}
	if err := restoreBrokerMounts(context.Background(), topology, r, ops); err != nil {
		t.Fatal(err)
	}
	if attached != 1 {
		t.Fatal("missing mount")
	}
	topology.Mounts[0].Attached = false
	if err := restoreBrokerMounts(context.Background(), topology, r, ops); err != nil {
		t.Fatal(err)
	}
	if attached != 1 {
		t.Fatal("originally detached workspace attached")
	}
	// A reboot or partial startup changes dynamic evidence but never ownership.
	lease.ClientPID, lease.BootSessionID, lease.PhysicalPath = 9, "new-boot", "new-device"
	lease.State = "released"
	recordResumeLease(t, r, lease)
	topology.Mounts[0].Attached = true
	if err := restoreBrokerMounts(context.Background(), topology, r, ops); err != nil {
		t.Fatal(err)
	}
}

func TestBrokerResumeRefusesBeforeAttach(t *testing.T) {
	for _, scenario := range []string{"owner", "retained", "image", "extra-lease", "duplicate", "cancelled", "unexpected-attachment"} {
		t.Run(scenario, func(t *testing.T) {
			r, lease := topologyLeaseFixture(t)
			recordResumeLease(t, r, lease)
			topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}
			ctx, cancel := context.WithCancel(context.Background())
			defer cancel()
			switch scenario {
			case "unexpected-attachment":
				topology.Mounts[0].Attached = false
			case "owner":
				writeResumeRecord(t, filepath.Join(lease.WorkspacePath, ".testplay-vhdx-workspace-owner.json"), workspace.WorkspaceOwner{OwnershipToken: "foreign"})
			case "retained":
				paths, _ := workspace.NewPaths(r.StoreRoot, r.UserSID)
				name, _ := paths.RetainedRecord(lease.RunID)
				writeResumeRecord(t, name, workspace.RetainedRecord{OwnershipToken: "foreign"})
			case "extra-lease":
				paths, _ := workspace.NewPaths(r.StoreRoot, r.UserSID)
				extra := lease
				extra.LeaseID = "extra"
				writeResumeRecord(t, filepath.Join(paths.Leases, "extra.json"), extra)
			case "duplicate":
				topology.Mounts = append(topology.Mounts, topology.Mounts[0])
			case "cancelled":
				cancel()
			}
			err := restoreBrokerMounts(ctx, topology, r, brokerResumeOperations{
				imageLoaded: func(string) (bool, error) { return scenario == "unexpected-attachment", nil },
				verifyImage: func(string) (string, error) {
					if scenario == "image" {
						return "changed-file-id", nil
					}
					return lease.FileIdentity.FileID, nil
				},
				attach: func(context.Context, string, workspace.Request) workspace.Response {
					t.Fatal("attached before complete admission")
					return workspace.Response{}
				},
			})
			if err == nil {
				t.Fatal("invalid resume admitted")
			}
		})
	}
}

func TestBrokerResumeRefusesFailedOrWrongAttachment(t *testing.T) {
	r, lease := topologyLeaseFixture(t)
	recordResumeLease(t, r, lease)
	for _, response := range []workspace.Response{{}, {OK: true}, {OK: true, Lease: &workspace.Lease{LeaseID: "other", MountPath: lease.MountPath}}} {
		if err := restoreBrokerMounts(context.Background(), maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}, r, brokerResumeOperations{
			imageLoaded: func(string) (bool, error) { return false, nil },
			verifyImage: func(string) (string, error) { return lease.FileIdentity.FileID, nil },
			attach:      func(context.Context, string, workspace.Request) workspace.Response { return response },
		}); err == nil {
			t.Fatal("failed attachment accepted")
		}
	}
}

func TestBrokerResumeArgumentsCannotSelectPaths(t *testing.T) {
	tx, pin := strings.Repeat("a", 64), strings.Repeat("b", 64)
	for _, args := range [][]string{{workspace.WindowsServiceName}, {workspace.WindowsServiceName, "maintenance-resume", tx, pin}} {
		if _, _, err := brokerResumeArguments(args); err != nil {
			t.Fatal(err)
		}
	}
	for _, args := range [][]string{nil, {"other"}, {workspace.WindowsServiceName, "maintenance-resume", `C:\user\request.json`, pin}, {workspace.WindowsServiceName, "maintenance-resume", tx, pin, "extra"}} {
		if _, _, err := brokerResumeArguments(args); err == nil {
			t.Fatal("invalid arguments accepted")
		}
	}
}

func TestMaintenanceTopologyReloadBindsProtectedIdentity(t *testing.T) {
	r, lease := topologyLeaseFixture(t)
	tx, pin := strings.Repeat("a", 64), strings.Repeat("b", 64)
	topology := maintenanceTopology{1, tx, pin, []maintenanceMount{{Lease: lease, Attached: true}}}
	data, _ := json.Marshal(topology)
	storage := restoreIntentStorage{read: func(name string) ([]byte, error) {
		if name != "service-topology-"+tx+".json" {
			return nil, errors.New("wrong transaction")
		}
		return data, nil
	}}
	check := func() error { return nil }
	if _, err := loadMaintenanceTopology(tx, pin, r, storage, check); err != nil {
		t.Fatal(err)
	}
	if _, err := loadMaintenanceTopology(tx, strings.Repeat("c", 64), r, storage, check); err == nil {
		t.Fatal("wrong source admitted")
	}
	data = append(data, []byte(" {}")...)
	if _, err := loadMaintenanceTopology(tx, pin, r, storage, check); err == nil {
		t.Fatal("trailing record admitted")
	}
}

func TestBrokerMountHealthRequiresActualRestoredTopology(t *testing.T) {
	r, lease := topologyLeaseFixture(t)
	recordResumeLease(t, r, lease)
	topology := maintenanceTopology{Mounts: []maintenanceMount{{Lease: lease, Attached: true}}}
	check := func() error { return nil }
	identity := func(string) (string, error) { return lease.FileIdentity.FileID, nil }
	for _, scenario := range []string{"restored", "not-attached", "wrong-path", "extra-path", "wrong-disk"} {
		t.Run(scenario, func(t *testing.T) {
			err := verifyBrokerMounts(topology, r, check,
				func(string) (bool, error) { return scenario != "not-attached", nil }, identity,
				func(workspace.LeaseJournal) ([]string, error) {
					switch scenario {
					case "wrong-disk":
						return nil, errors.New("image/volume mismatch")
					case "wrong-path":
						return []string{filepath.Join(r.WorkspaceRoot, "other")}, nil
					case "extra-path":
						return []string{lease.MountPath, `Z:\`}, nil
					default:
						return []string{lease.MountPath}, nil
					}
				})
			if (err == nil) != (scenario == "restored") {
				t.Fatalf("unexpected health: %v", err)
			}
		})
	}
}
