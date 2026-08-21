"""Launch, observe, resume, finalize, and compare HoneyBee Desktop dogfood sessions."""

from __future__ import annotations

import argparse
import json
import os
import subprocess
import sys
import time
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Mapping, Sequence

if __package__ in {None, ""}:
    sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from dogfood.metrics import (  # noqa: E402
    atomic_write_json,
    atomic_write_text,
    load_journals,
    load_json,
    observe_process,
    run_runtime_probe,
    sha256_file,
    utc_now,
    write_evidence,
)

REPO_ROOT = Path(__file__).resolve().parents[1]
DEFAULT_EXE = REPO_ROOT / "apps" / "desktop" / "release" / "HoneyBee-win32-x64" / "HoneyBee.exe"
EVIDENCE_ROOT = REPO_ROOT / "dogfood" / "evidence"
STATE_ROOT = REPO_ROOT / "dogfood" / "state"
SESSION_ID_CHARS = set("0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ-_.")


def session_id() -> str:
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    return f"{stamp}-{uuid.uuid4().hex[:8]}"


def safe_session_id(value: str) -> str:
    if (
        not value
        or len(value) > 80
        or any(character not in SESSION_ID_CHARS for character in value)
        or value in {".", ".."}
    ):
        raise ValueError("Session ID contains unsafe characters.")
    return value


def run_git(*args: str) -> str:
    result = subprocess.run(
        ["git", *args],
        cwd=str(REPO_ROOT),
        capture_output=True,
        text=True,
        timeout=15,
        check=True,
        creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0),
    )
    return result.stdout.strip()


def build_metadata(executable: Path, config: Path) -> dict[str, Any]:
    try:
        commit = run_git("rev-parse", "HEAD")
        dirty = bool(run_git("status", "--porcelain"))
    except (OSError, subprocess.SubprocessError):
        commit = "unavailable"
        dirty = True
    return {
        "gitCommit": commit,
        "gitDirty": dirty,
        "desktopExe": str(executable),
        "desktopExeSha256": sha256_file(executable),
        "configSha256": sha256_file(config),
        "pythonVersion": sys.version.split()[0],
    }


def manifest_path(identifier: str) -> Path:
    return EVIDENCE_ROOT / safe_session_id(identifier) / "session.json"


def save_session(session: dict[str, Any]) -> None:
    session["updatedAt"] = utc_now()
    atomic_write_json(Path(session["evidenceRoot"]) / "session.json", session)


def load_session(identifier: str) -> dict[str, Any]:
    value = load_json(manifest_path(identifier))
    if not isinstance(value, dict) or value.get("schemaVersion") != 1:
        raise ValueError("Session manifest is invalid.")
    if value.get("sessionId") != identifier:
        raise ValueError("Session manifest identity mismatched.")
    return value


def create_session(args: argparse.Namespace) -> dict[str, Any]:
    identifier = safe_session_id(args.session_id or session_id())
    evidence_root = (EVIDENCE_ROOT / identifier).resolve()
    state_directory = (STATE_ROOT / identifier).resolve()
    if evidence_root.exists() or state_directory.exists():
        raise FileExistsError(f"Dogfood session already exists: {identifier}")
    executable = Path(args.exe).resolve()
    project = Path(args.project).resolve()
    config = Path(args.config).resolve()
    if not executable.is_file():
        raise FileNotFoundError(f"Packaged HoneyBee executable not found: {executable}")
    if not project.is_dir():
        raise FileNotFoundError(f"Unity project not found: {project}")
    if not config.is_file():
        raise FileNotFoundError(f"HoneyBee batch config not found: {config}")
    expected = args.expected_works
    if expected is None:
        expected = 1 if args.mode == "sequential" else 3
    if expected < 1 or expected > 4:
        raise ValueError("Dogfood expected Works must be between 1 and 4.")
    evidence_root.mkdir(parents=True)
    user_data = state_directory / "user-data"
    user_data.mkdir(parents=True)
    session: dict[str, Any] = {
        "schemaVersion": 1,
        "sessionId": identifier,
        "createdAt": utc_now(),
        "updatedAt": utc_now(),
        "mode": args.mode,
        "workloadId": args.workload_id,
        "expectedWorks": expected,
        "projectPath": str(project),
        "configPath": str(config),
        "exePath": str(executable),
        "evidenceRoot": str(evidence_root),
        "stateDirectory": str(state_directory),
        "userData": str(user_data),
        "stateRoot": str(user_data / "runtime" / "runs"),
        "build": build_metadata(executable, config),
        "segments": [],
        "desktopProcesses": [],
    }
    save_session(session)
    preflight = run_runtime_probe(REPO_ROOT, session, [], [])
    atomic_write_json(evidence_root / "preflight-doctor.json", preflight.get("doctor", preflight))
    return session


