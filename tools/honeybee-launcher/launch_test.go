package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// A real child process exercises Windows argv/stdin/stdout/exit handling without
// executing HoneyBee's service or touching a user's registry.
func init() {
	if os.Getenv("HONEYBEE_LAUNCHER_TEST_CHILD") != "1" {
		return
	}
	input, _ := io.ReadAll(os.Stdin)
	cwd, _ := os.Getwd()
	_ = json.NewEncoder(os.Stdout).Encode(map[string]any{"arguments": os.Args[1:], "input": string(input), "cwd": cwd})
	_, _ = os.Stderr.WriteString("child-stderr")
	os.Exit(17)
}

func digest(data []byte) string {
	value := sha256.Sum256(data)
	return hex.EncodeToString(value[:])
}

func write(t *testing.T, target string, data []byte) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(target, data, 0700); err != nil {
		t.Fatal(err)
	}
}

func addVersion(t *testing.T, root, version string, runtime []byte) activation {
	t.Helper()
	versionRoot := filepath.Join(root, "versions", version)
	desktop := []byte("desktop " + version)
	cli := []byte("cli " + version)
	write(t, filepath.Join(versionRoot, "desktop", "HoneyBee.exe"), desktop)
	write(t, filepath.Join(versionRoot, "runtime", "node.exe"), runtime)
	write(t, filepath.Join(versionRoot, "cli", "dist", "cli.js"), cli)
	manifest, _ := json.Marshal(launchManifest{1, version, digest(desktop), digest(runtime), digest(cli), ""})
	write(t, filepath.Join(versionRoot, "launch.json"), manifest)
	return activation{1, 1, version, digest(manifest)}
}

func activate(t *testing.T, root string, current activation) {
	t.Helper()
	data, _ := json.Marshal(current)
	write(t, filepath.Join(root, "current.json"), data)
}

