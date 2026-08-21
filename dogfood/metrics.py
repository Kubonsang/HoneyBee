"""Deterministic metrics and residual analysis for HoneyBee Desktop dogfood sessions."""

from __future__ import annotations

import hashlib
import json
import os
import re
import subprocess
import sys
import uuid
from collections import Counter
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable, Iterable, Mapping, Sequence

RUN_ID = re.compile(r"^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$")
DIGEST = re.compile(r"^sha256:([0-9a-f]{64})$")
LOG_COMPONENT = re.compile(r"^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$")
TERMINAL_EVENTS = {"workflow.completed", "workflow.failed", "workflow.cancelled"}
KNOWN_EVIDENCE_FILES = {
    "results.xml",
    "summary.json",
    "manifest.json",
    "stdout.log",
    "stderr.log",
    "events.ndjson",
}
MAX_LOG_FILE_BYTES = 16 * 1024 * 1024
MAX_LOG_SESSION_BYTES = 64 * 1024 * 1024
RESIDUAL_COUNTERS = (
    "activeChildCount",
    "retainedChildCount",
    "pendingCount",
    "quarantineCount",
)


def utc_now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def parse_time(value: str | None) -> datetime | None:
    if value is None:
        return None
    try:
        return datetime.fromisoformat(value.replace("Z", "+00:00"))
    except (TypeError, ValueError):
        return None


def milliseconds(start: str | None, end: str | None) -> int | None:
    left = parse_time(start)
    right = parse_time(end)
    if left is None or right is None or right < left:
        return None
    return round((right - left).total_seconds() * 1000)


def atomic_write_text(target: Path, content: str) -> None:
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
    with temporary.open("x", encoding="utf-8", newline="\n") as handle:
        handle.write(content)
        handle.flush()
        os.fsync(handle.fileno())
    os.replace(temporary, target)


def atomic_write_json(target: Path, value: Any) -> None:
    atomic_write_text(
        target,
        json.dumps(value, ensure_ascii=False, indent=2, sort_keys=True) + "\n",
    )


def load_json(target: Path) -> Any:
    with target.open("r", encoding="utf-8") as handle:
        return json.load(handle)


def sha256_file(target: Path) -> str:
    digest = hashlib.sha256()
    with target.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def issue(code: str, message: str, **metadata: Any) -> dict[str, Any]:
    return {"code": code, "message": message, **metadata}


def is_link_or_junction(target: Path) -> bool:
    return target.is_symlink() or (
        hasattr(target, "is_junction") and target.is_junction()
    )


def load_journals(state_root: Path) -> tuple[dict[str, list[dict[str, Any]]], list[dict[str, Any]]]:
    journals: dict[str, list[dict[str, Any]]] = {}
    issues: list[dict[str, Any]] = []
    if not state_root.exists():
        return journals, [issue("runtime.state-root-missing", "Runtime state root is absent.")]
    for directory in sorted(state_root.iterdir(), key=lambda entry: entry.name):
        if not directory.is_dir() or not RUN_ID.fullmatch(directory.name):
            continue
        if is_link_or_junction(directory):
            issues.append(
                issue(
                    "run.path-unsafe",
                    "Run directory is a link or junction.",
                    runId=directory.name,
                )
            )
            journals[directory.name] = []
            continue
        journal = directory / "events.jsonl"
        if not journal.is_file():
            issues.append(issue("journal.missing", "Run directory has no Journal.", runId=directory.name))
            journals[directory.name] = []
            continue
        data = journal.read_bytes()
        if not data or not data.endswith(b"\n"):
            issues.append(
                issue(
                    "journal.incomplete-line",
                    "Journal is empty or lacks a final newline.",
                    runId=directory.name,
                )
            )
            journals[directory.name] = []
            continue
        events: list[dict[str, Any]] = []
        schema_version: int | None = None
        for index, raw_line in enumerate(data[:-1].split(b"\n"), start=1):
            try:
                event = json.loads(raw_line.decode("utf-8"))
            except (UnicodeDecodeError, json.JSONDecodeError):
                issues.append(
                    issue(
                        "journal.invalid-json",
                        "Journal line is not valid UTF-8 JSON.",
                        runId=directory.name,
                        sequence=index,
                    )
                )
                events = []
                break
            if not isinstance(event, dict):
                issues.append(
                    issue(
                        "journal.invalid-event",
                        "Journal line is not an object.",
                        runId=directory.name,
                        sequence=index,
                    )
                )
                events = []
                break
            if (
                event.get("runId") != directory.name
                or event.get("sequence") != index
                or not isinstance(event.get("type"), str)
                or not isinstance(event.get("timestamp"), str)
            ):
                issues.append(
                    issue(
                        "journal.identity-invalid",
                        "Journal event identity or sequence is invalid.",
                        runId=directory.name,
                        sequence=index,
                    )
                )
                events = []
                break
            if schema_version is None:
                schema_version = event.get("schemaVersion")
            elif event.get("schemaVersion") != schema_version:
                issues.append(
                    issue(
                        "journal.schema-mixed",
                        "Journal contains mixed schema versions.",
                        runId=directory.name,
                        sequence=index,
                    )
                )
                events = []
                break
            events.append(event)
        if events and events[0].get("type") != "workflow.started":
            issues.append(
                issue(
                    "journal.start-invalid",
                    "Journal does not begin with workflow.started.",
                    runId=directory.name,
                )
            )
        terminals = [event for event in events if event.get("type") in TERMINAL_EVENTS]
        if len(terminals) > 1 or (terminals and events[-1] is not terminals[0]):
            issues.append(
                issue(
                    "journal.terminal-invalid",
                    "Terminal workflow event is not the single last event.",
                    runId=directory.name,
                )
            )
        journals[directory.name] = events
    return journals, issues


def normalized_events(
    session_id: str, journals: Mapping[str, Sequence[Mapping[str, Any]]]
) -> list[dict[str, Any]]:
    values = [
        {
            "schemaVersion": 1,
            "sessionId": session_id,
            "source": "journal",
            "runId": run_id,
            "event": event,
        }
        for run_id, events in journals.items()
        for event in events
    ]
    return sorted(
        values,
        key=lambda value: (
            str(value["event"].get("timestamp", "")),
            str(value["runId"]),
            int(value["event"].get("sequence", 0)),
        ),
    )


def is_artifact_ref(value: Any) -> bool:
    return (
        isinstance(value, dict)
        and isinstance(value.get("artifactId"), str)
        and isinstance(value.get("kind"), str)
        and isinstance(value.get("mediaType"), str)
        and isinstance(value.get("byteLength"), int)
        and isinstance(value.get("contentDigest"), str)
        and DIGEST.fullmatch(value["contentDigest"]) is not None
    )