def process_identity(pid: int) -> str | None:
    observation = observe_process(pid, None)
    identity = observation.get("actualIdentity")
    return identity if isinstance(identity, str) else None


def desktop_alive(record: Mapping[str, Any]) -> bool:
    pid = record.get("pid")
    identity = record.get("processIdentity")
    if not isinstance(pid, int) or not isinstance(identity, str):
        return False
    return observe_process(pid, identity).get("status") == "alive-original"


def print_instructions(session: Mapping[str, Any]) -> None:
    print(f"\nHoneyBee dogfood session: {session['sessionId']}")
    print(f"Project: {session['projectPath']}")
    print(f"Config: {session['configPath']}")
    print("\nDesktop에서 다음 순서로 진행하세요:")
    print("  1. Project와 v0.6 batch config 선택")
    print("  2. Doctor 통과")
    print(f"  3. {session['expectedWorks']} Works 생성 후 compile/warm-test와 Editor Pool 확인")
    if session["mode"] == "parallel" and session["expectedWorks"] >= 3:
        print("  4. Patch B Reject → Patch A Apply → 남은 Patch drift 확인 후 Reject")
    else:
        print("  4. Diff 확인 후 Patch Apply 또는 Reject")
    print("  5. cleanup 완료 후 Desktop 종료")
    print("\nCtrl+C는 observer만 중단하며 HoneyBee/Unity 프로세스를 종료하지 않습니다.\n")


def progress_snapshot(session: Mapping[str, Any]) -> str:
    journals, _ = load_journals(Path(str(session["stateRoot"])))
    event_count = sum(len(events) for events in journals.values())
    terminal_count = sum(
        1
        for events in journals.values()
        if events and events[-1].get("type") in {"workflow.completed", "workflow.failed", "workflow.cancelled"}
    )
    return f"runs={len(journals)} events={event_count} terminal={terminal_count}"


def new_segment(session: dict[str, Any], kind: str) -> dict[str, Any]:
    segment = {
        "segmentId": str(uuid.uuid4()),
        "kind": kind,
        "startedAt": utc_now(),
        "endedAt": None,
    }
    session["segments"].append(segment)
    return segment


def close_segment(
    session: dict[str, Any],
    segment: dict[str, Any],
    reason: str,
    *,
    exit_code: int | None = None,
) -> None:
    segment["endedAt"] = utc_now()
    segment["reason"] = reason
    if exit_code is not None:
        segment["exitCode"] = exit_code
    save_session(session)


def monitor_desktop(
    session: dict[str, Any],
    segment: dict[str, Any],
    record: dict[str, Any],
    process: subprocess.Popen[bytes] | None,
) -> str:
    print_instructions(session)
    last_progress = 0.0
    try:
        while True:
            alive = process.poll() is None if process is not None else desktop_alive(record)
            if not alive:
                exit_code = process.returncode if process is not None else None
                close_segment(session, segment, "desktop-exited", exit_code=exit_code)
                print(f"Desktop exited. {progress_snapshot(session)}")
                return "desktop-exited"
            now = time.monotonic()
            if now - last_progress >= 10:
                print(f"[observer] {progress_snapshot(session)}", flush=True)
                last_progress = now
            time.sleep(1)
    except KeyboardInterrupt:
        close_segment(session, segment, "observer-interrupted")
        print(
            "\nObserver만 중단했습니다. Desktop과 Unity 프로세스는 그대로 둡니다.\n"
            f"재연결: py dogfood/session.py resume {session['sessionId']}"
        )
        return "observer-interrupted"