func TestStableEntriesSelectOneVersionAndPreserveArguments(t *testing.T) {
	root := filepath.Join(t.TempDir(), "HoneyBee 한글 space")
	old := addVersion(t, root, "0.1.0-beta.11", []byte("old-node"))
	next := addVersion(t, root, "0.1.0-beta.12", []byte("new-node"))
	activate(t, root, old)
	arguments := []string{"workspace", "path", "한글 workspace", `quote"inside`, `C:\path with spaces\`, "&", ""}
	cli, err := resolveLaunch(filepath.Join(root, "bin", "honeybee.exe"), arguments)
	if err != nil {
		t.Fatal(err)
	}
	if !cli.CLI || cli.Executable != filepath.Join(root, "versions", old.ActiveVersion, "runtime", "node.exe") {
		t.Fatalf("wrong CLI: %+v", cli)
	}
	encoded, _ := json.Marshal(cli.Arguments[1:])
	wanted, _ := json.Marshal(arguments)
	if !bytes.Equal(encoded, wanted) {
		t.Fatalf("arguments changed: %s", encoded)
	}
	activate(t, root, next)
	desktop, err := resolveLaunch(filepath.Join(root, "HoneyBeeLauncher.exe"), arguments)
	if err != nil {
		t.Fatal(err)
	}
	if desktop.CLI || desktop.Executable != filepath.Join(root, "versions", next.ActiveVersion, "desktop", "HoneyBee.exe") {
		t.Fatalf("wrong desktop: %+v", desktop)
	}
	if !strings.Contains(cli.Executable, old.ActiveVersion) {
		t.Fatal("already resolved operation followed current.json")
	}
	if _, err := os.Stat(cli.Executable); err != nil {
		t.Fatal("old version was removed", err)
	}
}

func TestInvalidActivationFailsWithoutChangingFiles(t *testing.T) {
	for _, name := range []string{"missing", "truncated", "trailing", "unknown", "schema", "generation", "escape", "absolute", "digest", "manifest", "payload", "directory", "oversize"} {
		t.Run(name, func(t *testing.T) {
			root := t.TempDir()
			current := addVersion(t, root, "0.1.0-beta.11", []byte("node"))
			activate(t, root, current)
			pointer := filepath.Join(root, "current.json")
			switch name {
			case "missing":
				_ = os.Remove(pointer)
			case "truncated":
				write(t, pointer, []byte(`{"schemaVersion":`))
			case "trailing":
				data, _ := os.ReadFile(pointer)
				write(t, pointer, append(data, []byte(` {}`)...))
			case "unknown":
				write(t, pointer, []byte(`{"unexpected":true}`))
			case "schema":
				current.SchemaVersion = 2
				activate(t, root, current)
			case "generation":
				current.Generation = 0
				activate(t, root, current)
			case "escape":
				current.ActiveVersion = "../outside"
				activate(t, root, current)
			case "absolute":
				current.ActiveVersion = `C:\outside`
				activate(t, root, current)
			case "digest":
				current.ManifestSHA256 = strings.Repeat("0", 64)
				activate(t, root, current)
			case "manifest":
				write(t, filepath.Join(root, "versions", current.ActiveVersion, "launch.json"), []byte(`{}`))
			case "payload":
				write(t, filepath.Join(root, "versions", current.ActiveVersion, "runtime", "node.exe"), []byte("tampered"))
			case "directory":
				target := filepath.Join(root, "versions", current.ActiveVersion, "runtime", "node.exe")
				_ = os.Remove(target)
				if err := os.Mkdir(target, 0700); err != nil {
					t.Fatal(err)
				}
			case "oversize":
				write(t, pointer, bytes.Repeat([]byte(" "), metadataLimit+1))
			}
			before, _ := os.ReadFile(pointer)
			if _, err := resolveLaunch(filepath.Join(root, "bin", "honeybee.exe"), nil); err == nil {
				t.Fatal("invalid installation was accepted")
			}
			after, _ := os.ReadFile(pointer)
			if !bytes.Equal(before, after) {
				t.Fatal("launcher changed activation")
			}
		})
	}
}

func TestLaunchManifestVersionAndSchemaMustAgree(t *testing.T) {
	for _, manifest := range []launchManifest{{2, "0.1.0", digest(nil), digest(nil), digest(nil), ""}, {1, "0.2.0", digest(nil), digest(nil), digest(nil), ""}} {
		root := t.TempDir()
		current := addVersion(t, root, "0.1.0", nil)
		data, _ := json.Marshal(manifest)
		write(t, filepath.Join(root, "versions", "0.1.0", "launch.json"), data)
		current.ManifestSHA256 = digest(data)
		activate(t, root, current)
		if _, err := resolveLaunch(filepath.Join(root, "HoneyBeeLauncher.exe"), nil); err == nil {
			t.Fatal("unsupported manifest accepted")
		}
	}
}

func TestCLIForwardsStreamsWorkingDirectoryAndExitCode(t *testing.T) {
	executable, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	runtime, err := os.ReadFile(executable)
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(t.TempDir(), "HoneyBee 한글")
	activate(t, root, addVersion(t, root, "0.1.0", runtime))
	arguments := []string{"argument with spaces", `literal"quote`, "한글", "", `trailing\`, "&echo unsafe"}
	plan, err := resolveLaunch(filepath.Join(root, "bin", "honeybee.exe"), arguments)
	if err != nil {
		t.Fatal(err)
	}
	t.Setenv("HONEYBEE_LAUNCHER_TEST_CHILD", "1")
	var stdout, stderr bytes.Buffer
	code, err := launch(plan, strings.NewReader("stdin-data"), &stdout, &stderr)
	if err != nil || code != 17 {
		t.Fatalf("exit %d: %v", code, err)
	}
	var result struct {
		Arguments []string `json:"arguments"`
		Input     string   `json:"input"`
		CWD       string   `json:"cwd"`
	}
	if err := json.Unmarshal(stdout.Bytes(), &result); err != nil {
		t.Fatal(err)
	}
	wanted, _ := json.Marshal(plan.Arguments)
	actual, _ := json.Marshal(result.Arguments)
	cwd, _ := os.Getwd()
	if !bytes.Equal(wanted, actual) || result.Input != "stdin-data" || result.CWD != cwd || stderr.String() != "child-stderr" {
		t.Fatalf("transport changed: %+v stderr=%s", result, stderr.String())
	}
}

func TestRejectUnexpectedShimLocation(t *testing.T) {
	for _, executable := range []string{"HoneyBeeLauncher.exe", filepath.Join(t.TempDir(), "honeybee.exe"), filepath.Join(t.TempDir(), "renamed.exe")} {
		if _, _, err := installationRoot(executable); err == nil {
			t.Fatalf("accepted %s", executable)
		}
	}
}

func TestBoundInstallationMetadataIsVerifiedBeforeLaunch(t *testing.T) {
	root := t.TempDir()
	current := addVersion(t, root, "0.1.0", []byte("runtime"))
	versionRoot := filepath.Join(root, "versions", "0.1.0")
	manifestBytes, _ := os.ReadFile(filepath.Join(versionRoot, "launch.json"))
	var manifest launchManifest
	if err := json.Unmarshal(manifestBytes, &manifest); err != nil {
		t.Fatal(err)
	}
	metadata := []byte(`{"schemaVersion":1}`)
	manifest.InstallationSHA256 = digest(metadata)
	manifestBytes, _ = json.Marshal(manifest)
	write(t, filepath.Join(versionRoot, "launch.json"), manifestBytes)
	current.ManifestSHA256 = digest(manifestBytes)
	activate(t, root, current)
	entry := filepath.Join(root, "bin", "honeybee.exe")
	if _, err := resolveLaunch(entry, nil); err == nil {
		t.Fatal("missing installation metadata accepted")
	}
	write(t, filepath.Join(versionRoot, "installation.json"), metadata)
	if _, err := resolveLaunch(entry, nil); err != nil {
		t.Fatal(err)
	}
	write(t, filepath.Join(versionRoot, "installation.json"), []byte("changed"))
	if _, err := resolveLaunch(entry, nil); err == nil {
		t.Fatal("altered installation metadata accepted")
	}
}
