from __future__ import annotations

import hashlib
import json
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path

from dogfood.metrics import (
    agent_overlap,
    collect_metrics,
    load_journals,
    validate_referenced_artifacts,
)
from dogfood.session import comparison_payload


RUN_ID = "00000000-0000-4000-8000-000000000001"


def timestamp(offset: int) -> str:
    value = datetime(2026, 1, 1, tzinfo=timezone.utc) + timedelta(seconds=offset)
    return value.isoformat().replace("+00:00", "Z")


def put_json(run_root: Path, artifact_id: str, kind: str, value: object) -> dict[str, object]:
    content = json.dumps(value, separators=(",", ":"), sort_keys=True).encode()
    digest = hashlib.sha256(content).hexdigest()
    target = run_root / "blobs" / "sha256" / digest[:2] / digest[2:]
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_bytes(content)
    return {
        "artifactId": artifact_id,
        "kind": kind,
        "mediaType": "application/json",
        "byteLength": len(content),
        "contentDigest": f"sha256:{digest}",
    }


def event(sequence: int, event_type: str, payload: object | None = None) -> dict[str, object]:
    return {
        "schemaVersion": 5,
        "runId": RUN_ID,
        "sequence": sequence,
        "timestamp": timestamp(sequence),
        "type": event_type,
        "payload": {} if payload is None else payload,
    }


