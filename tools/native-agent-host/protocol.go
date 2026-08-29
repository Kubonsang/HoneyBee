package main

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"
)

const (
	protocolVersion        = 1
	maximumMessage         = 1024 * 1024
	maximumExecutableBytes = 512 * 1024 * 1024
)

var (
	uuidPattern  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	noncePattern = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

type commandSpec struct {
	Command string            `json:"command"`
	Args    []string          `json:"args,omitempty"`
	Cwd     string            `json:"cwd,omitempty"`
	Env     map[string]string `json:"env,omitempty"`
}

type launchIntent struct {
	SchemaVersion        int    `json:"schemaVersion"`
	LaunchID             string `json:"launchId"`
	Nonce                string `json:"nonce"`
	OwnerRunID           string `json:"ownerRunId"`
	WorkspaceID          string `json:"workspaceId"`
	ProviderID           string `json:"providerId"`
	Priority             string `json:"priority"`
	ReceiptDirectory     string `json:"receiptDirectory"`
	HostExecutablePath   string `json:"hostExecutablePath"`
	HostExecutableDigest string `json:"hostExecutableDigest"`
	RegistrationTimeout  int64  `json:"registrationTimeoutMs"`
	ActivationTimeout    int64  `json:"activationTimeoutMs"`
	ShutdownTimeout      int64  `json:"shutdownTimeoutMs"`
	CreatedAt            string `json:"createdAt"`
}

type activationRequest struct {
	SchemaVersion            int         `json:"schemaVersion"`
	LaunchID                 string      `json:"launchId"`
	Nonce                    string      `json:"nonce"`
	ProviderID               string      `json:"providerId"`
	Command                  commandSpec `json:"command"`
	ExecutableDigest         string      `json:"executableDigest"`
	ProviderSessionDirectory string      `json:"providerSessionDirectory,omitempty"`
}

type wireMessage struct {
	Type       string             `json:"type"`
	Activation *activationRequest `json:"activation,omitempty"`
}

type hostReceipt struct {
	SchemaVersion       int    `json:"schemaVersion"`
	LaunchID            string `json:"launchId"`
	Nonce               string `json:"nonce"`
	HostPID             int    `json:"hostPid"`
	ProcessIdentity     string `json:"processIdentity"`
	ContainmentProtocol string `json:"containmentProtocol"`
	WorkspaceID         string `json:"workspaceId"`
	PublishedAt         string `json:"publishedAt"`
}

type processReceipt struct {
	SchemaVersion            int    `json:"schemaVersion"`
	LaunchID                 string `json:"launchId"`
	Nonce                    string `json:"nonce"`
	ProviderID               string `json:"providerId"`
	TargetPID                int    `json:"targetPid"`
	ProcessIdentity          string `json:"processIdentity"`
	ExecutableDigest         string `json:"executableDigest"`
	CreatedSuspendedAt       string `json:"createdSuspendedAt"`
	ProviderSessionDirectory string `json:"providerSessionDirectory,omitempty"`
}

type activationReceipt struct {
	SchemaVersion               int    `json:"schemaVersion"`
	LaunchID                    string `json:"launchId"`
	Nonce                       string `json:"nonce"`
	TargetPID                   int    `json:"targetPid"`
	ProcessIdentity             string `json:"processIdentity"`
	BootstrapKillOnCloseCleared bool   `json:"bootstrapKillOnCloseCleared"`
	BootstrapJobHandleClosed    bool   `json:"bootstrapJobHandleClosed"`
	ActivatedAt                 string `json:"activatedAt"`
}

type cancelRequest struct {
	SchemaVersion int    `json:"schemaVersion"`
	RequestID     string `json:"requestId"`
	LaunchID      string `json:"launchId"`
	Nonce         string `json:"nonce"`
	RequestedAt   string `json:"requestedAt"`
}

type cancelAccepted struct {
	SchemaVersion int    `json:"schemaVersion"`
	RequestID     string `json:"requestId"`
	LaunchID      string `json:"launchId"`
	Nonce         string `json:"nonce"`
	AcceptedAt    string `json:"acceptedAt"`
}

type exitReceipt struct {
	SchemaVersion         int    `json:"schemaVersion"`
	LaunchID              string `json:"launchId"`
	Nonce                 string `json:"nonce"`
	HostPID               int    `json:"hostPid"`
	HostProcessIdentity   string `json:"hostProcessIdentity"`
	TargetPID             *int   `json:"targetPid,omitempty"`
	TargetProcessIdentity string `json:"targetProcessIdentity,omitempty"`
	ExitCode              *int   `json:"exitCode"`
	Termination           string `json:"termination"`
	DescendantsDrained    bool   `json:"descendantsDrained"`
	ExitedAt              string `json:"exitedAt"`
}

type eventMessage struct {
	SchemaVersion int    `json:"schemaVersion"`
	Type          string `json:"type"`
	LaunchID      string `json:"launchId"`
	ReceiptPath   string `json:"receiptPath,omitempty"`
	ErrorCode     string `json:"errorCode,omitempty"`
}

func utcNow() string { return time.Now().UTC().Format(time.RFC3339Nano) }

func validateIntent(intent launchIntent) error {
	if intent.SchemaVersion != protocolVersion || !uuidPattern.MatchString(intent.LaunchID) || !uuidPattern.MatchString(intent.OwnerRunID) || !noncePattern.MatchString(intent.Nonce) {
		return errors.New("invalid launch identity")
	}
	if intent.WorkspaceID == "" || intent.ReceiptDirectory == "" || !filepath.IsAbs(intent.ReceiptDirectory) || !filepath.IsAbs(intent.HostExecutablePath) {
		return errors.New("invalid launch paths")
	}
	if intent.HostExecutableDigest == "" || intent.RegistrationTimeout <= 0 || intent.ActivationTimeout <= 0 || intent.ShutdownTimeout <= 0 {
		return errors.New("invalid launch limits")
	}
	return nil
}

func validateActivation(value activationRequest, intent launchIntent) error {
	if value.SchemaVersion != protocolVersion || value.LaunchID != intent.LaunchID || value.Nonce != intent.Nonce || value.ProviderID != intent.ProviderID {
		return errors.New("activation does not match launch intent")
	}
	if value.Command.Command == "" || !filepath.IsAbs(value.Command.Command) || !strings.HasPrefix(value.ExecutableDigest, "sha256:") {
		return errors.New("invalid provider executable")
	}
	if value.Command.Cwd != "" && !filepath.IsAbs(value.Command.Cwd) {
		return errors.New("provider cwd must be absolute")
	}
	return nil
}

func decodeStrict[T any](reader io.Reader, target *T) error {
	limited := io.LimitReader(reader, maximumMessage+1)
	decoder := json.NewDecoder(limited)
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(target); err != nil {
		return err
	}
	var extra any
	if err := decoder.Decode(&extra); err != io.EOF {
		if err == nil {
			return errors.New("multiple JSON values are not allowed")
		}
		return err
	}
	return nil
}

func readStrictJSON[T any](filePath string, target *T) error {
	file, err := os.Open(filePath)
	if err != nil {
		return err
	}
	defer file.Close()
	return decodeStrict(file, target)
}

func hashFile(filePath string) (string, error) {
	file, err := os.Open(filePath)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hasher := sha256.New()
	written, err := io.Copy(hasher, io.LimitReader(file, maximumExecutableBytes+1))
	if err != nil {
		return "", err
	}
	if written > maximumExecutableBytes {
		return "", errors.New("executable exceeds the hashing limit")
	}
	return "sha256:" + hex.EncodeToString(hasher.Sum(nil)), nil
}

func randomUUID() (string, error) {
	value := make([]byte, 16)
	if _, err := rand.Read(value); err != nil {
		return "", err
	}
	value[6] = (value[6] & 0x0f) | 0x40
	value[8] = (value[8] & 0x3f) | 0x80
	hexValue := hex.EncodeToString(value)
	return fmt.Sprintf("%s-%s-%s-%s-%s", hexValue[0:8], hexValue[8:12], hexValue[12:16], hexValue[16:20], hexValue[20:32]), nil
}

func writeEvent(writer io.Writer, event eventMessage) error {
	return json.NewEncoder(writer).Encode(event)
}

func receiptPath(intent launchIntent, name string) string {
	return filepath.Join(intent.ReceiptDirectory, name)
}