def artifact_refs(value: Any) -> Iterable[dict[str, Any]]:
    if is_artifact_ref(value):
        yield value
        return
    if isinstance(value, dict):
        for child in value.values():
            yield from artifact_refs(child)
    elif isinstance(value, list):
        for child in value:
            yield from artifact_refs(child)


def artifact_path(state_root: Path, run_id: str, artifact: Mapping[str, Any]) -> Path:
    match = DIGEST.fullmatch(str(artifact.get("contentDigest", "")))
    if match is None or RUN_ID.fullmatch(run_id) is None:
        raise ValueError("Invalid Artifact identity.")
    hex_digest = match.group(1)
    return state_root / run_id / "blobs" / "sha256" / hex_digest[:2] / hex_digest[2:]


def read_artifact_bytes(
    state_root: Path,
    run_id: str,
    artifact: Mapping[str, Any],
) -> tuple[bytes | None, dict[str, Any] | None]:
    try:
        target = artifact_path(state_root, run_id, artifact)
        current = state_root / run_id
        for component in ("blobs", "sha256", target.parent.name, target.name):
            if is_link_or_junction(current):
                raise OSError("Artifact path contains a link or junction.")
            current = current / component
        if is_link_or_junction(current):
            raise OSError("Artifact path contains a link or junction.")
        run_physical = (state_root / run_id).resolve(strict=True)
        target_physical = target.resolve(strict=True)
        target_physical.relative_to(run_physical)
        if not target_physical.is_file():
            raise OSError("Artifact blob is not a private regular file.")
        content = target_physical.read_bytes()
        expected_length = artifact.get("byteLength")
        expected_digest = str(artifact.get("contentDigest"))
        actual_digest = "sha256:" + hashlib.sha256(content).hexdigest()
        if len(content) != expected_length or actual_digest != expected_digest:
            return None, issue(
                "artifact.integrity-failed",
                "Artifact byteLength or contentDigest mismatched.",
                runId=run_id,
                artifactId=artifact.get("artifactId"),
            )
        return content, None
    except (OSError, ValueError) as error:
        return None, issue(
            "artifact.read-failed",
            "Artifact blob could not be read safely.",
            runId=run_id,
            artifactId=artifact.get("artifactId"),
            detail=type(error).__name__,
        )


def read_artifact_json(
    state_root: Path,
    run_id: str,
    artifact: Mapping[str, Any],
) -> tuple[Any | None, dict[str, Any] | None]:
    content, artifact_issue = read_artifact_bytes(state_root, run_id, artifact)
    if artifact_issue is not None or content is None:
        return None, artifact_issue
    try:
        return json.loads(content.decode("utf-8")), None
    except (UnicodeDecodeError, json.JSONDecodeError):
        return None, issue(
            "artifact.json-invalid",
            "JSON Artifact is not valid UTF-8 JSON.",
            runId=run_id,
            artifactId=artifact.get("artifactId"),
        )


def validate_referenced_artifacts(
    state_root: Path,
    journals: Mapping[str, Sequence[Mapping[str, Any]]],
) -> list[dict[str, Any]]:
    """Re-read every Journal-authoritative Artifact and verify its content address."""
    issues: list[dict[str, Any]] = []
    seen: set[tuple[str, str, str]] = set()
    for run_id, events in journals.items():
        for event in events:
            for artifact in artifact_refs(event):
                identity = (
                    run_id,
                    str(artifact.get("artifactId")),
                    str(artifact.get("contentDigest")),
                )
                if identity in seen:
                    continue
                seen.add(identity)
                _, artifact_issue = read_artifact_bytes(state_root, run_id, artifact)
                if artifact_issue is not None:
                    issues.append(artifact_issue)
    return issues


def first_event(events: Sequence[Mapping[str, Any]], event_type: str) -> Mapping[str, Any] | None:
    return next((event for event in events if event.get("type") == event_type), None)


def last_event(events: Sequence[Mapping[str, Any]], event_type: str) -> Mapping[str, Any] | None:
    return next((event for event in reversed(events) if event.get("type") == event_type), None)


def matching_event(
    events: Sequence[Mapping[str, Any]],
    types: set[str],
    after_sequence: int,
    identity: Mapping[str, Any] | None = None,
) -> Mapping[str, Any] | None:
    for event in events:
        if event.get("sequence", 0) <= after_sequence or event.get("type") not in types:
            continue
        if identity is not None:
            payload = event.get("payload")
            if not isinstance(payload, dict) or any(
                payload.get(key) != value for key, value in identity.items()
            ):
                continue
        return event
    return None


def observed_interval(
    events: Sequence[Mapping[str, Any]],
    start_type: str,
    end_types: set[str],
) -> dict[str, Any]:
    start = first_event(events, start_type)
    end = (
        matching_event(events, end_types, int(start.get("sequence", 0)))
        if start is not None
        else None
    )
    return {
        "start": None if start is None else start.get("timestamp"),
        "end": None if end is None else end.get("timestamp"),
        "durationMs": milliseconds(
            None if start is None else str(start.get("timestamp")),
            None if end is None else str(end.get("timestamp")),
        ),
        "terminalEvent": None if end is None else end.get("type"),
    }


def failure_location(events: Sequence[Mapping[str, Any]]) -> dict[str, Any] | None:
    failure_types = {
        "workspace.acquire-failed",
        "agent.input-write-failed",
        "editor.pool-acquire-failed",
        "capability.failed",
        "editor.pool-release-failed",
        "workspace.release-failed",
        "workflow.failed",
    }
    for event in events:
        if event.get("type") not in failure_types:
            continue
        payload = event.get("payload")
        failure = payload.get("failure") if isinstance(payload, dict) else None
        return {
            "event": event.get("type"),
            "sequence": event.get("sequence"),
            "timestamp": event.get("timestamp"),
            "errorCode": failure.get("errorCode") if isinstance(failure, dict) else None,
        }
    return None


