"""PR 0 baseline runner for HoneyBee Native Agent Terminal work.

The runner observes existing Journal and Artifact boundaries. It does not implement
orchestration, invent workspace-storage compatibility keys, or run an Agent task
against the source project.
"""

from __future__ import annotations

import argparse
import ctypes
import hashlib
import json
import os
import platform
import shutil
import socket
import statistics
import subprocess
import sys
import time
import uuid
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Mapping, Sequence


REPO_ROOT = Path(__file__).resolve().parents[1]
EVIDENCE_ROOT = REPO_ROOT / "dogfood" / "evidence" / "native-launch"
STATE_ROOT = REPO_ROOT / "dogfood" / "state" / "native-launch"
PROBE = REPO_ROOT / "dogfood" / "native-benchmark-probe.mjs"
UNITY_INPUT_DIRECTORIES = ("Assets", "Packages", "ProjectSettings")
GENERATED_ROOTS = {
    ".honeybee", "build", "builds", "library", "logs", "obj", "temp", "usersettings"
}
TERMINAL_EVENTS = {
    "workflow.completed", "workflow.failed", "workflow.cancelled",
    "workflow.blocked", "workflow.escalated",
}
DEFAULT_COUNTS = {
    "warm": 20, "cold": 5, "directProcess": 20, "promptReady": 5, "primitive": 20
}
SAFE_ID = set("abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789-_.")
REPARSE_ATTRIBUTE = 0x400


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def new_session_id() -> str:
    return datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8]


def safe_id(value: str) -> str:
    if (not value or len(value) > 96 or value in {".", ".."}
            or any(character not in SAFE_ID for character in value)):
        raise ValueError("Identifier contains unsafe characters.")
    return value


def sha256_file(file_path: Path) -> str:
    digest = hashlib.sha256()
    with file_path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def atomic_json(file_path: Path, value: object) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.{uuid.uuid4()}.tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        json.dump(value, stream, ensure_ascii=False, indent=2, sort_keys=True)
        stream.write("\n")
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file_path)


