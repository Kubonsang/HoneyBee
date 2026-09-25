import assert from "node:assert/strict";
import path from "node:path";

const windowsVitest = new Set([
  "packages/core/src/installed-activity.test.ts:shared application leases coexist and release idempotently",
  "packages/core/src/installed-activity.test.ts:real CLI entry refuses an exclusive updater and runs after release",
  "apps/desktop/src/main/pty-session-manager.test.ts:opens an interactive PowerShell in the selected Workspace",
]);
const nativeGo = new Set([
  "TestExternalBeeNativeLifecycle",
  "TestInstalledUserCanWriteMountedParent",
  "TestDifferencingChildGeometry",
  "TestDifferencingParentLongPath",
  "TestNativeChildGeometry",
]);
const unixGo = new Set([
  "TestNativeManagerRestartRecoversLiveLease",
  "TestNativeManagerRestartCleansDeadClientLease",
  "TestDaemonNativeCoWTwoChildIsolationAndRelease",
  "TestUnixBackendAcquireIsolationAndRelease",
  "TestUnixBackendRestoresExistingMountDirectoryPermissionBits",
  "TestUnixBackendRefusesReplacedChild",
  "TestUnixLeaseSnapshotRecoversExactOwnedLease",
  "TestUnixLeaseRecoveryRefusesReplacedMount",
]);
const historicalDiagnostics = new Set([
  "TestMaintenanceParentAttachmentDiagnostic",
  "TestMaintenanceQuiesceIsolatedDiagnostic",
  "TestMaintenanceQuiesceSystemDiagnostic",
  "TestMaintenanceQuiesceFixtureOwner",
  "TestMaintenanceVolumeExtentDiagnostic",
]);
const launcherGo = new Set([
  "TestSuccessfulHandoffRevalidatesAndPreservesArguments",
  "TestZeroExitWithoutRecoveryDoesNotLaunch",
]);

export function auditCoverage({ vitest, nodeLog, goLogs, platform, root, ignoredGoTests = [] }) {
  const passed = new Set(),
    deferred = new Map(),
    outOfScope = [],
    unexpected = [];
  const relative = (file) => path.relative(root, file).replaceAll("\\", "/");
  const skip = (id, owner, reason) =>
    owner ? deferred.set(id, { id, owner, reason }) : unexpected.push({ id, reason });
  assert(vitest?.testResults?.length > 0, "Vitest result missing/empty");
  for (const suite of vitest.testResults)
    for (const result of suite.assertionResults) {
      const key = `${relative(suite.name)}:${result.title}`;
      const id = `vitest:${key}`;
      if (result.status === "passed") passed.add(id);
      else if (["pending", "skipped", "todo", "disabled"].includes(result.status))
        skip(
          id,
          platform !== "win32" && windowsVitest.has(key) ? "windows" : null,
          "Windows API required",
        );
      else unexpected.push({ id, reason: result.status });
    }
  let nodeCount = 0;
  for (const line of nodeLog.split(/\r?\n/u)) {
    let event;
    try {
      event = JSON.parse(line).nodeTest;
    } catch {
      continue;
    }
    if (!event) continue;
    nodeCount++;
    const id = `node:${relative(event.file)}:${event.name}`;
    if (event.skip)
      skip(
        id,
        platform !== "win32" &&
          ["windows-native: lifecycle", "windows-native: dpapi"].includes(event.skip)
          ? "windows"
          : null,
        event.skip,
      );
    else if (event.type === "test:pass" && !event.todo) passed.add(id);
    else unexpected.push({ id, reason: event.type });
  }
  assert(nodeCount > 0, "Node results missing/empty");
  for (const log of goLogs)
    for (const line of log.split(/\r?\n/u)) {
      let event;
      try {
        event = JSON.parse(line);
      } catch {
        continue;
      }
      if (!event.Test) continue;
      const id = `go:${event.Package}:${event.Test}`;
      if (event.Action === "pass") passed.add(id);
      if (event.Action === "skip") {
        if (unixGo.has(event.Test))
          outOfScope.push({
            id,
            reason: "Upstream Unix CoW backend; not Windows product acceptance",
          });
        else if (historicalDiagnostics.has(event.Test))
          outOfScope.push({
            id,
            reason:
              "Opt-in diagnostic bound to retired DESKTOP-9LT0JVV; fixed recovery gates remain required",
          });
        else
          skip(
            id,
            nativeGo.has(event.Test)
              ? "native"
              : platform !== "win32" && launcherGo.has(event.Test)
                ? "windows"
                : null,
            "Native capability unavailable",
          );
      }
      if (event.Action === "fail") unexpected.push({ id, reason: "Go test failed" });
    }
  for (const item of ignoredGoTests) {
    const id = `go:${item.package}:${item.name}`;
    if (historicalDiagnostics.has(item.name))
      outOfScope.push({ id, reason: "Historical VM diagnostic, not a release gate" });
    else if (!passed.has(id) && !deferred.has(id))
      skip(
        id,
        nativeGo.has(item.name) ? "native" : "windows",
        "Windows build-tagged test not executed here",
      );
  }
  return {
    passed: [...passed],
    deferred: [...deferred.values()],
    outOfScope,
    unexpected,
    unexpectedSkips: unexpected.length,
  };
}

// go list emits adjacent JSON objects, not a JSON array. Parse without modifying
// quoted strings or assuming braces cannot occur in package documentation.
export function jsonObjects(text) {
  const result = [];
  let start = -1,
    depth = 0,
    quoted = false,
    escaped = false;
  for (let index = 0; index < text.length; index++) {
    const c = text[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (c === "\\") escaped = true;
      else if (c === '"') quoted = false;
    } else if (c === '"') quoted = true;
    else if (c === "{") {
      if (depth++ === 0) start = index;
    } else if (c === "}" && --depth === 0) result.push(JSON.parse(text.slice(start, index + 1)));
  }
  assert(depth === 0 && !quoted, "Truncated Go inventory");
  return result;
}
