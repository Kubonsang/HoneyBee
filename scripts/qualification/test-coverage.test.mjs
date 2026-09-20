import assert from "node:assert/strict";
import test from "node:test";
import path from "node:path";
import { auditCoverage, jsonObjects } from "./test-coverage.mjs";

const root = path.resolve(".");
function fixture() {
  return {
    root,
    platform: "linux",
    vitest: {
      testResults: [
        {
          name: path.join(root, "packages/core/src/a.test.ts"),
          assertionResults: [{ title: "portable", status: "passed" }],
        },
      ],
    },
    nodeLog: JSON.stringify({
      nodeTest: {
        type: "test:pass",
        file: path.join(root, "scripts/update/a.test.mjs"),
        name: "case",
      },
    }),
    goLogs: [],
  };
}
test("unexplained skips cannot pass coverage audit", () => {
  const input = fixture();
  input.vitest.testResults[0].assertionResults[0].status = "pending";
  assert.equal(auditCoverage(input).unexpectedSkips, 1);
});
test("Windows lifecycle skip is assigned to Windows, not counted as pass", () => {
  const input = fixture();
  const event = JSON.parse(input.nodeLog);
  event.nodeTest.skip = "windows-native: lifecycle";
  input.nodeLog = JSON.stringify(event);
  const result = auditCoverage(input);
  assert.equal(result.deferred[0].owner, "windows");
  assert.equal(result.passed.length, 1);
  input.platform = "win32";
  assert.equal(auditCoverage(input).unexpectedSkips, 1);
});
test("zero results are not a test pass", () => {
  const input = fixture();
  input.nodeLog = "";
  assert.throws(() => auditCoverage(input));
});
test("Unix native filesystem exclusions are explicit and not Windows passes", () => {
  const input = fixture();
  input.goLogs.push(
    JSON.stringify({
      Action: "skip",
      Package: "upstream",
      Test: "TestUnixBackendAcquireIsolationAndRelease",
    }),
  );
  assert.equal(auditCoverage(input).outOfScope.length, 1);
  assert.equal(auditCoverage(input).unexpectedSkips, 0);
});
test("Go platform inventory preserves quoted braces and refuses truncation", () => {
  assert.deepEqual(jsonObjects('{"Doc":"brace } and {"}\n{"ImportPath":"p"}'), [
    { Doc: "brace } and {" },
    { ImportPath: "p" },
  ]);
  assert.throws(() => jsonObjects('{"Dir":"incomplete"'));
});
test("Windows build-tagged tests require owning-lane evidence", () => {
  const input = fixture();
  input.ignoredGoTests = [
    { package: "p", name: "TestWindowsOnly" },
    { package: "p", name: "TestExternalBeeNativeLifecycle" },
  ];
  const result = auditCoverage(input);
  assert.deepEqual(
    result.deferred.map((item) => item.owner),
    ["windows", "native"],
  );
});