def launch_desktop(session: dict[str, Any]) -> str:
    evidence_root = Path(str(session["evidenceRoot"]))
    stdout_path = evidence_root / "desktop.stdout.log"
    stderr_path = evidence_root / "desktop.stderr.log"
    segment = new_segment(session, "launch")
    creation_flags = getattr(subprocess, "CREATE_NEW_PROCESS_GROUP", 0)
    with stdout_path.open("ab") as stdout, stderr_path.open("ab") as stderr:
        process = subprocess.Popen(
            [
                str(session["exePath"]),
                f"--user-data-dir={session['userData']}",
                "--enable-logging=stderr",
            ],
            cwd=str(Path(str(session["exePath"])).parent),
            stdin=subprocess.DEVNULL,
            stdout=stdout,
            stderr=stderr,
            creationflags=creation_flags,
        )
        identity = None
        for _ in range(20):
            identity = process_identity(process.pid)
            if identity is not None or process.poll() is not None:
                break
            time.sleep(0.1)
        record = {
            "pid": process.pid,
            "processIdentity": identity,
            "launchedAt": utc_now(),
        }
        session["desktopProcesses"].append(record)
        segment["desktopPid"] = process.pid
        save_session(session)
        return monitor_desktop(session, segment, record, process)


def resume_session(identifier: str) -> str:
    session = load_session(safe_session_id(identifier))
    processes = session.get("desktopProcesses", [])
    active = next(
        (
            record
            for record in reversed(processes)
            if isinstance(record, dict) and desktop_alive(record)
        ),
        None,
    )
    if active is None:
        print("기존 Desktop 프로세스가 없어 같은 격리 userData로 다시 실행합니다.")
        return launch_desktop(session)
    segment = new_segment(session, "attach")
    segment["desktopPid"] = active["pid"]
    save_session(session)
    return monitor_desktop(session, segment, active, None)


def finalize_session(identifier: str) -> dict[str, Any]:
    session = load_session(safe_session_id(identifier))
    if "finalizedAt" not in session:
        session["finalizedAt"] = utc_now()
        save_session(session)
    metrics = write_evidence(REPO_ROOT, session)
    print(
        f"Evidence: {session['evidenceRoot']}\n"
        f"Verdict: {metrics['verdict']} / residuals={metrics['residuals']['total']}"
    )
    return metrics


def comparison_payload(
    baseline: Mapping[str, Any], candidate: Mapping[str, Any]
) -> dict[str, Any]:
    baseline_workload = baseline.get("scenario", {}).get("workloadId")
    candidate_workload = candidate.get("scenario", {}).get("workloadId")
    if baseline_workload != candidate_workload:
        raise ValueError("Comparison requires the same workloadId.")
    if baseline.get("scenario", {}).get("mode") != "sequential":
        raise ValueError("Baseline session must use sequential mode.")
    if candidate.get("scenario", {}).get("mode") != "parallel":
        raise ValueError("Candidate session must use parallel mode.")

    def throughput(metrics: Mapping[str, Any], name: str) -> float | None:
        value = metrics.get("aggregate", {}).get(name)
        return float(value) if isinstance(value, (int, float)) else None

    baseline_rate = throughput(baseline, "runtimeVerifiedChangesPerHour")
    candidate_rate = throughput(candidate, "runtimeVerifiedChangesPerHour")
    session_baseline = throughput(baseline, "sessionVerifiedChangesPerHour")
    session_candidate = throughput(candidate, "sessionVerifiedChangesPerHour")
    return {
        "schemaVersion": 1,
        "createdAt": utc_now(),
        "workloadId": baseline_workload,
        "baseline": {
            "sessionId": baseline.get("sessionId"),
            "verdict": baseline.get("verdict"),
            "verifiedChangesPerHour": baseline_rate,
            "sessionVerifiedChangesPerHour": session_baseline,
            "maxConcurrentAgents": baseline.get("concurrency", {}).get("maxConcurrentAgents"),
        },
        "candidate": {
            "sessionId": candidate.get("sessionId"),
            "verdict": candidate.get("verdict"),
            "verifiedChangesPerHour": candidate_rate,
            "sessionVerifiedChangesPerHour": session_candidate,
            "maxConcurrentAgents": candidate.get("concurrency", {}).get("maxConcurrentAgents"),
        },
        "ratios": {
            "runtimeThroughput": (
                round(candidate_rate / baseline_rate, 6)
                if candidate_rate is not None and baseline_rate
                else None
            ),
            "sessionThroughput": (
                round(session_candidate / session_baseline, 6)
                if session_candidate is not None and session_baseline
                else None
            ),
        },
    }