class MetricsTest(unittest.TestCase):
    def test_completed_session_is_derived_from_authoritative_files(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            state_root = root / "runtime" / "runs"
            run_root = state_root / RUN_ID
            run_root.mkdir(parents=True)
            workspace_root = root / "workspaces"
            config_ref = put_json(
                run_root,
                "10000000-0000-4000-8000-000000000001",
                "run-config",
                {
                    "workspaceStorage": {"workspaceRoot": str(workspace_root)},
                    "capabilities": [
                        {"id": "compile", "kind": "compile"},
                        {"id": "tests", "kind": "warm-test"},
                    ],
                },
            )
            patch_ref = put_json(
                run_root,
                "20000000-0000-4000-8000-000000000001",
                "verified-patch",
                {
                    "schemaVersion": 1,
                    "entries": [{"path": "Assets/Feature.cs", "operation": "modify"}],
                },
            )
            values = [
                event(
                    1,
                    "workflow.started",
                    {
                        "mode": "unity-work-v3",
                        "config": config_ref,
                        "linkage": {
                            "workId": "work-a",
                            "parentRunId": "00000000-0000-4000-8000-000000000002",
                            "priority": "interactive",
                        },
                    },
                ),
                event(2, "workspace.prepared", {"workspaceId": "workspace-a"}),
                event(3, "workspace.acquire-started"),
                event(4, "workspace.acquired", {"workspaceId": "workspace-a"}),
                event(5, "agent.started", {"pid": 123, "processIdentity": "win32:1"}),
                event(6, "agent.exited", {"durationMs": 1000, "exitCode": 0}),
                event(
                    7,
                    "capability.started",
                    {"capabilityId": "compile", "index": 0, "kind": "compile"},
                ),
                event(
                    8,
                    "capability.completed",
                    {"capabilityId": "compile", "index": 0, "kind": "compile"},
                ),
                event(
                    9,
                    "capability.started",
                    {"capabilityId": "tests", "index": 1, "kind": "warm-test"},
                ),
                event(
                    10,
                    "capability.completed",
                    {"capabilityId": "tests", "index": 1, "kind": "warm-test"},
                ),
                event(11, "source.checked", {"unchanged": True}),
                event(12, "patch.verified", {"patch": patch_ref}),
                event(13, "workspace.release-started"),
                event(14, "workspace.released"),
                event(15, "workflow.completed"),
            ]
            (run_root / "events.jsonl").write_text(
                "".join(json.dumps(value, separators=(",", ":")) + "\n" for value in values),
                encoding="utf-8",
                newline="\n",
            )
            (run_root / "patch-disposition.json").write_text(
                json.dumps(
                    {
                        "runId": RUN_ID,
                        "action": "reject",
                        "phase": "rejected",
                        "startedAt": timestamp(16),
                        "updatedAt": timestamp(17),
                        "conflictPaths": [],
                    }
                ),
                encoding="utf-8",
            )
            config_path = root / "batch.json"
            config_path.write_text(json.dumps({"editorPool": {"id": "pool"}}), encoding="utf-8")
            executable = root / "HoneyBee.exe"
            executable.write_bytes(b"packaged-honeybee")
            (state_root / ".unity-editor-pools" / "v2" / "pool" / "events").mkdir(
                parents=True
            )
            evidence_root = root / "evidence"
            session = {
                "sessionId": "test-session",
                "stateRoot": str(state_root),
                "evidenceRoot": str(evidence_root),
                "configPath": str(config_path),
                "exePath": str(executable),
                "mode": "sequential",
                "workloadId": "same-work",
                "expectedWorks": 1,
                "createdAt": timestamp(0),
                "updatedAt": timestamp(18),
                "segments": [{"endedAt": timestamp(18)}],
                "desktopProcesses": [],
                "build": {
                    "desktopExeSha256": hashlib.sha256(executable.read_bytes()).hexdigest(),
                    "configSha256": hashlib.sha256(config_path.read_bytes()).hexdigest(),
                },
            }
            probe = {
                "doctor": {"ok": True, "checks": []},
                "runs": [
                    {
                        "runId": RUN_ID,
                        "detail": {
                            "summary": {
                                "status": "completed",
                                "phase": "Completed",
                                "terminal": True,
                                "executorPresent": False,
                            }
                        },
                    }
                ],
                "patches": [
                    {
                        "runId": RUN_ID,
                        "patchArtifactId": patch_ref["artifactId"],
                        "view": {"sourceState": "result"},
                    }
                ],
            }
            metrics, normalized, _ = collect_metrics(
                root,
                session,
                runtime_probe_result=probe,
                provider_result={"status": "pass", "counters": {}},
                process_observer=lambda pid, identity: {"pid": pid, "status": "missing"},
            )
            self.assertEqual("pass", metrics["verdict"], metrics)
            self.assertEqual(1, metrics["aggregate"]["verifiedWorks"])
            self.assertEqual(1, metrics["aggregate"]["changedFiles"])
            self.assertTrue(metrics["passConditions"]["compileAndWarmTestObserved"])
            self.assertEqual("completed", metrics["works"][0]["runtime"]["status"])
            self.assertEqual(len(values), len(normalized))

    def test_artifact_tampering_fails_closed(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            state_root = Path(directory)
            run_root = state_root / RUN_ID
            run_root.mkdir()
            artifact = put_json(
                run_root,
                "30000000-0000-4000-8000-000000000001",
                "run-config",
                {"safe": True},
            )
            values = [event(1, "workflow.started", {"mode": "unity-work-v3", "config": artifact})]
            target_digest = str(artifact["contentDigest"]).removeprefix("sha256:")
            target = run_root / "blobs" / "sha256" / target_digest[:2] / target_digest[2:]
            target.write_bytes(b"tampered")
            issues = validate_referenced_artifacts(state_root, {RUN_ID: values})
            self.assertEqual(["artifact.integrity-failed"], [item["code"] for item in issues])

    def test_terminal_event_must_be_last(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            run_root = Path(directory) / RUN_ID
            run_root.mkdir()
            values = [
                event(1, "workflow.started", {"mode": "unity-work-v3"}),
                event(2, "workflow.completed"),
                event(3, "agent.exited"),
            ]
            (run_root / "events.jsonl").write_text(
                "".join(json.dumps(value) + "\n" for value in values), encoding="utf-8"
            )
            _, issues = load_journals(Path(directory))
            self.assertIn("journal.terminal-invalid", [item["code"] for item in issues])

    def test_agent_overlap_and_comparison_are_deterministic(self) -> None:
        overlap = agent_overlap(
            [
                {"agent": {"startedAt": timestamp(0), "exitedAt": timestamp(10)}},
                {"agent": {"startedAt": timestamp(5), "exitedAt": timestamp(15)}},
            ]
        )
        self.assertEqual(5_000, overlap["overlapMs"])
        self.assertEqual(2, overlap["maxConcurrentAgents"])
        comparison = comparison_payload(
            {
                "sessionId": "one",
                "scenario": {"mode": "sequential", "workloadId": "workload"},
                "aggregate": {
                    "runtimeVerifiedChangesPerHour": 2.0,
                    "sessionVerifiedChangesPerHour": 1.0,
                },
                "concurrency": {"maxConcurrentAgents": 1},
                "verdict": "pass",
            },
            {
                "sessionId": "three",
                "scenario": {"mode": "parallel", "workloadId": "workload"},
                "aggregate": {
                    "runtimeVerifiedChangesPerHour": 6.0,
                    "sessionVerifiedChangesPerHour": 4.0,
                },
                "concurrency": {"maxConcurrentAgents": 3},
                "verdict": "pass",
            },
        )
        self.assertEqual(3.0, comparison["ratios"]["runtimeThroughput"])
        self.assertEqual(4.0, comparison["ratios"]["sessionThroughput"])


if __name__ == "__main__":
    unittest.main()
