//go:build windows

package main

import (
	"context"
	"errors"
	"io"
	"os"
	"time"
)

const serviceUpdateRequestLimit = 24 << 20

type serviceUpdateRequest struct {
	SchemaVersion       int                     `json:"schemaVersion"`
	Operation           string                  `json:"operation"`
	Admission           *serviceUpdateAdmission `json:"admission,omitempty"`
	TransactionSHA256   string                  `json:"transactionSha256,omitempty"`
	ContextSHA256       string                  `json:"contextSha256,omitempty"`
	DesktopValidationID string                  `json:"desktopValidationId,omitempty"`
	DoctorSHA256        string                  `json:"doctorSha256,omitempty"`
	Repair              *serviceRepairRequest   `json:"repair,omitempty"`
}

type serviceUpdateResult struct {
	SchemaVersion int                          `json:"schemaVersion"`
	OK            bool                         `json:"ok"`
	State         string                       `json:"state"`
	Registration  *serviceRecoveryRegistration `json:"registration,omitempty"`
	Selection     string                       `json:"selection,omitempty"`
	Decision      string                       `json:"decision,omitempty"`
	Binding       *serviceUpdateBinding        `json:"binding,omitempty"`
}

type serviceUpdateBinding struct {
	ApplicationRoot     string `json:"applicationRoot"`
	SourcePointerSHA256 string `json:"sourcePointerSha256"`
	TargetPointerSHA256 string `json:"targetPointerSha256"`
	ManifestSHA256      string `json:"manifestSha256"`
}

func decodeServiceUpdateRequest(input io.Reader) (serviceUpdateRequest, error) {
	var request serviceUpdateRequest
	data, err := io.ReadAll(io.LimitReader(input, serviceUpdateRequestLimit+1))
	if err != nil {
		return request, err
	}
	if len(data) > serviceUpdateRequestLimit {
		return request, errors.New("service update request exceeds bound")
	}
	if err = decodeMaintenanceRecord(data, &request); err != nil {
		return request, err
	}
	if request.SchemaVersion != 1 {
		return request, errors.New("unsupported service update schema")
	}
	if request.Operation == "repair-start" {
		if request.Repair == nil || request.Admission != nil || request.TransactionSHA256 != "" || request.ContextSHA256 != "" || request.DesktopValidationID != "" || request.DoctorSHA256 != "" {
			return request, errors.New("invalid service startup repair")
		}
		return request, nil
	}
	if request.Repair != nil {
		return request, errors.New("unexpected service repair input")
	}
	if request.Operation == "stage" {
		if request.Admission == nil || request.TransactionSHA256 != "" || request.ContextSHA256 != "" || request.DesktopValidationID != "" || request.DoctorSHA256 != "" {
			return request, errors.New("invalid service admission request")
		}
		return request, nil
	}
	if request.Operation == "lookup" {
		if request.Admission != nil || !migrationDigest(request.TransactionSHA256) || request.ContextSHA256 != "" || request.DesktopValidationID != "" || request.DoctorSHA256 != "" {
			return request, errors.New("invalid service lookup")
		}
		return request, nil
	}
	if request.Admission != nil || !migrationDigest(request.TransactionSHA256) || !migrationDigest(request.ContextSHA256) {
		return request, errors.New("protected service context required")
	}
	switch request.Operation {
	case "prepare", "recover", "status", "abort":
		if request.DesktopValidationID != "" || request.DoctorSHA256 != "" {
			return request, errors.New("unexpected service validation input")
		}
	case "commit":
		if !migrationDigest(request.DesktopValidationID) || !migrationDigest(request.DoctorSHA256) {
			return request, errors.New("application validation evidence required")
		}
	default:
		return request, errors.New("unsupported service update operation")
	}
	return request, nil
}