def render_comparison(value: Mapping[str, Any]) -> str:
    baseline = value["baseline"]
    candidate = value["candidate"]
    ratios = value["ratios"]
    return "\n".join(
        [
            f"# HoneyBee dogfood comparison: {value['workloadId']}",
            "",
            "| Session | Mode | Verdict | Runtime verified changes/hour | Max Agent concurrency |",
            "|---|---|---:|---:|---:|",
            f"| {baseline['sessionId']} | sequential | {baseline['verdict']} | {baseline['verifiedChangesPerHour']} | {baseline['maxConcurrentAgents']} |",
            f"| {candidate['sessionId']} | parallel | {candidate['verdict']} | {candidate['verifiedChangesPerHour']} | {candidate['maxConcurrentAgents']} |",
            "",
            f"- Runtime throughput ratio: **{ratios['runtimeThroughput']}x**",
            f"- Full-session throughput ratio: **{ratios['sessionThroughput']}x**",
            "",
        ]
    )


def compare_sessions(baseline_id: str, candidate_id: str) -> dict[str, Any]:
    baseline_path = manifest_path(safe_session_id(baseline_id)).parent / "metrics.json"
    candidate_path = manifest_path(safe_session_id(candidate_id)).parent / "metrics.json"
    baseline = load_json(baseline_path)
    candidate = load_json(candidate_path)
    comparison = comparison_payload(baseline, candidate)
    output_root = EVIDENCE_ROOT / "comparisons"
    stem = f"{baseline_id}--{candidate_id}"
    atomic_write_json(output_root / f"{stem}.json", comparison)
    atomic_write_text(output_root / f"{stem}.md", render_comparison(comparison))
    print(render_comparison(comparison))
    return comparison


def parser() -> argparse.ArgumentParser:
    value = argparse.ArgumentParser(
        description="HoneyBee Desktop dogfood launcher and read-only Evidence observer."
    )
    commands = value.add_subparsers(dest="command", required=True)

    run = commands.add_parser("run", help="Create an isolated session and launch HoneyBee.exe.")
    run.add_argument("--exe", default=str(DEFAULT_EXE), help="Packaged HoneyBee.exe path.")
    run.add_argument("--project", required=True, help="Unity project path.")
    run.add_argument("--config", required=True, help="Immutable HoneyBee batch config path.")
    run.add_argument("--mode", choices=("sequential", "parallel"), required=True)
    run.add_argument("--workload-id", required=True, help="Stable comparison workload identity.")
    run.add_argument("--expected-works", type=int)
    run.add_argument("--session-id")

    resume = commands.add_parser("resume", help="Reconnect or relaunch an existing session.")
    resume.add_argument("session_id")

    finalize = commands.add_parser(
        "finalize", help="Re-read authoritative state and write metrics/Evidence."
    )
    finalize.add_argument("session_id")

    compare = commands.add_parser(
        "compare", help="Compare matching sequential and parallel finalized sessions."
    )
    compare.add_argument("--baseline", required=True, help="Sequential session ID.")
    compare.add_argument("--candidate", required=True, help="Parallel session ID.")
    return value


def main(argv: Sequence[str] | None = None) -> int:
    args = parser().parse_args(argv)
    try:
        if args.command == "run":
            session = create_session(args)
            reason = launch_desktop(session)
            if reason == "desktop-exited":
                metrics = finalize_session(str(session["sessionId"]))
                return 0 if metrics.get("verdict") == "pass" else 2
            return 0
        if args.command == "resume":
            reason = resume_session(args.session_id)
            if reason == "desktop-exited":
                metrics = finalize_session(args.session_id)
                return 0 if metrics.get("verdict") == "pass" else 2
            return 0
        if args.command == "finalize":
            metrics = finalize_session(args.session_id)
            return 0 if metrics.get("verdict") == "pass" else 2
        if args.command == "compare":
            compare_sessions(args.baseline, args.candidate)
            return 0
        raise AssertionError("Unhandled command.")
    except (OSError, ValueError, KeyError, json.JSONDecodeError) as error:
        print(f"dogfood: {type(error).__name__}: {error}", file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