def capability_metrics(
    state_root: Path,
    run_id: str,
    events: Sequence[Mapping[str, Any]],
    issues: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    capabilities: list[dict[str, Any]] = []
    for started in [event for event in events if event.get("type") == "capability.started"]:
        payload = started.get("payload")
        if not isinstance(payload, dict):
            continue
        identity = {
            "capabilityId": payload.get("capabilityId"),
            "index": payload.get("index"),
            "kind": payload.get("kind"),
        }
        terminal = matching_event(
            events,
            {"capability.completed", "capability.failed"},
            int(started.get("sequence", 0)),
            identity,
        )
        process_exit = matching_event(
            events,
            {"capability.process-exited"},
            int(started.get("sequence", 0)),
            identity,
        )
        result: dict[str, Any] = {
            **identity,
            "startedAt": started.get("timestamp"),
            "endedAt": None if terminal is None else terminal.get("timestamp"),
            "durationMs": milliseconds(
                str(started.get("timestamp")),
                None if terminal is None else str(terminal.get("timestamp")),
            ),
            "status": (
                "running"
                if terminal is None
                else "completed"
                if terminal.get("type") == "capability.completed"
                else "failed"
            ),
            "processDurationMs": (
                process_exit.get("payload", {}).get("durationMs")
                if isinstance(process_exit, dict)
                and isinstance(process_exit.get("payload"), dict)
                else None
            ),
        }
        if terminal is not None and terminal.get("type") == "capability.completed":
            terminal_payload = terminal.get("payload")
            evidence = terminal_payload.get("evidence") if isinstance(terminal_payload, dict) else None
            if is_artifact_ref(evidence):
                manifest, manifest_issue = read_artifact_json(state_root, run_id, evidence)
                if manifest_issue is not None:
                    issues.append(manifest_issue)
                if isinstance(manifest, dict) and isinstance(manifest.get("files"), list):
                    summary_ref = next(
                        (
                            item.get("artifact")
                            for item in manifest["files"]
                            if isinstance(item, dict) and item.get("name") == "summary.json"
                        ),
                        None,
                    )
                    if is_artifact_ref(summary_ref):
                        summary, summary_issue = read_artifact_json(state_root, run_id, summary_ref)
                        if summary_issue is not None:
                            issues.append(summary_issue)
                        if isinstance(summary, dict):
                            result["result"] = {
                                key: summary.get(key)
                                for key in (
                                    "compile_errors",
                                    "total",
                                    "passed",
                                    "failed",
                                    "skipped",
                                    "fallback_used",
                                    "cleanup_state",
                                )
                            }
        capabilities.append(result)
    return capabilities


def patch_metrics(
    state_root: Path,
    run_id: str,
    events: Sequence[Mapping[str, Any]],
    issues: list[dict[str, Any]],
) -> tuple[dict[str, Any] | None, dict[str, Any] | None]:
    verified = last_event(events, "patch.verified")
    if verified is None or not isinstance(verified.get("payload"), dict):
        return None, None
    patch_ref = verified["payload"].get("patch")
    if not is_artifact_ref(patch_ref):
        issues.append(
            issue("patch.reference-invalid", "patch.verified has no valid patch Artifact.", runId=run_id)
        )
        return None, None
    manifest, manifest_issue = read_artifact_json(state_root, run_id, patch_ref)
    if manifest_issue is not None:
        issues.append(manifest_issue)
    entries = manifest.get("entries") if isinstance(manifest, dict) else []
    if not isinstance(entries, list):
        entries = []
    changed_files = [
        {"path": entry.get("path"), "operation": entry.get("operation")}
        for entry in entries
        if isinstance(entry, dict)
        and isinstance(entry.get("path"), str)
        and isinstance(entry.get("operation"), str)
    ]
    counts = Counter(item["operation"] for item in changed_files)
    patch = {
        "artifactId": patch_ref.get("artifactId"),
        "contentDigest": patch_ref.get("contentDigest"),
        "verifiedAt": verified.get("timestamp"),
        "verifyObserved": observed_interval(events, "source.checked", {"patch.verified"}),
        "manifestVersion": manifest.get("schemaVersion") if isinstance(manifest, dict) else None,
        "changedFiles": changed_files,
        "changedFileCount": len(changed_files),
        "operations": dict(sorted(counts.items())),
    }
    disposition_target = state_root / run_id / "patch-disposition.json"
    disposition: dict[str, Any] | None = None
    if disposition_target.exists():
        try:
            value = load_json(disposition_target)
            if not isinstance(value, dict) or value.get("runId") != run_id:
                raise ValueError("identity")
            disposition = {
                "action": value.get("action"),
                "phase": value.get("phase"),
                "startedAt": value.get("startedAt"),
                "updatedAt": value.get("updatedAt"),
                "durationMs": milliseconds(value.get("startedAt"), value.get("updatedAt")),
                "conflictPaths": value.get("conflictPaths", []),
            }
        except (OSError, ValueError, json.JSONDecodeError):
            issues.append(
                issue(
                    "patch.disposition-invalid",
                    "Patch disposition record is invalid.",
                    runId=run_id,
                )
            )
    return patch, disposition


def config_for_work(
    state_root: Path,
    run_id: str,
    events: Sequence[Mapping[str, Any]],
    issues: list[dict[str, Any]],
) -> dict[str, Any] | None:
    start = events[0] if events else None
    payload = start.get("payload") if isinstance(start, dict) else None
    config_ref = payload.get("config") if isinstance(payload, dict) else None
    if not is_artifact_ref(config_ref):
        return None
    value, config_issue = read_artifact_json(state_root, run_id, config_ref)
    if config_issue is not None:
        issues.append(config_issue)
    return value if isinstance(value, dict) else None


def analyze_work(
    state_root: Path,
    run_id: str,
    events: Sequence[Mapping[str, Any]],
    issues: list[dict[str, Any]],
) -> dict[str, Any]:
    start = events[0] if events else {}
    payload = start.get("payload") if isinstance(start, dict) else {}
    linkage = payload.get("linkage") if isinstance(payload, dict) else {}
    terminal = events[-1] if events and events[-1].get("type") in TERMINAL_EVENTS else None
    agent_start = first_event(events, "agent.started")
    agent_exit = matching_event(
        events,
        {"agent.exited"},
        int(agent_start.get("sequence", 0)) if agent_start is not None else 0,
    )
    source = last_event(events, "source.checked")
    source_payload = source.get("payload") if isinstance(source, dict) else None
    patch, disposition = patch_metrics(state_root, run_id, events, issues)
    config = config_for_work(state_root, run_id, events, issues)
    workspace_event = last_event(events, "workspace.acquired") or first_event(
        events, "workspace.prepared"
    )
    workspace_payload = workspace_event.get("payload") if isinstance(workspace_event, dict) else None
    workspace_name = (
        workspace_payload.get("workspaceId") if isinstance(workspace_payload, dict) else None
    )
    workspace_root = None
    if isinstance(config, dict):
        storage = config.get("workspaceStorage")
        if isinstance(storage, dict) and isinstance(storage.get("workspaceRoot"), str):
            workspace_root = storage["workspaceRoot"]
    requested_capabilities = (
        config.get("capabilities")
        if isinstance(config, dict) and isinstance(config.get("capabilities"), list)
        else []
    )
    capability_results = capability_metrics(state_root, run_id, events, issues)
    workspace_path = (
        str(Path(workspace_root) / workspace_name)
        if isinstance(workspace_root, str) and isinstance(workspace_name, str)
        else None
    )
    return {
        "runId": run_id,
        "workId": linkage.get("workId") if isinstance(linkage, dict) else None,
        "parentRunId": linkage.get("parentRunId") if isinstance(linkage, dict) else None,
        "priority": linkage.get("priority") if isinstance(linkage, dict) else None,
        "status": (
            terminal.get("type", "").removeprefix("workflow.")
            if terminal is not None
            else "cleanup-pending"
        ),
        "startedAt": start.get("timestamp") if isinstance(start, dict) else None,
        "endedAt": terminal.get("timestamp") if terminal is not None else None,
        "wallClockMs": milliseconds(
            start.get("timestamp") if isinstance(start, dict) else None,
            terminal.get("timestamp") if terminal is not None else None,
        ),
        "timings": {
            "workspacePrepareObserved": observed_interval(
                events, "workflow.started", {"workspace.prepared"}
            ),
            "workspaceAcquire": observed_interval(
                events,
                "workspace.acquire-started",
                {"workspace.acquired", "workspace.acquire-failed"},
            ),
            "editorPoolQueueWait": observed_interval(
                events, "editor.pool-queued", {"editor.pool-acquired", "editor.pool-cancelled"}
            ),
            "editorSlotOccupied": observed_interval(
                events, "editor.pool-acquired", {"editor.pool-released"}
            ),
            "editorLaunch": observed_interval(
                events,
                "editor.launch-intended",
                {"editor.ownership-established", "editor.launch-abandoned"},
            ),
            "bridgeReady": observed_interval(
                events, "editor.ownership-established", {"editor.bridge-bound"}
            ),
            "workspaceRelease": observed_interval(
                events,
                "workspace.release-started",
                {"workspace.released", "workspace.release-failed"},
            ),
        },
        "agent": {
            "startedAt": None if agent_start is None else agent_start.get("timestamp"),
            "exitedAt": None if agent_exit is None else agent_exit.get("timestamp"),
            "journalDurationMs": milliseconds(
                None if agent_start is None else str(agent_start.get("timestamp")),
                None if agent_exit is None else str(agent_exit.get("timestamp")),
            ),
            "processDurationMs": (
                agent_exit.get("payload", {}).get("durationMs")
                if isinstance(agent_exit, dict) and isinstance(agent_exit.get("payload"), dict)
                else None
            ),
            "exitCode": (
                agent_exit.get("payload", {}).get("exitCode")
                if isinstance(agent_exit, dict) and isinstance(agent_exit.get("payload"), dict)
                else None
            ),
        },
        "requestedCapabilities": [
            {
                "id": item.get("id"),
                "kind": item.get("kind"),
            }
            for item in requested_capabilities
            if isinstance(item, dict)
        ],
        "capabilities": capability_results,
        "sourceUnchanged": (
            source_payload.get("unchanged") if isinstance(source_payload, dict) else None
        ),
        "patch": patch,
        "disposition": disposition,
        "workspace": {
            "workspaceId": workspace_name,
            "path": workspace_path,
            "presentAfter": Path(workspace_path).exists() if workspace_path is not None else None,
        },
        "failure": failure_location(events),
    }


def agent_overlap(works: Sequence[Mapping[str, Any]]) -> dict[str, Any]:
    points: list[tuple[datetime, int]] = []
    for work in works:
        agent = work.get("agent")
        if not isinstance(agent, dict):
            continue
        start = parse_time(agent.get("startedAt"))
        end = parse_time(agent.get("exitedAt"))
        if start is None or end is None or end < start:
            continue
        points.extend([(start, 1), (end, -1)])
    points.sort(key=lambda item: (item[0], item[1]))
    if not points:
        return {
            "agentIntervals": 0,
            "maxConcurrentAgents": 0,
            "overlapMs": 0,
            "unionMs": 0,
            "overlapRatio": 0.0,
        }
    active = 0
    maximum = 0
    overlap = 0.0
    union = 0.0
    previous = points[0][0]
    for timestamp, delta_value in points:
        elapsed = (timestamp - previous).total_seconds() * 1000
        if active > 0:
            union += elapsed
        if active > 1:
            overlap += elapsed
        active += delta_value
        maximum = max(maximum, active)
        previous = timestamp
    return {
        "agentIntervals": len(points) // 2,
        "maxConcurrentAgents": maximum,
        "overlapMs": round(overlap),
        "unionMs": round(union),
        "overlapRatio": round(overlap / union, 6) if union > 0 else 0.0,
    }


def read_pool_events(
    state_root: Path, pool_id: str
) -> tuple[list[dict[str, Any]], list[dict[str, Any]]]:
    directory = state_root / ".unity-editor-pools" / "v2" / pool_id / "events"
    if not directory.is_dir():
        return [], [issue("pool.journal-missing", "Editor Pool event directory is missing.")]
    events: list[dict[str, Any]] = []
    issues: list[dict[str, Any]] = []
    for index, target in enumerate(sorted(directory.glob("*.json")), start=1):
        try:
            event = load_json(target)
            if (
                not isinstance(event, dict)
                or event.get("sequence") != index
                or event.get("poolId") != pool_id
            ):
                raise ValueError("identity")
            events.append(event)
        except (OSError, ValueError, json.JSONDecodeError):
            issues.append(
                issue("pool.journal-invalid", "Editor Pool event is invalid.", path=str(target))
            )
    return events, issues


def recorded_processes(
    journals: Mapping[str, Sequence[Mapping[str, Any]]]
) -> list[dict[str, Any]]:
    records: list[dict[str, Any]] = []
    accepted = {
        "agent.started": "agent",
        "capability.process-started": "capability",
        "editor.containment-registered": "editor-containment",
        "editor.ownership-established": "unity-editor",
    }
    for run_id, events in journals.items():
        for event in events:
            kind = accepted.get(str(event.get("type")))
            payload = event.get("payload")
            if kind is None or not isinstance(payload, dict) or not isinstance(payload.get("pid"), int):
                continue
            records.append(
                {
                    "runId": run_id,
                    "kind": kind,
                    "pid": payload["pid"],
                    "processIdentity": payload.get("processIdentity"),
                }
            )
    return records


def observe_process(pid: int, expected_identity: str | None) -> dict[str, Any]:
    if sys.platform != "win32":
        return {"pid": pid, "status": "unknown", "reason": "Windows-only dogfood check"}
    command = (
        f"$p = Get-Process -Id {pid} -ErrorAction Stop; "
        "[Console]::Out.Write($p.StartTime.ToUniversalTime().Ticks)"
    )
    result = subprocess.run(
        [
            "powershell.exe",
            "-NoLogo",
            "-NoProfile",
            "-NonInteractive",
            "-Command",
            command,
        ],
        capture_output=True,
        text=True,
        timeout=15,
        check=False,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    if result.returncode != 0:
        return {"pid": pid, "status": "missing"}
    actual = f"win32:{result.stdout.strip()}"
    return {
        "pid": pid,
        "status": "alive-original" if expected_identity == actual else "pid-reused",
        "expectedIdentity": expected_identity,
        "actualIdentity": actual,
    }


def provider_status(config_path: Path, session_id: str) -> dict[str, Any]:
    try:
        config = load_json(config_path)
        transaction = config.get("transaction") if isinstance(config, dict) else None
        work = transaction if isinstance(transaction, dict) else config
        storage = work.get("workspaceStorage") if isinstance(work, dict) else None
        if not isinstance(storage, dict):
            raise ValueError("workspaceStorage")
        command_value = storage.get("command")
        if not isinstance(command_value, dict) or not isinstance(command_value.get("command"), str):
            raise ValueError("command")
        if command_value.get("args") or command_value.get("env"):
            raise ValueError("execution payload")
        executable = Path(command_value["command"]).resolve()
        expected_digest = str(storage.get("binarySha256", ""))
        actual_digest = sha256_file(executable)
        if actual_digest != expected_digest:
            return {
                "status": "failed",
                "errorCode": "workspace.binary-pin-mismatch",
                "expectedDigest": expected_digest,
                "actualDigest": actual_digest,
            }
        request_id = "dogfood-" + hashlib.sha256(session_id.encode("utf-8")).hexdigest()[:32]
        result = subprocess.run(
            [str(executable), "workspace", "status", "--request-id", request_id],
            cwd=str(Path(str(storage["workspaceRoot"])).resolve()),
            capture_output=True,
            text=True,
            timeout=30,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        if result.returncode != 0:
            return {"status": "failed", "errorCode": "workspace.status-failed"}
        response = json.loads(result.stdout)
        parent_key = storage.get("parentKey")
        provider = parent_key.get("provider") if isinstance(parent_key, dict) else None
        if (
            not isinstance(response, dict)
            or response.get("schemaVersion") != 1
            or response.get("requestId") != request_id
            or response.get("provider") != provider
            or not isinstance(response.get("status"), dict)
        ):
            return {"status": "failed", "errorCode": "workspace.status-invalid"}
        counters = {name: response["status"].get(name) for name in RESIDUAL_COUNTERS}
        return {
            "status": "pass" if all(value == 0 for value in counters.values()) else "residual",
            "provider": response.get("provider"),
            "counters": counters,
        }
    except (OSError, ValueError, KeyError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        return {
            "status": "failed",
            "errorCode": "workspace.status-unavailable",
            "detail": type(error).__name__,
        }


def run_runtime_probe(
    repo_root: Path,
    session: Mapping[str, Any],
    run_ids: Sequence[str],
    patches: Sequence[Mapping[str, str]],
) -> dict[str, Any]:
    probe = repo_root / "dogfood" / "runtime-probe.mjs"
    runtime_module = repo_root / "apps" / "cli" / "dist" / "runtime-api.js"
    if not runtime_module.is_file():
        return {
            "schemaVersion": 1,
            "error": {
                "code": "dogfood.runtime-build-missing",
                "message": "Build HoneyBee before starting dogfood.",
            },
        }
    request = {
        "schemaVersion": 1,
        "stateRoot": session["stateRoot"],
        "projectPath": session["projectPath"],
        "configPath": session["configPath"],
        "runIds": list(run_ids),
        "patches": list(patches),
    }
    try:
        result = subprocess.run(
            ["node", str(probe)],
            cwd=str(repo_root),
            input=json.dumps(request),
            capture_output=True,
            text=True,
            timeout=120,
            check=False,
            creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
        )
        response = json.loads(result.stdout)
        if not isinstance(response, dict):
            raise ValueError("response")
        return response
    except (OSError, ValueError, json.JSONDecodeError, subprocess.SubprocessError) as error:
        return {
            "schemaVersion": 1,
            "error": {
                "code": "dogfood.runtime-probe-failed",
                "message": type(error).__name__,
            },
        }


def export_logs(
    evidence_root: Path,
    state_root: Path,
    works: Sequence[Mapping[str, Any]],
    journals: Mapping[str, Sequence[Mapping[str, Any]]],
    issues: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    exported: list[dict[str, Any]] = []
    used = 0

    def safe_component(value: str, fallback: str) -> str:
        return value if LOG_COMPONENT.fullmatch(value) else fallback

    def publish(relative: Path, content: bytes) -> None:
        nonlocal used
        remaining = MAX_LOG_SESSION_BYTES - used
        available = min(len(content), MAX_LOG_FILE_BYTES, max(remaining, 0))
        log_root = evidence_root / "logs"
        target = log_root / relative
        target.resolve(strict=False).relative_to(log_root.resolve(strict=False))
        target.parent.mkdir(parents=True, exist_ok=True)
        temporary = target.with_name(f".{target.name}.{uuid.uuid4().hex}.tmp")
        with temporary.open("xb") as handle:
            handle.write(content[:available])
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temporary, target)
        used += available
        exported.append(
            {
                "path": str(Path("logs") / relative).replace("\\", "/"),
                "sourceBytes": len(content),
                "storedBytes": available,
                "truncated": available < len(content),
                "contentDigest": "sha256:" + hashlib.sha256(content).hexdigest(),
            }
        )

    for work in works:
        run_id = work.get("runId")
        work_id = work.get("workId") or run_id
        if not isinstance(run_id, str) or not isinstance(work_id, str):
            continue
        safe_work_id = safe_component(work_id, run_id)
        editor_log = state_root / run_id / "unity-editor.log"
        if editor_log.is_file() and not is_link_or_junction(editor_log):
            publish(Path(safe_work_id) / "unity-editor.log", editor_log.read_bytes())
        for event in journals.get(run_id, []):
            if event.get("type") != "capability.completed":
                continue
            payload = event.get("payload")
            evidence = payload.get("evidence") if isinstance(payload, dict) else None
            capability_id = payload.get("capabilityId") if isinstance(payload, dict) else "capability"
            if not is_artifact_ref(evidence) or not isinstance(capability_id, str):
                continue
            safe_capability_id = safe_component(capability_id, "capability")
            manifest, manifest_issue = read_artifact_json(state_root, run_id, evidence)
            if manifest_issue is not None:
                issues.append(manifest_issue)
                continue
            files = manifest.get("files") if isinstance(manifest, dict) else None
            if not isinstance(files, list):
                continue
            for item in files:
                if not isinstance(item, dict) or item.get("name") not in KNOWN_EVIDENCE_FILES:
                    continue
                artifact = item.get("artifact")
                if not is_artifact_ref(artifact):
                    continue
                content, artifact_issue = read_artifact_bytes(state_root, run_id, artifact)
                if artifact_issue is not None:
                    issues.append(artifact_issue)
                elif content is not None:
                    publish(Path(safe_work_id) / safe_capability_id / item["name"], content)
    return exported


def runtime_patch_states(probe: Mapping[str, Any]) -> dict[tuple[str, str], str]:
    values: dict[tuple[str, str], str] = {}
    patches = probe.get("patches")
    if not isinstance(patches, list):
        return values
    for item in patches:
        if not isinstance(item, dict) or not isinstance(item.get("view"), dict):
            continue
        values[(str(item.get("runId")), str(item.get("patchArtifactId")))] = str(
            item["view"].get("sourceState")
        )
    return values


def runtime_run_states(probe: Mapping[str, Any]) -> dict[str, dict[str, Any]]:
    values: dict[str, dict[str, Any]] = {}
    runs = probe.get("runs")
    if not isinstance(runs, list):
        return values
    for item in runs:
        if not isinstance(item, dict) or not isinstance(item.get("runId"), str):
            continue
        detail = item.get("detail")
        summary = detail.get("summary") if isinstance(detail, dict) else None
        if not isinstance(summary, dict):
            continue
        values[item["runId"]] = {
            "status": summary.get("status"),
            "phase": summary.get("phase"),
            "terminal": summary.get("terminal"),
            "executorPresent": summary.get("executorPresent"),
            "message": detail.get("message") if isinstance(detail, dict) else None,
        }
    return values


def collect_metrics(
    repo_root: Path,
    session: Mapping[str, Any],
    *,
    runtime_probe_result: Mapping[str, Any] | None = None,
    provider_result: Mapping[str, Any] | None = None,
    process_observer: Callable[[int, str | None], dict[str, Any]] = observe_process,
) -> tuple[dict[str, Any], list[dict[str, Any]], str]:
    state_root = Path(str(session["stateRoot"]))
    evidence_root = Path(str(session["evidenceRoot"]))
    journals, issues = load_journals(state_root)
    build = session.get("build") if isinstance(session.get("build"), dict) else {}
    input_pins: dict[str, Any] = {}
    for name, path_key, digest_key in (
        ("desktopExe", "exePath", "desktopExeSha256"),
        ("config", "configPath", "configSha256"),
    ):
        try:
            actual = sha256_file(Path(str(session[path_key])))
            expected = build.get(digest_key)
            matched = isinstance(expected, str) and actual == expected
            input_pins[name] = {
                "expectedSha256": expected,
                "actualSha256": actual,
                "matched": matched,
            }
            if not matched:
                issues.append(
                    issue(
                        "session.input-pin-mismatch",
                        "A pinned dogfood input changed after session creation.",
                        input=name,
                    )
                )
        except (OSError, KeyError):
            input_pins[name] = {"matched": False}
            issues.append(
                issue(
                    "session.input-pin-unavailable",
                    "A pinned dogfood input is unavailable.",
                    input=name,
                )
            )
    issues.extend(validate_referenced_artifacts(state_root, journals))
    events_output = normalized_events(str(session["sessionId"]), journals)
    child_runs = {
        run_id: events
        for run_id, events in journals.items()
        if events
        and isinstance(events[0].get("payload"), dict)
        and events[0]["payload"].get("mode") == "unity-work-v3"
    }
    works = [
        analyze_work(state_root, run_id, events, issues)
        for run_id, events in sorted(child_runs.items())
    ]
    patches = [
        {"runId": work["runId"], "patchArtifactId": work["patch"]["artifactId"]}
        for work in works
        if isinstance(work.get("patch"), dict)
        and isinstance(work["patch"].get("artifactId"), str)
    ]
    probe = (
        dict(runtime_probe_result)
        if runtime_probe_result is not None
        else run_runtime_probe(repo_root, session, sorted(journals), patches)
    )
    patch_states = runtime_patch_states(probe)
    run_states = runtime_run_states(probe)
    for work in works:
        work["runtime"] = run_states.get(str(work["runId"]))
        patch = work.get("patch")
        if isinstance(patch, dict):
            patch["sourceState"] = patch_states.get(
                (str(work["runId"]), str(patch.get("artifactId")))
            )
    for item in probe.get("runs", []) if isinstance(probe.get("runs"), list) else []:
        if not isinstance(item, dict):
            continue
        if isinstance(item.get("error"), dict):
            issues.append(
                issue(
                    "runtime.run-probe-failed",
                    "Runtime API could not inspect a Run.",
                    runId=item.get("runId"),
                    errorCode=item["error"].get("code"),
                )
            )
            continue
        state = run_states.get(str(item.get("runId")))
        if state is not None and state.get("status") in {"indeterminate", "cleanup-pending"}:
            issues.append(
                issue(
                    f"run.{state['status']}",
                    "Runtime API reports a non-terminal Run requiring operator attention.",
                    runId=item.get("runId"),
                    phase=state.get("phase"),
                )
            )
    for item in probe.get("patches", []) if isinstance(probe.get("patches"), list) else []:
        if isinstance(item, dict) and isinstance(item.get("error"), dict):
            issues.append(
                issue(
                    "runtime.patch-probe-failed",
                    "Runtime API could not inspect a verified patch.",
                    runId=item.get("runId"),
                    artifactId=item.get("patchArtifactId"),
                    errorCode=item["error"].get("code"),
                )
            )
    config = load_json(Path(str(session["configPath"])))
    pool_id = config.get("editorPool", {}).get("id") if isinstance(config, dict) else None
    pool_events: list[dict[str, Any]] = []
    if isinstance(pool_id, str):
        pool_events, pool_issues = read_pool_events(state_root, pool_id)
        issues.extend(pool_issues)
    request_ids = {
        event.get("payload", {}).get("requestId")
        for events in child_runs.values()
        for event in events
        if event.get("type") == "editor.pool-requested"
        and isinstance(event.get("payload"), dict)
    }
    pool_residuals = []
    for request_id in sorted(value for value in request_ids if isinstance(value, str)):
        history = [event for event in pool_events if event.get("requestId") == request_id]
        terminal_type = history[-1].get("type") if history else None
        if terminal_type not in {"editor-pool.released", "editor-pool.cancelled"}:
            pool_residuals.append({"requestId": request_id, "lastEvent": terminal_type})
    process_records = recorded_processes(child_runs)
    desktop_records = session.get("desktopProcesses")
    if isinstance(desktop_records, list):
        process_records.extend(
            {
                "role": "desktop",
                "pid": record["pid"],
                "processIdentity": record.get("processIdentity"),
            }
            for record in desktop_records
            if isinstance(record, dict) and isinstance(record.get("pid"), int)
        )
    process_results = [
        {**record, **process_observer(record["pid"], record.get("processIdentity"))}
        for record in process_records
    ]
    live_originals = [
        record for record in process_results if record.get("status") == "alive-original"
    ]
    unknown_processes = [
        record for record in process_results if record.get("status") == "unknown"
    ]
    registry_missing = []
    for events in child_runs.values():
        for event in events:
            if event.get("type") != "editor.ownership-established":
                continue
            payload = event.get("payload")
            editor_id = payload.get("editorId") if isinstance(payload, dict) else None
            if isinstance(editor_id, str):
                tombstone = state_root / ".unity-editors" / "v1" / "exited" / f"{editor_id}.json"
                if not tombstone.is_file():
                    registry_missing.append(editor_id)
    editor_view = probe.get("editors") if isinstance(probe, dict) else None
    editor_probe_error = (
        editor_view.get("error")
        if isinstance(editor_view, dict) and isinstance(editor_view.get("error"), dict)
        else None
    )
    pool_view = probe.get("pool") if isinstance(probe, dict) else None
    pool_probe_error = (
        pool_view.get("error")
        if isinstance(pool_view, dict) and isinstance(pool_view.get("error"), dict)
        else None
    )
    if editor_probe_error is not None:
        issues.append(
            issue(
                "runtime.editor-registry-probe-failed",
                "Runtime API could not inspect the Editor Registry.",
                errorCode=editor_probe_error.get("code"),
            )
        )
    if pool_probe_error is not None:
        issues.append(
            issue(
                "runtime.editor-pool-probe-failed",
                "Runtime API could not inspect the Editor Pool.",
                errorCode=pool_probe_error.get("code"),
            )
        )
    child_run_ids = set(child_runs)
    owned_editor_residuals = [
        {
            "editorId": editor.get("editorId"),
            "runId": editor.get("ownerRunId"),
            "state": editor.get("state"),
            "pid": editor.get("pid"),
        }
        for editor in (
            editor_view.get("editors", []) if isinstance(editor_view, dict) else []
        )
        if isinstance(editor, dict)
        and editor.get("ownership") == "honeybee"
        and editor.get("ownerRunId") in child_run_ids
        and editor.get("state") != "exited"
    ]
    workspace_residuals = [
        {"runId": work["runId"], "path": work["workspace"]["path"]}
        for work in works
        if work.get("workspace", {}).get("presentAfter") is True
    ]
    provider = (
        dict(provider_result)
        if provider_result is not None
        else provider_status(Path(str(session["configPath"])), str(session["sessionId"]))
    )
    logs = export_logs(evidence_root, state_root, works, child_runs, issues)
    parents = [
        events
        for events in journals.values()
        if events
        and isinstance(events[0].get("payload"), dict)
        and events[0]["payload"].get("mode") == "unity-batch-v2"
    ]
    batch_start = min(
        (
            str(events[0].get("timestamp"))
            for events in parents
            if events and isinstance(events[0].get("timestamp"), str)
        ),
        default=min(
            (str(work.get("startedAt")) for work in works if work.get("startedAt")),
            default=None,
        ),
    )
    batch_end = max(
        (str(work.get("endedAt")) for work in works if work.get("endedAt")),
        default=None,
    )
    runtime_window_ms = milliseconds(batch_start, batch_end)
    segments = session.get("segments") if isinstance(session.get("segments"), list) else []
    segment_ends = [
        segment.get("endedAt")
        for segment in segments
        if isinstance(segment, dict) and isinstance(segment.get("endedAt"), str)
    ]
    session_end = max(segment_ends, default=session.get("updatedAt"))
    session_wall_ms = milliseconds(str(session.get("createdAt")), session_end)
    verified = sum(1 for work in works if isinstance(work.get("patch"), dict))
    changed_files = sum(
        int(work.get("patch", {}).get("changedFileCount", 0))
        for work in works
        if isinstance(work.get("patch"), dict)
    )
    dispositions = Counter(
        work.get("disposition", {}).get("phase")
        for work in works
        if isinstance(work.get("disposition"), dict)
    )
    doctor = probe.get("doctor") if isinstance(probe, dict) else None
    doctor_ok = isinstance(doctor, dict) and doctor.get("ok") is True
    expected = int(session.get("expectedWorks", 0))
    mode = str(session.get("mode"))
    source_checks_ok = bool(works) and all(work.get("sourceUnchanged") is True for work in works)
    work_status_ok = len(works) == expected and all(work.get("status") == "completed" for work in works)
    capability_kinds = {
        str(capability.get("kind"))
        for work in works
        for capability in work.get("capabilities", [])
        if isinstance(capability, dict) and capability.get("status") == "completed"
    }
    capabilities_ok = bool(works) and all(
        [
            (capability.get("id"), capability.get("kind"))
            for capability in work.get("requestedCapabilities", [])
            if isinstance(capability, dict)
        ]
        == [
            (capability.get("capabilityId"), capability.get("kind"))
            for capability in work.get("capabilities", [])
            if isinstance(capability, dict) and capability.get("status") == "completed"
        ]
        for work in works
    )
    compile_and_test_observed = {"compile", "warm-test"}.issubset(capability_kinds)
    dispositions_ok = sum(dispositions.values()) == len(works) and all(
        phase in {"applied", "rejected"} for phase in dispositions
    )
    scenario_ok = dispositions_ok
    if mode == "parallel" and expected >= 3:
        scenario_ok = (
            dispositions.get("applied", 0) >= 1
            and dispositions.get("rejected", 0) >= 2
            and any(
                work.get("disposition", {}).get("phase") == "rejected"
                and work.get("patch", {}).get("sourceState") == "drift"
                for work in works
                if isinstance(work.get("disposition"), dict)
                and isinstance(work.get("patch"), dict)
            )
        )
    residuals = {
        "workspaceShells": workspace_residuals,
        "editorPoolRequests": pool_residuals,
        "registryTombstonesMissing": registry_missing,
        "ownedEditors": owned_editor_residuals,
        "liveRecordedProcesses": live_originals,
        "unknownProcessChecks": unknown_processes,
        "provider": provider,
        "total": (
            len(workspace_residuals)
            + len(pool_residuals)
            + len(registry_missing)
            + len(owned_editor_residuals)
            + len(live_originals)
            + len(unknown_processes)
            + (0 if provider.get("status") == "pass" else 1)
        ),
    }
    probe_error = probe.get("error") if isinstance(probe, dict) else {"code": "invalid"}
    probe_entries_ok = editor_probe_error is None and pool_probe_error is None and not any(
        isinstance(item, dict) and isinstance(item.get("error"), dict)
        for name in ("runs", "patches")
        for item in (probe.get(name, []) if isinstance(probe.get(name), list) else [])
    )
    pass_conditions = {
        "doctorPassed": doctor_ok,
        "expectedWorksCompleted": work_status_ok,
        "sourceUnchangedBeforeDisposition": source_checks_ok,
        "configuredCapabilitiesCompleted": capabilities_ok,
        "compileAndWarmTestObserved": compile_and_test_observed,
        "patchDispositionScenarioCompleted": scenario_ok,
        "sessionInputsUnchanged": all(
            value.get("matched") is True for value in input_pins.values()
        ),
        "journalAndArtifactIntegrity": len(issues) == 0,
        "residualZero": residuals["total"] == 0,
        "runtimeProbePassed": probe_error is None and probe_entries_ok,
    }
    verdict = "pass" if all(pass_conditions.values()) else "fail"
    if not journals or any(
        work.get("status") == "cleanup-pending"
        or (work.get("runtime") or {}).get("status") in {"cleanup-pending", "indeterminate"}
        for work in works
    ):
        verdict = "incomplete"
    concurrency = agent_overlap(works)
    metrics = {
        "schemaVersion": 1,
        "sessionId": session["sessionId"],
        "scenario": {
            "mode": mode,
            "workloadId": session["workloadId"],
            "expectedWorks": expected,
        },
        "build": {**build, "inputPins": input_pins},
        "timing": {
            "sessionStartedAt": session.get("createdAt"),
            "sessionEndedAt": session_end,
            "sessionWallClockMs": session_wall_ms,
            "runtimeStartedAt": batch_start,
            "runtimeEndedAt": batch_end,
            "runtimeWindowMs": runtime_window_ms,
        },
        "concurrency": concurrency,
        "works": works,
        "aggregate": {
            "verifiedWorks": verified,
            "changedFiles": changed_files,
            "runtimeVerifiedChangesPerHour": (
                round(verified * 3_600_000 / runtime_window_ms, 6)
                if runtime_window_ms
                else None
            ),
            "sessionVerifiedChangesPerHour": (
                round(verified * 3_600_000 / session_wall_ms, 6)
                if session_wall_ms
                else None
            ),
            "changedFilesPerHour": (
                round(changed_files * 3_600_000 / runtime_window_ms, 6)
                if runtime_window_ms
                else None
            ),
            "dispositions": dict(sorted((str(key), value) for key, value in dispositions.items())),
        },
        "doctor": {
            "ok": doctor_ok,
            "checks": doctor.get("checks", []) if isinstance(doctor, dict) else [],
        },
        "residuals": residuals,
        "issues": issues,
        "logs": logs,
        "passConditions": pass_conditions,
        "verdict": verdict,
    }
    return metrics, events_output, render_summary(metrics)


def render_summary(metrics: Mapping[str, Any]) -> str:
    timing = metrics.get("timing", {})
    aggregate = metrics.get("aggregate", {})
    concurrency = metrics.get("concurrency", {})
    lines = [
        f"# HoneyBee dogfood session {metrics.get('sessionId')}",
        "",
        f"- Verdict: **{str(metrics.get('verdict')).upper()}**",
        f"- Mode / workload: {metrics.get('scenario', {}).get('mode')} / {metrics.get('scenario', {}).get('workloadId')}",
        f"- Session wall-clock: {timing.get('sessionWallClockMs')} ms",
        f"- Runtime window: {timing.get('runtimeWindowMs')} ms",
        f"- Verified changes/hour: {aggregate.get('runtimeVerifiedChangesPerHour')}",
        f"- Agent overlap: {concurrency.get('overlapMs')} ms (max {concurrency.get('maxConcurrentAgents')})",
        f"- Residual total: {metrics.get('residuals', {}).get('total')}",
        "",
        "## Works",
        "",
        "| Work | Status | Agent ms | Queue ms | Slot ms | Compile/Test | Files | Disposition |",
        "|---|---:|---:|---:|---:|---|---:|---|",
    ]
    for work in metrics.get("works", []):
        capability = ", ".join(
            f"{item.get('kind')}:{item.get('durationMs')}ms/{item.get('status')}"
            for item in work.get("capabilities", [])
        )
        lines.append(
            "| {work} | {status} | {agent} | {queue} | {slot} | {capability} | {files} | {disposition} |".format(
                work=work.get("workId"),
                status=work.get("status"),
                agent=work.get("agent", {}).get("processDurationMs"),
                queue=work.get("timings", {}).get("editorPoolQueueWait", {}).get("durationMs"),
                slot=work.get("timings", {}).get("editorSlotOccupied", {}).get("durationMs"),
                capability=capability or "—",
                files=work.get("patch", {}).get("changedFileCount") if work.get("patch") else 0,
                disposition=work.get("disposition", {}).get("phase") if work.get("disposition") else "pending",
            )
        )
    lines.extend(["", "## Pass conditions", ""])
    for name, passed in metrics.get("passConditions", {}).items():
        lines.append(f"- [{'x' if passed else ' '}] {name}")
    issues = metrics.get("issues", [])
    if issues:
        lines.extend(["", "## Diagnostics", ""])
        for item in issues:
            lines.append(
                f"- {item.get('code')}: {item.get('message')}"
                + (f" (Run {item.get('runId')})" if item.get("runId") else "")
            )
    return "\n".join(lines) + "\n"


def write_evidence(
    repo_root: Path,
    session: Mapping[str, Any],
    *,
    runtime_probe_result: Mapping[str, Any] | None = None,
    provider_result: Mapping[str, Any] | None = None,
    process_observer: Callable[[int, str | None], dict[str, Any]] = observe_process,
) -> dict[str, Any]:
    metrics, events, summary = collect_metrics(
        repo_root,
        session,
        runtime_probe_result=runtime_probe_result,
        provider_result=provider_result,
        process_observer=process_observer,
    )
    evidence_root = Path(str(session["evidenceRoot"]))
    atomic_write_json(evidence_root / "metrics.json", metrics)
    atomic_write_text(
        evidence_root / "events.ndjson",
        "".join(json.dumps(event, ensure_ascii=False, sort_keys=True) + "\n" for event in events),
    )
    atomic_write_text(evidence_root / "summary.md", summary)
    return metrics
