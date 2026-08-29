from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from dogfood.native_benchmark import (
    copy_disposable_project,
    durable_stdio_activation,
    environment_pins,
    event_duration,
    load_events,
    report_payload,
    sample_stats,
    tree_manifest,
    validate_gate_approval,
)


class NativeBenchmarkTest(unittest.TestCase):
    def unity_project(self, root: Path) -> None:
        for name in ("Assets", "Packages", "ProjectSettings"):
            (root / name).mkdir(parents=True, exist_ok=True)
        (root / "Assets" / "Feature.cs").write_text("feature", encoding="utf-8")
        (root / "Packages" / "manifest.json").write_text("{}", encoding="utf-8")
        (root / "ProjectSettings" / "ProjectVersion.txt").write_text(
            "m_EditorVersion: 6000.0.0f1", encoding="utf-8"
        )

    def test_manifest_framing_distinguishes_ambiguous_path_content_sequences(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            left = root / "left"
            right = root / "right"
            left.mkdir()
            right.mkdir()
            for name, content in (("a", "Xb"), ("b", "Y"), ("cc", "Z")):
                (left / name).write_text(content, encoding="utf-8")
            for name, content in (("a", "X"), ("bb", "Yc"), ("c", "Z")):
                (right / name).write_text(content, encoding="utf-8")
            left_manifest = tree_manifest(left)
            right_manifest = tree_manifest(right)
            self.assertEqual(left_manifest["fileCount"], right_manifest["fileCount"])
            self.assertEqual(left_manifest["logicalBytes"], right_manifest["logicalBytes"])
            self.assertNotEqual(left_manifest["digest"], right_manifest["digest"])

    def test_direct_copy_excludes_generated_roots_and_preserves_source(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "source"
            owner = root / "owned"
            target = owner / "copy"
            source.mkdir()
            owner.mkdir()
            self.unity_project(source)
            (source / "Library").mkdir()
            (source / "Library" / "cache.bin").write_bytes(b"cache")
            (source / ".honeybee").mkdir()
            (source / ".honeybee" / "task.md").write_text("private", encoding="utf-8")
            before = tree_manifest(source, ("Assets", "Packages", "ProjectSettings"))
            copy_disposable_project(source, target, owner)
            self.assertFalse((target / "Library").exists())
            self.assertFalse((target / ".honeybee").exists())
            self.assertTrue((target / "Assets" / "Feature.cs").is_file())
            self.assertEqual(
                before, tree_manifest(source, ("Assets", "Packages", "ProjectSettings"))
            )

    def test_manifest_rejects_links_when_supported(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            target = root / "target.txt"
            link = root / "link.txt"
            target.write_text("value", encoding="utf-8")
            try:
                os.symlink(target, link)
            except OSError:
                self.skipTest("This Windows account cannot create symlinks.")
            with self.assertRaises(ValueError):
                tree_manifest(root)

    def test_journal_intervals_require_a_terminal_last_event(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            journal = Path(directory) / "events.jsonl"
            events = [
                {
                    "type": "workflow.started",
                    "timestamp": "2026-01-01T00:00:00.000Z",
                },
                {
                    "type": "workspace.prepared",
                    "timestamp": "2026-01-01T00:00:02.500Z",
                },
                {
                    "type": "workflow.completed",
                    "timestamp": "2026-01-01T00:00:03.000Z",
                },
            ]
            journal.write_text(
                "".join(json.dumps(event) + "\n" for event in events), encoding="utf-8"
            )
            loaded = load_events(journal)
            self.assertEqual(2500.0, event_duration(loaded, "workflow.started", "workspace.prepared"))
            journal.write_text(json.dumps(events[0]), encoding="utf-8")
            with self.assertRaises(RuntimeError):
                load_events(journal)

    def test_stdio_activation_is_recoverable_from_durable_events(self) -> None:
        events = [
            {
                "type": "artifact.stored",
                "timestamp": "2026-01-01T00:00:00.000Z",
                "payload": {"artifact": {"kind": "step-input"}},
            },
            {"type": "agent.started", "timestamp": "2026-01-01T00:00:00.125Z"},
        ]
        self.assertEqual(125.0, durable_stdio_activation(events))

    def test_statistics_are_median_and_max_without_fake_p95(self) -> None:
        result = sample_stats([1, 2, 50, None])
        self.assertEqual(3, result["n"])
        self.assertEqual(2.0, result["medianMs"])
        self.assertEqual(50.0, result["maxMs"])
        self.assertNotIn("p95", result)

    def test_environment_pins_rehash_configs_storage_and_provider(self) -> None:
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            project_root = root / "project"
            project_root.mkdir()
            self.unity_project(project_root)
            config = root / "batch.json"
            storage = root / "storage.exe"
            provider = root / "provider.exe"
            config.write_text("one", encoding="utf-8")
            storage.write_bytes(b"storage-one")
            provider.write_bytes(b"provider-one")
            projects = [
                {
                    "id": "fixture",
                    "sourceProjectPath": str(project_root),
                    "warmConfig": {
                        "path": str(config),
                        "storageExecutable": str(storage),
                    },
                    "coldConfigs": [],
                }
            ]
            provider_value = {"command": [str(provider)]}
            with patch("dogfood.native_benchmark.run_git", return_value="pin"), patch(
                "dogfood.native_benchmark.defender_state", return_value={"available": True}
            ):
                before = environment_pins(projects, provider_value)
                config.write_text("two", encoding="utf-8")
                after_config = environment_pins(projects, provider_value)
                storage.write_bytes(b"storage-two")
                after_storage = environment_pins(projects, provider_value)
                provider.write_bytes(b"provider-two")
                after_provider = environment_pins(projects, provider_value)
            self.assertNotEqual(
                before["projects"]["fixture"]["configDigests"],
                after_config["projects"]["fixture"]["configDigests"],
            )
            self.assertNotEqual(
                after_config["projects"]["fixture"]["storageDigests"],
                after_storage["projects"]["fixture"]["storageDigests"],
            )
            self.assertNotEqual(after_storage["providerSha256"], after_provider["providerSha256"])

    def test_report_can_complete_with_cold_parent_diagnostic_not_collected(self) -> None:
        project = {
            "id": "fixture",
            "role": "fixture",
            "inputManifest": {"fileCount": 1, "logicalBytes": 1, "digest": "a"},
            "coldConfigs": [],
        }
        actual = {**project, "id": "actual", "role": "actual"}
        session = {
            "sessionId": "session",
            "counts": {
                "warm": 1,
                "cold": 1,
                "directProcess": 1,
                "promptReady": 1,
                "primitive": 1,
            },
            "projects": [project, actual],
            "environmentPins": {"gitTrackedDirty": False},
            "samples": {
                "primitives": {
                    "supported": True,
                    "rawFsync": [1],
                    "journalAppend": [1],
                    "artifactPut": [1],
                    "immutablePublication": [1],
                    "suspendedProcessCreate": [1],
                    "jobObjectCreateAssign": [1],
                },
                "honeybee": {
                    name: {
                        "warm": [{
                            "status": "pass",
                            "prepareMs": 1,
                            "acquireMs": 1,
                            "durableStdioActivationMs": 1,
                        }],
                        "cold": [],
                    }
                    for name in ("fixture", "actual")
                },
                "direct": {
                    name: {
                        "processActivation": [{
                            "status": "pass", "activationMs": 1, "copyUnchanged": True,
                        }],
                        "promptReady": [{
                            "status": "pass", "promptReadyMs": 1, "copyUnchanged": True,
                        }],
                    }
                    for name in ("fixture", "actual")
                },
            },
        }
        report = report_payload(session)
        self.assertEqual("complete-awaiting-approval", report["status"])
        self.assertEqual(
            2,
            sum(
                issue["code"] == "benchmark.cold-diagnostic-not-collected"
                for issue in report["issues"]
            ),
        )
        self.assertTrue(all(
            project["honeybee"]["cold"]["collectionStatus"] == "not-collected"
            and project["honeybee"]["cold"]["reason"] == "safe-reset-unavailable"
            for project in report["projects"]
        ))

    def test_collected_cold_failure_still_blocks_completion(self) -> None:
        project = {
            "id": "fixture",
            "role": "fixture",
            "inputManifest": {"fileCount": 1, "logicalBytes": 1, "digest": "a"},
            "coldConfigs": [{"parentId": "cold"}],
        }
        actual = {**project, "id": "actual", "role": "actual"}
        session = {
            "sessionId": "session",
            "counts": {
                "warm": 1,
                "cold": 1,
                "directProcess": 1,
                "promptReady": 1,
                "primitive": 1,
            },
            "projects": [project, actual],
            "environmentPins": {"gitTrackedDirty": False},
            "samples": {
                "primitives": {
                    "supported": True,
                    "rawFsync": [1],
                    "journalAppend": [1],
                    "artifactPut": [1],
                    "immutablePublication": [1],
                    "suspendedProcessCreate": [1],
                    "jobObjectCreateAssign": [1],
                },
                "honeybee": {
                    name: {
                        "warm": [{
                            "status": "pass",
                            "prepareMs": 1,
                            "acquireMs": 1,
                            "durableStdioActivationMs": 1,
                        }],
                        "cold": [{
                            "status": "fail",
                            "prepareMs": 1,
                            "acquireMs": 1,
                            "durableStdioActivationMs": 1,
                        }],
                    }
                    for name in ("fixture", "actual")
                },
                "direct": {
                    name: {
                        "processActivation": [{
                            "status": "pass", "activationMs": 1, "copyUnchanged": True,
                        }],
                        "promptReady": [{
                            "status": "pass", "promptReadyMs": 1, "copyUnchanged": True,
                        }],
                    }
                    for name in ("fixture", "actual")
                },
            },
        }
        report = report_payload(session)
        self.assertEqual("incomplete", report["status"])
        self.assertTrue(all(
            project["honeybee"]["cold"]["collectionStatus"] == "collected"
            for project in report["projects"]
        ))

    def test_gate_approval_is_strict_and_warm_only(self) -> None:
        formula = "4 * journal"
        gate = {
            "schemaVersion": 2,
            "approvedAt": "2026-08-26T00:00:00Z",
            "approvedBy": "owner",
            "prepareAcquire": {
                "fixture": {
                    "warm": {"prepareMaxMs": 1, "acquireMaxMs": 2},
                },
                "actual": {
                    "warm": {"prepareMaxMs": 5, "acquireMaxMs": 6},
                },
            },
            "nativeActivation": {"formula": formula, "budgetMs": 9},
        }
        self.assertEqual(
            gate, validate_gate_approval(gate, ["fixture", "actual"], formula)
        )
        invalid = {**gate, "nativeActivation": {"formula": "changed", "budgetMs": 9}}
        with self.assertRaises(ValueError):
            validate_gate_approval(invalid, ["fixture", "actual"], formula)
        legacy = {**gate, "schemaVersion": 1}
        with self.assertRaises(ValueError):
            validate_gate_approval(legacy, ["fixture", "actual"], formula)
        with_cold = json.loads(json.dumps(gate))
        with_cold["prepareAcquire"]["fixture"]["cold"] = {
            "prepareMaxMs": 3,
            "acquireMaxMs": 4,
        }
        with self.assertRaises(ValueError):
            validate_gate_approval(with_cold, ["fixture", "actual"], formula)


if __name__ == "__main__":
    unittest.main()