// Internal elevated API. It accepts no destination, service name, credentials,
// delete instruction or executable command line. Results go to the parent IPC;
// LocalSystem never writes a caller-selected application/result file.
func executeServiceUpdateRequest(ctx context.Context, request serviceUpdateRequest) (serviceUpdateResult, error) {
	result := serviceUpdateResult{SchemaVersion: 1}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Minute)
	defer cancel()
	area, err := acquireServiceUpdateArea(ctx)
	if err != nil {
		return result, err
	}
	defer area.close()
	if request.Operation == "repair-start" {
		return repairInstalledServiceStartup(ctx, area, *request.Repair)
	}
	if request.Operation == "stage" {
		registration, err := stageInstalledServiceUpdate(ctx, area, *request.Admission)
		if err != nil {
			return result, err
		}
		result.OK = true
		result.State = "Prepared"
		result.Registration = &registration
		result.Binding = &serviceUpdateBinding{request.Admission.ApplicationRoot, evidenceHash(request.Admission.SourcePointer), evidenceHash(request.Admission.TargetPointer), evidenceHash(request.Admission.Manifest)}
		return result, nil
	}
	if request.Operation == "lookup" {
		data, err := area.restoreRecordStorage(area.assertHeld, 64<<10).read("service-recovery-" + request.TransactionSHA256 + ".json")
		if os.IsNotExist(err) {
			result.OK = true
			result.State = "NotFound"
			return result, nil
		}
		if err != nil {
			return result, err
		}
		request.ContextSHA256 = evidenceHash(data)
	}
	record, err := readServiceRecoveryContext(request.TransactionSHA256, request.ContextSHA256, area.Path, area.restoreRecordStorage(area.assertHeld, 64<<10))
	if err != nil {
		return result, err
	}
	if request.Operation == "lookup" {
		registration := record.registration(request.ContextSHA256)
		result.Registration = &registration
	}
	switch request.Operation {
	case "prepare":
		err = prepareInstalledServiceUpdate(ctx, area, record, request.ContextSHA256)
	case "commit":
		err = commitInstalledServiceUpdate(ctx, area, record, request.ContextSHA256, request.DesktopValidationID, request.DoctorSHA256)
	case "abort":
		err = abortInstalledServiceUpdate(area, record, request.ContextSHA256)
	case "recover":
		alive, ownerErr := serviceRecoveryOwnerAlive(record.Owner)
		if ownerErr != nil {
			return result, ownerErr
		}
		if alive {
			if err = releaseServiceUpdateOwner(area, record, request.ContextSHA256); err != nil {
				return result, err
			}
		}
		_, err = recoverInstalledService(ctx, area, record)
	case "status", "lookup":
	default:
		return result, errors.New("unsupported service update operation")
	}
	if err != nil {
		return result, err
	}
	journal, err := area.loadMigration(record.MigrationName, record.MigrationSHA256)
	if err != nil {
		return result, err
	}
	defer journal.closePrivate()
	result.State = journal.state()
	source, err := loadRecoverySource(area, record)
	if err != nil {
		return result, err
	}
	replacement, err := loadRecoveryReplacement(area, record, source.Evidence)
	if err != nil {
		return result, err
	}
	result.Binding = &serviceUpdateBinding{record.ApplicationRoot, record.SourcePointerSHA256, record.TargetPointerSHA256, replacement.TargetManifestSHA256}
	result.Decision = "undecided"
	if _, decisionErr := readServicePairCommit(area, record, request.ContextSHA256); decisionErr == nil {
		result.Decision = "commit"
	} else if !os.IsNotExist(decisionErr) {
		return result, decisionErr
	} else {
		released, releaseErr := serviceUpdateOwnerReleased(area, record, request.ContextSHA256)
		if releaseErr != nil {
			return result, releaseErr
		}
		if released {
			result.Decision = "abort"
		}
	}
	result.Selection, err = recoveryApplicationSelection(record)
	if err != nil {
		return result, err
	}
	result.OK = true
	return result, nil
}

func acquireServiceUpdateArea(ctx context.Context) (*maintenanceArea, error) {
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	for {
		if err := ctx.Err(); err != nil {
			return nil, err
		}
		area, err := openMaintenanceArea()
		if err == nil {
			return area, nil
		}
		if !recoveryLockBusy(err) {
			return nil, err
		}
		timer := time.NewTimer(100 * time.Millisecond)
		select {
		case <-ctx.Done():
			timer.Stop()
			return nil, ctx.Err()
		case <-timer.C:
		}
	}
}