def atomic_text(file_path: Path, value: str) -> None:
    file_path.parent.mkdir(parents=True, exist_ok=True)
    temporary = file_path.with_name(f".{file_path.name}.{uuid.uuid4()}.tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as stream:
        stream.write(value)
        stream.flush()
        os.fsync(stream.fileno())
    os.replace(temporary, file_path)


def read_json(file_path: Path) -> Any:
    with file_path.open("r", encoding="utf-8") as stream:
        return json.load(stream)


def is_reparse(file_path: Path) -> bool:
    metadata = file_path.lstat()
    return file_path.is_symlink() or bool(
        getattr(metadata, "st_file_attributes", 0) & REPARSE_ATTRIBUTE
    )


def _manifest_files(root: Path, included_roots: Sequence[str] | None) -> Iterable[Path]:
    roots = [root / name for name in included_roots] if included_roots else [root]
    for scan_root in roots:
        if not scan_root.is_dir() or is_reparse(scan_root):
            raise ValueError(f"Manifest root is missing or linked: {scan_root}")
        for directory, names, files in os.walk(scan_root, topdown=True, followlinks=False):
            directory_path = Path(directory)
            if is_reparse(directory_path):
                raise ValueError(f"Manifest cannot traverse a link: {directory_path}")
            names.sort(key=str.casefold)
            files.sort(key=str.casefold)
            for name in names:
                child = directory_path / name
                if is_reparse(child):
                    raise ValueError(f"Manifest cannot traverse a link: {child}")
            for name in files:
                child = directory_path / name
                if is_reparse(child) or not child.is_file():
                    raise ValueError(f"Manifest accepts regular files only: {child}")
                yield child


def tree_manifest(
    root_value: str | Path, included_roots: Sequence[str] | None = None
) -> dict[str, Any]:
    root = Path(root_value).resolve(strict=True)
    if not root.is_dir() or is_reparse(root):
        raise ValueError(f"Project root is not a real directory: {root}")
    entries: list[tuple[str, int, str]] = []
    seen: set[str] = set()
    for file_path in _manifest_files(root, included_roots):
        relative = file_path.relative_to(root).as_posix()
        folded = relative.casefold()
        if folded in seen:
            raise ValueError(f"Project has case-colliding paths: {relative}")
        seen.add(folded)
        entries.append((relative, file_path.stat().st_size, sha256_file(file_path)))
    entries.sort(key=lambda entry: entry[0].casefold())
    digest = hashlib.sha256(b"honeybee-project-tree-v1\0")
    logical_bytes = 0
    for relative, size, content_digest in entries:
        encoded = relative.encode("utf-8")
        digest.update(len(encoded).to_bytes(8, "big"))
        digest.update(encoded)
        digest.update(size.to_bytes(8, "big"))
        digest.update(bytes.fromhex(content_digest))
        logical_bytes += size
    return {
        "schemaVersion": 1, "digest": digest.hexdigest(),
        "fileCount": len(entries), "logicalBytes": logical_bytes,
    }


def _assert_child(root: Path, target: Path) -> None:
    resolved_root = root.resolve()
    resolved_target = target.resolve()
    try:
        resolved_target.relative_to(resolved_root)
    except ValueError as error:
        raise ValueError(f"Path escaped benchmark state: {target}") from error
    if resolved_target == resolved_root:
        raise ValueError("Refusing to modify the benchmark state root itself.")


def remove_owned_tree(root: Path, target: Path) -> None:
    _assert_child(root, target)
    if target.exists():
        shutil.rmtree(target)


def copy_disposable_project(
    source_value: str | Path, target: Path, owner_root: Path
) -> dict[str, Any]:
    source = Path(source_value).resolve(strict=True)
    if not source.is_dir() or is_reparse(source):
        raise ValueError("Direct CLI source must be a real project directory.")
    remove_owned_tree(owner_root, target)
    target.mkdir(parents=True)
    for directory, names, files in os.walk(source, topdown=True, followlinks=False):
        directory_path = Path(directory)
        relative = directory_path.relative_to(source)
        if is_reparse(directory_path):
            raise ValueError(f"Direct copy cannot traverse a link: {directory_path}")
        if relative == Path("."):
            names[:] = [name for name in names if name.casefold() not in GENERATED_ROOTS]
        names.sort(key=str.casefold)
        files.sort(key=str.casefold)
        destination = target / relative
        destination.mkdir(parents=True, exist_ok=True)
        for name in names:
            if is_reparse(directory_path / name):
                raise ValueError(f"Direct copy cannot traverse a link: {directory_path / name}")
        for name in files:
            child = directory_path / name
            if is_reparse(child) or not child.is_file():
                raise ValueError(f"Direct copy accepts regular files only: {child}")
            shutil.copy2(child, destination / name, follow_symlinks=False)
    return tree_manifest(target)


def strict_object(value: Any, allowed: set[str], name: str) -> dict[str, Any]:
    if not isinstance(value, dict):
        raise ValueError(f"{name} must be an object.")
    unknown = set(value) - allowed
    if unknown:
        raise ValueError(f"{name} contains unknown field: {sorted(unknown)[0]}")
    return value


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(str(Path(value).resolve(strict=True)))


def load_batch_identity(file_path: Path) -> dict[str, Any]:
    value = strict_object(
        read_json(file_path),
        {"schemaVersion", "mode", "resourceScope", "maxParallelWorks", "transaction",
         "editorPool", "bridgeProtocolVersion", "works"},
        "batch config",
    )
    if value.get("schemaVersion") not in {3, 4} or value.get("mode") != "unity-batch":
        raise ValueError("Benchmark configs must be v0.6 schema-3 or schema-4 Unity batches.")
    transaction = value.get("transaction")
    if not isinstance(transaction, dict) or not isinstance(transaction.get("sourceProjectPath"), str):
        raise ValueError("Batch config transaction sourceProjectPath is missing.")
    storage = transaction.get("workspaceStorage")
    command = storage.get("command") if isinstance(storage, dict) else None
    if not isinstance(command, dict) or not isinstance(command.get("command"), str):
        raise ValueError("Batch config workspace-storage command is missing.")
    executable = Path(command["command"]).resolve(strict=True)
    return {
        "path": str(file_path), "digest": sha256_file(file_path),
        "sourceProjectPath": str(Path(transaction["sourceProjectPath"]).resolve(strict=True)),
        "storageExecutable": str(executable), "storageDigest": sha256_file(executable),
        "parentId": storage.get("parentId") if storage.get("schemaVersion") == 2 else None,
        "storageSchemaVersion": storage.get("schemaVersion", 1),
    }


def run_git(*arguments: str) -> str:
    result = subprocess.run(
        ["git", *arguments], cwd=REPO_ROOT, capture_output=True, text=True,
        check=True, timeout=20, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return result.stdout.strip()


def defender_state() -> dict[str, Any]:
    if os.name != "nt":
        return {"available": False, "reason": "not-windows"}
    script = (
        "$s=Get-MpComputerStatus;[pscustomobject]@{"
        "AntivirusEnabled=$s.AntivirusEnabled;"
        "RealTimeProtectionEnabled=$s.RealTimeProtectionEnabled;"
        "BehaviorMonitorEnabled=$s.BehaviorMonitorEnabled;"
        "AMRunningMode=$s.AMRunningMode}|ConvertTo-Json -Compress"
    )
    try:
        result = subprocess.run(
            ["powershell", "-NoProfile", "-NonInteractive", "-Command", script],
            capture_output=True, text=True, check=True, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        return {"available": True, "status": json.loads(result.stdout)}
    except (OSError, subprocess.SubprocessError, json.JSONDecodeError) as error:
        return {"available": False, "reason": type(error).__name__}


def resolve_command(command: Sequence[str]) -> tuple[list[str], Path]:
    if not command or not all(isinstance(item, str) and item for item in command):
        raise ValueError("provider.command must be a non-empty array of strings.")
    candidate = Path(command[0])
    located = str(candidate.resolve()) if candidate.is_absolute() else shutil.which(command[0])
    if located is None:
        raise FileNotFoundError(f"Provider command was not found: {command[0]}")
    executable = Path(located).resolve(strict=True)
    return [str(executable), *command[1:]], executable


def counts_from(spec: Mapping[str, Any]) -> dict[str, int]:
    provided = strict_object(spec.get("counts", {}), set(DEFAULT_COUNTS), "counts")
    output = dict(DEFAULT_COUNTS)
    for name, value in provided.items():
        if not isinstance(value, int) or isinstance(value, bool) or value < 1 or value > 200:
            raise ValueError(f"counts.{name} must be an integer between 1 and 200.")
        output[name] = value
    return output


def session_file(identifier: str) -> Path:
    return EVIDENCE_ROOT / safe_id(identifier) / "session.json"


def save_session(session: dict[str, Any]) -> None:
    session["updatedAt"] = utc_now()
    atomic_json(Path(session["evidenceRoot"]) / "session.json", session)


def load_session(identifier: str) -> dict[str, Any]:
    value = read_json(session_file(identifier))
    if (not isinstance(value, dict) or value.get("schemaVersion") != 2
            or value.get("sessionId") != identifier):
        raise ValueError("Native benchmark session is invalid.")
    return value


@contextmanager
def session_lock(state_root_value: str | Path) -> Iterable[None]:
    state_root = Path(state_root_value).resolve(strict=True)
    lock_path = state_root / "runner.lock"
    with lock_path.open("a+b") as handle:
        if handle.seek(0, os.SEEK_END) == 0:
            handle.write(b"0")
            handle.flush()
        handle.seek(0)
        if os.name == "nt":
            import msvcrt

            try:
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            except OSError as error:
                raise RuntimeError("Another process is operating this benchmark session.") from error
            try:
                yield
            finally:
                handle.seek(0)
                msvcrt.locking(handle.fileno(), msvcrt.LK_UNLCK, 1)
        else:
            import fcntl

            try:
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
            except OSError as error:
                raise RuntimeError("Another process is operating this benchmark session.") from error
            try:
                yield
            finally:
                fcntl.flock(handle.fileno(), fcntl.LOCK_UN)


def environment_pins(
    projects: Sequence[Mapping[str, Any]], provider: Mapping[str, Any]
) -> dict[str, Any]:
    node_location = shutil.which("node")
    if node_location is None:
        raise FileNotFoundError("node was not found on PATH.")
    node = Path(node_location).resolve(strict=True)
    return {
        "gitCommit": run_git("rev-parse", "HEAD"),
        "gitTrackedDirty": bool(run_git("status", "--porcelain", "--untracked-files=no")),
        "host": socket.gethostname(), "platform": platform.platform(),
        "pythonVersion": platform.python_version(),
        "nodeExecutable": str(node), "nodeSha256": sha256_file(node),
        "providerExecutable": provider["command"][0],
        "providerSha256": sha256_file(Path(provider["command"][0]).resolve(strict=True)),
        "defender": defender_state(),
        "projects": {
            project["id"]: {
                "sourceManifestDigest": tree_manifest(
                    project["sourceProjectPath"], UNITY_INPUT_DIRECTORIES
                )["digest"],
                "configDigests": [
                    sha256_file(Path(project["warmConfig"]["path"]).resolve(strict=True)), *[
                    sha256_file(Path(config["path"]).resolve(strict=True))
                    for config in project["coldConfigs"]
                ]],
                "storageDigests": sorted({
                    sha256_file(
                        Path(project["warmConfig"]["storageExecutable"]).resolve(strict=True)
                    ), *[
                    sha256_file(Path(config["storageExecutable"]).resolve(strict=True))
                    for config in project["coldConfigs"]
                ]}),
            }
            for project in projects
        },
    }


def assert_environment_pins(session: Mapping[str, Any]) -> None:
    actual = environment_pins(session["projects"], session["provider"])
    if actual != session["environmentPins"]:
        raise RuntimeError(
            "Benchmark conditions changed. Refusing to mix samples; start a new session."
        )


def initialize(spec_path: Path, identifier: str | None) -> dict[str, Any]:
    spec = strict_object(
        read_json(spec_path), {"schemaVersion", "projects", "provider", "counts"}, "spec"
    )
    if spec.get("schemaVersion") != 2:
        raise ValueError("Native benchmark spec must use schemaVersion 2.")
    counts = counts_from(spec)
    project_values = spec.get("projects")
    if not isinstance(project_values, list) or len(project_values) != 2:
        raise ValueError("The spec must contain one fixture and one actual project.")
    projects: list[dict[str, Any]] = []
    roles: set[str] = set()
    ids: set[str] = set()
    for index, raw in enumerate(project_values):
        project = strict_object(
            raw,
            {"id", "role", "sourceProjectPath", "batchConfigPath", "coldBatchConfigPaths"},
            f"projects[{index}]",
        )
        project_id = safe_id(str(project.get("id", "")))
        role = project.get("role")
        if role not in {"fixture", "actual"} or role in roles or project_id in ids:
            raise ValueError("Projects need unique ids and exactly one fixture/actual role.")
        roles.add(role)
        ids.add(project_id)
        source = Path(str(project.get("sourceProjectPath", ""))).resolve(strict=True)
        source_manifest = tree_manifest(source, UNITY_INPUT_DIRECTORIES)
        warm = load_batch_identity(
            Path(str(project.get("batchConfigPath", ""))).resolve(strict=True)
        )
        if normalized_path(source) != normalized_path(warm["sourceProjectPath"]):
            raise ValueError(f"Project {project_id} does not match its warm config source.")
        raw_cold = project.get("coldBatchConfigPaths", [])
        if not isinstance(raw_cold, list) or not all(isinstance(value, str) for value in raw_cold):
            raise ValueError("coldBatchConfigPaths must be an array of strings.")
        if raw_cold and len(raw_cold) != counts["cold"]:
            raise ValueError("coldBatchConfigPaths must be empty or match counts.cold exactly.")
        cold = [load_batch_identity(Path(value).resolve(strict=True)) for value in raw_cold]
        parent_ids: set[str] = set()
        warm_parent_id = warm.get("parentId")
        for config in cold:
            if normalized_path(source) != normalized_path(config["sourceProjectPath"]):
                raise ValueError(f"Project {project_id} has a cold config for another source.")
            parent_id = config.get("parentId")
            if (
                not isinstance(parent_id, str)
                or not parent_id
                or parent_id in parent_ids
                or parent_id == warm_parent_id
            ):
                raise ValueError(
                    "Cold configs require schema-2 parentId values distinct from warm and each other."
                )
            parent_ids.add(parent_id)
        projects.append({
            "id": project_id, "role": role, "sourceProjectPath": str(source),
            "inputManifest": source_manifest, "warmConfig": warm, "coldConfigs": cold,
        })
    if roles != {"fixture", "actual"}:
        raise ValueError("The spec must contain one fixture and one actual project.")
    provider_value = strict_object(spec.get("provider"), {"id", "command"}, "provider")
    command, executable = resolve_command(provider_value.get("command", []))
    provider = {
        "id": safe_id(str(provider_value.get("id", ""))), "command": command,
        "executableSha256": sha256_file(executable),
    }
    session_id = safe_id(identifier or new_session_id())
    evidence_root = (EVIDENCE_ROOT / session_id).resolve()
    state_root = (STATE_ROOT / session_id).resolve()
    if evidence_root.exists() or state_root.exists():
        raise FileExistsError(f"Benchmark session already exists: {session_id}")
    evidence_root.mkdir(parents=True)
    state_root.mkdir(parents=True)
    session: dict[str, Any] = {
        "schemaVersion": 2, "sessionId": session_id, "createdAt": utc_now(),
        "updatedAt": utc_now(), "phase": "baseline", "evidenceRoot": str(evidence_root),
        "stateRoot": str(state_root), "specPath": str(spec_path.resolve()), "counts": counts,
        "projects": projects, "provider": provider,
        "environmentPins": environment_pins(projects, provider),
        "samples": {
            "primitives": None,
            "honeybee": {project["id"]: {"warm": [], "cold": []} for project in projects},
            "direct": {project["id"]: {
                "processActivation": [], "promptReady": []
            } for project in projects},
        },
    }
    save_session(session)
    write_report(session)
    return session


def invoke_probe(arguments: Sequence[str], log_root: Path) -> dict[str, Any]:
    log_root.parent.mkdir(parents=True, exist_ok=True)
    result = subprocess.run(
        ["node", str(PROBE), *arguments], cwd=REPO_ROOT, capture_output=True, text=True,
        timeout=2 * 60 * 60, creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    atomic_text(log_root.with_suffix(".stdout.log"), result.stdout)
    atomic_text(log_root.with_suffix(".stderr.log"), result.stderr)
    if result.returncode != 0:
        error_log = log_root.with_suffix(".stderr.log")
        raise RuntimeError(f"Benchmark probe failed; see {error_log}")
    lines = [line for line in result.stdout.splitlines() if line.strip()]
    value = json.loads(lines[-1]) if lines else None
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise RuntimeError("Benchmark probe returned invalid JSON.")
    return value


def windows_process_primitives(repetitions: int) -> dict[str, Any]:
    if os.name != "nt":
        return {
            "supported": False, "suspendedProcessCreate": [], "jobObjectCreateAssign": []
        }
    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
    kernel32.TerminateProcess.argtypes = [ctypes.c_void_p, ctypes.c_uint]
    kernel32.TerminateProcess.restype = ctypes.c_int
    kernel32.CreateJobObjectW.argtypes = [ctypes.c_void_p, ctypes.c_wchar_p]
    kernel32.CreateJobObjectW.restype = ctypes.c_void_p
    kernel32.AssignProcessToJobObject.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
    kernel32.AssignProcessToJobObject.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int
    flags = getattr(subprocess, "CREATE_SUSPENDED", 0x00000004) | getattr(
        subprocess, "CREATE_NO_WINDOW", 0x08000000
    )
    create_samples: list[float] = []
    job_samples: list[float] = []

    def suspended() -> subprocess.Popen[bytes]:
        return subprocess.Popen(
            [sys.executable, "-c", "import time; time.sleep(60)"],
            stdin=subprocess.DEVNULL, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
            creationflags=flags,
        )

    def terminate(process: subprocess.Popen[bytes]) -> None:
        handle = ctypes.c_void_p(int(process._handle))  # type: ignore[attr-defined]
        kernel32.TerminateProcess(handle, 0)
        process.wait(timeout=10)

    for _ in range(repetitions):
        started = time.perf_counter_ns()
        process = suspended()
        create_samples.append((time.perf_counter_ns() - started) / 1_000_000)
        terminate(process)
        process = suspended()
        process_handle = ctypes.c_void_p(int(process._handle))  # type: ignore[attr-defined]
        started = time.perf_counter_ns()
        job = kernel32.CreateJobObjectW(None, None)
        if not job or not kernel32.AssignProcessToJobObject(job, process_handle):
            error = ctypes.get_last_error()
            if job:
                kernel32.CloseHandle(job)
            terminate(process)
            raise OSError(error, "Could not create and assign benchmark Job Object")
        job_samples.append((time.perf_counter_ns() - started) / 1_000_000)
        terminate(process)
        kernel32.CloseHandle(job)
    return {
        "supported": True, "suspendedProcessCreate": create_samples,
        "jobObjectCreateAssign": job_samples,
    }


def run_primitives(session: dict[str, Any]) -> None:
    if session["samples"]["primitives"] is not None:
        return
    assert_environment_pins(session)
    count = session["counts"]["primitive"]
    output = invoke_probe(
        ["primitives", str(Path(session["stateRoot"]) / "primitives"), str(count)],
        Path(session["evidenceRoot"]) / "logs" / "primitives",
    )
    output.update(windows_process_primitives(count))
    session["samples"]["primitives"] = output
    save_session(session)


def timestamp_ms(value: str) -> float:
    return datetime.fromisoformat(value.replace("Z", "+00:00")).timestamp() * 1000


def event_duration(
    events: Sequence[Mapping[str, Any]], start_type: str, end_type: str
) -> float | None:
    start = next((event for event in events if event.get("type") == start_type), None)
    end = next((event for event in events if event.get("type") == end_type), None)
    if start is None or end is None:
        return None
    return max(0.0, timestamp_ms(str(end["timestamp"])) - timestamp_ms(str(start["timestamp"])))


def durable_stdio_activation(events: Sequence[Mapping[str, Any]]) -> float | None:
    start = next(
        (
            event
            for event in events
            if event.get("type") == "artifact.stored"
            and event.get("payload", {}).get("artifact", {}).get("kind") == "step-input"
        ),
        None,
    )
    end = next((event for event in events if event.get("type") == "agent.started"), None)
    if start is None or end is None:
        return None
    return max(0.0, timestamp_ms(str(end["timestamp"])) - timestamp_ms(str(start["timestamp"])))


def load_events(journal_path: Path) -> list[dict[str, Any]]:
    serialized = journal_path.read_text(encoding="utf-8")
    if not serialized or not serialized.endswith("\n"):
        raise RuntimeError("Benchmark Journal is incomplete.")
    events = [json.loads(line) for line in serialized[:-1].split("\n")]
    if any(not isinstance(event, dict) for event in events):
        raise RuntimeError("Benchmark Journal contains a non-object event.")
    if not events or events[-1].get("type") not in TERMINAL_EVENTS:
        raise RuntimeError("Benchmark Journal is not terminal.")
    return events


def unity_sample(
    session: dict[str, Any], project: Mapping[str, Any], temperature: str,
    index: int, config: Mapping[str, Any],
) -> dict[str, Any]:
    project_id = project["id"]
    sample_id = f"{project_id}-{temperature}-{index + 1:02d}"
    sample_root = Path(session["stateRoot"]) / "unity" / sample_id
    request_path = sample_root / "request.json"
    request = {
        "schemaVersion": 1, "stateRoot": str(sample_root / "runs"),
        "batchConfigPath": config["path"], "projectPath": project["sourceProjectPath"],
        "timeoutMs": 30 * 60_000,
    }
    if sample_root.exists():
        if not sample_root.is_dir() or is_reparse(sample_root) or read_json(request_path) != request:
            raise RuntimeError("Interrupted benchmark sample state is missing or changed.")
    else:
        sample_root.mkdir(parents=True)
        atomic_json(request_path, request)
    result = invoke_probe(
        ["unity", str(request_path)], Path(session["evidenceRoot"]) / "logs" / sample_id
    )
    journal_path = Path(result["journalPath"]).resolve(strict=True)
    events = load_events(journal_path)
    evidence_journal = Path(session["evidenceRoot"]) / "journals" / f"{sample_id}.jsonl"
    evidence_journal.parent.mkdir(parents=True, exist_ok=True)
    shutil.copy2(journal_path, evidence_journal)
    source_checked = next(
        (event for event in events if event.get("type") == "source.checked"), None
    )
    source_unchanged = (
        isinstance(source_checked, dict)
        and source_checked.get("payload", {}).get("unchanged") is True
    )
    released = any(event.get("type") == "workspace.released" for event in events)
    terminal_type = events[-1]["type"]
    passed = (
        result.get("terminal") is True and terminal_type == "workflow.completed"
        and released and source_unchanged
    )
    return {
        "sampleId": sample_id, "temperature": temperature, "index": index,
        "runId": result["runId"], "status": "pass" if passed else "fail",
        "terminalEvent": terminal_type, "runtimeStatus": result.get("status"),
        "prepareMs": event_duration(events, "workflow.started", "workspace.prepared"),
        "acquireMs": event_duration(events, "workspace.acquire-started", "workspace.acquired"),
        "stdioProcessActivationMs": result.get("stdioProcessActivationMs"),
        "durableStdioActivationMs": durable_stdio_activation(events),
        "sourceUnchanged": source_unchanged, "workspaceReleased": released,
        "journal": str(evidence_journal), "configDigest": config["digest"],
        "parentId": config.get("parentId"),
    }


def run_honeybee(session: dict[str, Any]) -> None:
    for project in session["projects"]:
        target = session["samples"]["honeybee"][project["id"]]
        while len(target["warm"]) < session["counts"]["warm"]:
            assert_environment_pins(session)
            sample = unity_sample(
                session, project, "warm", len(target["warm"]), project["warmConfig"]
            )
            target["warm"].append(sample)
            save_session(session)
            if sample["status"] != "pass":
                raise RuntimeError("HoneyBee sample failed: {}".format(sample["sampleId"]))
        while project["coldConfigs"] and len(target["cold"]) < session["counts"]["cold"]:
            assert_environment_pins(session)
            index = len(target["cold"])
            sample = unity_sample(session, project, "cold", index, project["coldConfigs"][index])
            target["cold"].append(sample)
            save_session(session)
            if sample["status"] != "pass":
                raise RuntimeError("HoneyBee sample failed: {}".format(sample["sampleId"]))


def kill_process_tree(process: subprocess.Popen[Any]) -> None:
    if process.poll() is not None:
        return
    if os.name == "nt":
        subprocess.run(
            ["taskkill", "/PID", str(process.pid), "/T", "/F"],
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=20,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
    else:
        process.terminate()
    try:
        process.wait(timeout=10)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=10)


def direct_copy(
    session: dict[str, Any], project: dict[str, Any]
) -> tuple[Path, dict[str, Any]]:
    copies_root = Path(session["stateRoot"]) / "direct-copies"
    target = copies_root / project["id"]
    if target.exists():
        manifest = tree_manifest(target)
        if project.get("directCopyManifest") == manifest:
            return target, manifest
        remove_owned_tree(copies_root, target)
    manifest = copy_disposable_project(project["sourceProjectPath"], target, copies_root)
    project["directCopyManifest"] = manifest
    save_session(session)
    return target, manifest


def direct_activation_sample(
    session: dict[str, Any], project: dict[str, Any], index: int
) -> dict[str, Any]:
    copy_root, before = direct_copy(session, project)
    project_id = project["id"]
    sample_id = f"{project_id}-direct-{index + 1:02d}"
    log_root = Path(session["evidenceRoot"]) / "logs" / sample_id
    log_root.parent.mkdir(parents=True, exist_ok=True)
    with log_root.with_suffix(".stdout.log").open("wb") as stdout, \
            log_root.with_suffix(".stderr.log").open("wb") as stderr:
        started = time.perf_counter_ns()
        process = subprocess.Popen(
            session["provider"]["command"], cwd=copy_root, stdin=subprocess.DEVNULL,
            stdout=stdout, stderr=stderr,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        activation_ms = (time.perf_counter_ns() - started) / 1_000_000
        time.sleep(0.05)
        exited_early = process.poll() is not None
        exit_code = process.returncode
        kill_process_tree(process)
    after = tree_manifest(copy_root)
    unchanged = before == after
    return {
        "sampleId": sample_id, "index": index,
        "status": "pass" if unchanged and not exited_early else "fail",
        "activationMs": activation_ms, "exitedBeforeObservation": exited_early,
        "exitCode": exit_code, "copyUnchanged": unchanged,
    }


def run_direct(session: dict[str, Any]) -> None:
    for project in session["projects"]:
        target = session["samples"]["direct"][project["id"]]["processActivation"]
        while len(target) < session["counts"]["directProcess"]:
            assert_environment_pins(session)
            sample = direct_activation_sample(session, project, len(target))
            target.append(sample)
            save_session(session)
            if sample["status"] != "pass":
                raise RuntimeError(
                    "Direct provider sample failed or changed its copy: {}".format(
                        sample["sampleId"]
                    )
                )


def prompt_ready(session: dict[str, Any], project_id: str) -> None:
    project = next((item for item in session["projects"] if item["id"] == project_id), None)
    if project is None:
        raise ValueError(f"Unknown project: {project_id}")
    target = session["samples"]["direct"][project_id]["promptReady"]
    while len(target) < session["counts"]["promptReady"]:
        assert_environment_pins(session)
        copy_root, before = direct_copy(session, project)
        prompt_count = session["counts"]["promptReady"]
        print(f"\n[{len(target) + 1}/{prompt_count}] "
              "A disposable-copy provider window will open. Do not submit a task.")
        started = time.perf_counter_ns()
        process = subprocess.Popen(
            session["provider"]["command"], cwd=copy_root,
            creationflags=getattr(subprocess, "CREATE_NEW_CONSOLE", 0),
        )
        input("Press Enter as soon as the native prompt is visibly ready: ")
        ready_ms = (time.perf_counter_ns() - started) / 1_000_000
        kill_process_tree(process)
        unchanged = before == tree_manifest(copy_root)
        sample = {
            "sampleId": f"{project_id}-prompt-ready-{len(target) + 1:02d}",
            "index": len(target), "status": "pass" if unchanged else "fail",
            "promptReadyMs": ready_ms, "copyUnchanged": unchanged,
            "operatorObserved": True,
        }
        target.append(sample)
        save_session(session)
        if not unchanged:
            raise RuntimeError("Provider changed the disposable project copy during prompt timing.")


def sample_stats(values: Sequence[float | int | None]) -> dict[str, Any] | None:
    clean = [
        float(value) for value in values
        if isinstance(value, (int, float)) and not isinstance(value, bool)
    ]
    if not clean:
        return None
    return {
        "n": len(clean), "medianMs": statistics.median(clean),
        "maxMs": max(clean), "rawMs": clean,
    }


def report_payload(session: Mapping[str, Any]) -> dict[str, Any]:
    issues: list[dict[str, str]] = []
    projects: list[dict[str, Any]] = []
    for project in session["projects"]:
        honeybee = session["samples"]["honeybee"][project["id"]]
        direct = session["samples"]["direct"][project["id"]]
        cold_collected = bool(project["coldConfigs"])
        if not cold_collected:
            cold_count = session["counts"]["cold"]
            issues.append({
                "code": "benchmark.cold-diagnostic-not-collected",
                "severity": "diagnostic",
                "message": (
                    f"{project['id']} has no safe reset mechanism for {cold_count} distinct "
                    "schema-2 Parent diagnostics; warm gates remain valid."
                ),
            })
        projects.append({
            "id": project["id"], "role": project["role"],
            "inputManifest": project["inputManifest"],
            "honeybee": {
                "warm": {
                    "prepare": sample_stats([item.get("prepareMs") for item in honeybee["warm"]]),
                    "acquire": sample_stats([item.get("acquireMs") for item in honeybee["warm"]]),
                    "stdioActivation": sample_stats([
                        item.get("durableStdioActivationMs") for item in honeybee["warm"]
                    ]),
                    "passed": sum(item.get("status") == "pass" for item in honeybee["warm"]),
                },
                "cold": {
                    "collectionStatus": (
                        "collected" if cold_collected else "not-collected"
                    ),
                    **({} if cold_collected else {
                        "reason": "safe-reset-unavailable",
                    }),
                    "prepare": sample_stats([item.get("prepareMs") for item in honeybee["cold"]]),
                    "acquire": sample_stats([item.get("acquireMs") for item in honeybee["cold"]]),
                    "stdioActivation": sample_stats([
                        item.get("durableStdioActivationMs") for item in honeybee["cold"]
                    ]),
                    "passed": sum(item.get("status") == "pass" for item in honeybee["cold"]),
                },
            },
            "direct": {
                "processActivation": sample_stats([
                    item.get("activationMs") for item in direct["processActivation"]
                ]),
                "promptReady": sample_stats([
                    item.get("promptReadyMs") for item in direct["promptReady"]
                ]),
                "copyUnchanged": all(
                    item.get("copyUnchanged") is True
                    for item in [*direct["processActivation"], *direct["promptReady"]]
                ),
            },
        })
    primitive = session["samples"]["primitives"]
    primitive_stats = None
    if isinstance(primitive, dict):
        primitive_stats = {
            name: sample_stats(primitive.get(name, []))
            for name in (
                "rawFsync", "journalAppend", "artifactPut", "immutablePublication",
                "suspendedProcessCreate", "jobObjectCreateAssign",
            )
        }
    complete = primitive_stats is not None
    if isinstance(primitive, dict):
        primitive_complete = primitive.get("supported") is True and all(
            primitive_stats.get(name) is not None
            and primitive_stats[name]["n"] == session["counts"]["primitive"]
            for name in primitive_stats
        )
        if not primitive_complete:
            issues.append({
                "code": "benchmark.primitive-incomplete",
                "severity": "error",
                "message": "Primitive samples are missing, unsupported, or have the wrong count.",
            })
        complete = complete and primitive_complete
    for project in session["projects"]:
        honeybee = session["samples"]["honeybee"][project["id"]]
        direct = session["samples"]["direct"][project["id"]]
        cold_configured = bool(project["coldConfigs"])
        expected_counts = all((
            len(honeybee["warm"]) == session["counts"]["warm"],
            (
                len(honeybee["cold"]) == session["counts"]["cold"]
                if cold_configured else len(honeybee["cold"]) == 0
            ),
            len(direct["processActivation"]) == session["counts"]["directProcess"],
            len(direct["promptReady"]) == session["counts"]["promptReady"],
        ))
        samples = [
            *honeybee["warm"], *honeybee["cold"],
            *direct["processActivation"], *direct["promptReady"],
        ]
        samples_pass = all(item.get("status") == "pass" for item in samples)
        timings_complete = all(
            item.get(name) is not None
            for item in [*honeybee["warm"], *honeybee["cold"]]
            for name in ("prepareMs", "acquireMs", "durableStdioActivationMs")
        )
        if not expected_counts or not samples_pass or not timings_complete:
            issues.append({
                "code": "benchmark.project-incomplete",
                "severity": "error",
                "message": (
                    f"{project['id']} has missing, failed, or non-durable timing samples."
                ),
            })
        complete = complete and expected_counts and samples_pass and timings_complete
    if session["environmentPins"].get("gitTrackedDirty"):
        issues.append({
            "code": "benchmark.git-dirty",
            "severity": "error",
            "message": "Baseline was initialized from a dirty tracked tree.",
        })
        complete = False
    return {
        "schemaVersion": 2, "sessionId": session["sessionId"], "phase": "baseline",
        "generatedAt": utc_now(),
        "status": "complete-awaiting-approval" if complete else "incomplete",
        "approvalStatus": "pending", "counts": session["counts"],
        "environmentPins": session["environmentPins"], "projects": projects,
        "primitives": primitive_stats,
        "activationBudgetProposal": {
            "status": "unapproved",
            "formula": (
                "4 * journalAppend.maxMs + immutablePublication.maxMs + "
                "suspendedProcessCreate.maxMs + jobObjectCreateAssign.maxMs"
            ),
            "budgetMs": None,
        },
        "issues": issues,
    }


def render_summary(metrics: Mapping[str, Any]) -> str:
    lines = [
        "# Native launch baseline {}".format(metrics["sessionId"]), "",
        "- Status: **{}**".format(metrics["status"]),
        "- Gate approval: **{}**".format(metrics["approvalStatus"]),
        "- Statistics: median + max; no p95 is reported.",
        "- Cold Parent measurements are non-blocking diagnostics, never performance gates.", "",
        "## Projects", "",
        "| Project | Role | Files / bytes | Warm prepare | Warm acquire | Cold prepare | Cold acquire | Direct process | Prompt ready |",
        "|---|---|---:|---:|---:|---:|---:|---:|---:|",
    ]

    def compact(value: Mapping[str, Any] | None) -> str:
        if not value:
            return "—"
        return "{:.1f}/{:.1f} ms (n={})".format(
            value["medianMs"], value["maxMs"], value["n"]
        )

    for project in metrics["projects"]:
        manifest = project["inputManifest"]
        lines.append(
            "| {id} | {role} | {files} / {bytes} | {wp} | {wa} | {cp} | {ca} | {direct} | {ready} |".format(
                id=project["id"], role=project["role"], files=manifest["fileCount"],
                bytes=manifest["logicalBytes"],
                wp=compact(project["honeybee"]["warm"]["prepare"]),
                wa=compact(project["honeybee"]["warm"]["acquire"]),
                cp=compact(project["honeybee"]["cold"]["prepare"]),
                ca=compact(project["honeybee"]["cold"]["acquire"]),
                direct=compact(project["direct"]["processActivation"]),
                ready=compact(project["direct"]["promptReady"]),
            )
        )
    lines.extend(["", "## Primitive budget inputs", ""])
    if metrics["primitives"]:
        lines.extend(
            f"- {name}: {compact(value)}" for name, value in metrics["primitives"].items()
        )
    else:
        lines.append("- Not measured.")
    lines.extend(["", "## Diagnostics and issues", ""])
    if metrics["issues"]:
        lines.extend(
            "- {}: {}".format(issue["code"], issue["message"])
            for issue in metrics["issues"]
        )
    else:
        lines.append("- None.")
    lines.extend([
        "",
        "This baseline does not authorize a native-default switch. Freeze reviewed gates "
        "only after explicit Evidence approval.", "",
    ])
    return "\n".join(lines)


def write_report(session: Mapping[str, Any]) -> dict[str, Any]:
    metrics = report_payload(session)
    evidence_root = Path(session["evidenceRoot"])
    atomic_json(evidence_root / "metrics.json", metrics)
    atomic_text(evidence_root / "summary.md", render_summary(metrics))
    event_lines: list[str] = []
    for project in session["projects"]:
        for temperature in ("warm", "cold"):
            for sample in session["samples"]["honeybee"][project["id"]][temperature]:
                journal = sample.get("journal")
                if not isinstance(journal, str) or not Path(journal).is_file():
                    continue
                for event in load_events(Path(journal)):
                    event_lines.append(json.dumps({
                        "projectId": project["id"], "temperature": temperature,
                        "sampleId": sample["sampleId"], "event": event,
                    }, ensure_ascii=False, sort_keys=True) + "\n")
    atomic_text(evidence_root / "events.ndjson", "".join(event_lines))
    return metrics


def validate_gate_approval(
    value: Any, project_ids: Sequence[str], expected_formula: str
) -> dict[str, Any]:
    gate = strict_object(
        value,
        {"schemaVersion", "approvedAt", "approvedBy", "prepareAcquire", "nativeActivation"},
        "gate approval",
    )
    approved_by = gate.get("approvedBy")
    if gate.get("schemaVersion") != 2 or not isinstance(approved_by, str) or not approved_by.strip():
        raise ValueError("Gate approval identity is invalid.")
    approved_at = datetime.fromisoformat(
        str(gate.get("approvedAt", "")).replace("Z", "+00:00")
    )
    if approved_at.tzinfo is None:
        raise ValueError("Gate approval timestamp must include a timezone.")
    prepare = strict_object(gate.get("prepareAcquire"), set(project_ids), "prepareAcquire")
    if set(prepare) != set(project_ids):
        raise ValueError("Gate approval must cover every measured project exactly once.")
    for project_id in project_ids:
        temperatures = strict_object(
            prepare[project_id], {"warm"}, f"prepareAcquire.{project_id}"
        )
        if set(temperatures) != {"warm"}:
            raise ValueError("Prepare/acquire gates require exactly the warm value.")
        limits = strict_object(
            temperatures["warm"],
            {"prepareMaxMs", "acquireMaxMs"},
            f"prepareAcquire.{project_id}.warm",
        )
        for name in ("prepareMaxMs", "acquireMaxMs"):
            number = limits.get(name)
            if not isinstance(number, (int, float)) or isinstance(number, bool) or number <= 0:
                raise ValueError(f"{project_id} warm {name} must be positive.")
    activation = strict_object(
        gate.get("nativeActivation"), {"formula", "budgetMs"}, "nativeActivation"
    )
    budget = activation.get("budgetMs")
    if activation.get("formula") != expected_formula:
        raise ValueError("Approved activation formula differs from the measured proposal.")
    if not isinstance(budget, (int, float)) or isinstance(budget, bool) or budget <= 0:
        raise ValueError("Approved native activation budgetMs must be positive.")
    return gate


def freeze_baseline(
    session: Mapping[str, Any], gate_path: Path, output_path: Path
) -> None:
    metrics = write_report(session)
    if metrics["status"] != "complete-awaiting-approval":
        raise RuntimeError("An incomplete or dirty baseline cannot be frozen.")
    gate = validate_gate_approval(
        read_json(gate_path),
        [project["id"] for project in session["projects"]],
        metrics["activationBudgetProposal"]["formula"],
    )
    benchmark_root = (REPO_ROOT / "docs" / "benchmarks" / "native-launch").resolve()
    output = output_path.resolve()
    try:
        output.relative_to(benchmark_root)
    except ValueError as error:
        raise ValueError("Frozen baselines must be under docs/benchmarks/native-launch.") from error
    frozen = {
        "schemaVersion": 2, "baselineId": session["sessionId"],
        "measuredAt": metrics["generatedAt"], "gitCommit": session["environmentPins"]["gitCommit"],
        "environment": {
            "platform": session["environmentPins"]["platform"],
            "pythonVersion": session["environmentPins"]["pythonVersion"],
            "nodeSha256": session["environmentPins"]["nodeSha256"],
            "defender": session["environmentPins"]["defender"],
            "projectPins": session["environmentPins"]["projects"],
        },
        "provider": {
            "id": session["provider"]["id"],
            "sha256": session["provider"]["executableSha256"],
        },
        "projects": [{
            "id": project["id"], "role": project["role"],
            "inputManifest": project["inputManifest"],
            "measurements": next(
                item for item in metrics["projects"] if item["id"] == project["id"]
            ),
        } for project in session["projects"]],
        "primitives": metrics["primitives"], "gates": gate,
    }
    atomic_json(output, frozen)


def run_automated(session: dict[str, Any], legs: Sequence[str]) -> None:
    if "primitives" in legs:
        run_primitives(session)
    if "honeybee" in legs:
        run_honeybee(session)
    if "direct" in legs:
        run_direct(session)
    save_session(session)
    write_report(session)


def parser() -> argparse.ArgumentParser:
    root = argparse.ArgumentParser(description=__doc__)
    commands = root.add_subparsers(dest="command", required=True)
    create = commands.add_parser("init", help="pin inputs and create an Evidence session")
    create.add_argument("--spec", required=True)
    create.add_argument("--session-id")
    run = commands.add_parser("run", help="run or resume automated PR 0 legs")
    run.add_argument("session_id")
    run.add_argument(
        "--legs", nargs="+", choices=("primitives", "honeybee", "direct"),
        default=("primitives", "honeybee", "direct"),
    )
    ready = commands.add_parser("prompt-ready", help="record operator-observed prompts")
    ready.add_argument("session_id")
    ready.add_argument("--project", required=True)
    finalize = commands.add_parser("finalize", help="regenerate metrics and summary")
    finalize.add_argument("session_id")
    freeze = commands.add_parser("freeze", help="freeze an explicitly approved baseline")
    freeze.add_argument("session_id")
    freeze.add_argument("--gates", required=True)
    freeze.add_argument("--output", required=True)
    return root


def main(arguments: Sequence[str] | None = None) -> int:
    args = parser().parse_args(arguments)
    if args.command == "init":
        session = initialize(Path(args.spec).resolve(strict=True), args.session_id)
        print(session["sessionId"])
        return 0
    session = load_session(args.session_id)
    with session_lock(session["stateRoot"]):
        if args.command == "run":
            run_automated(session, args.legs)
        elif args.command == "prompt-ready":
            prompt_ready(session, args.project)
            write_report(session)
        elif args.command == "finalize":
            write_report(session)
        elif args.command == "freeze":
            freeze_baseline(session, Path(args.gates).resolve(strict=True), Path(args.output))
    return 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except (OSError, ValueError, RuntimeError, subprocess.SubprocessError) as error:
        print(f"native benchmark failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error
