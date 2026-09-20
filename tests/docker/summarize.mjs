import console from "node:console";
import process from "node:process";
import { readFileSync } from "node:fs";

const bytes = readFileSync(process.argv[2]);
const ansiColor = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "gu");
const log = bytes.toString(bytes[0] === 0xff ? "utf16le" : "utf8").replace(ansiColor, "");
const go = new Map();
let stages;
let coverage;
const nodeEvents = [];
for (const line of log.split(/\r?\n/u)) {
  if (!line.startsWith("{")) continue;
  let event;
  try {
    event = JSON.parse(line);
  } catch {
    continue;
  }
  if (event.portableVerification) {
    stages = event.results;
    coverage = event.coverage;
  }
  if (event.nodeTest) nodeEvents.push(event.nodeTest);
  if (event.Test && ["pass", "skip", "fail"].includes(event.Action)) {
    go.set(`${event.Package}:${event.Test}`, { test: event.Test, outcome: event.Action });
  }
}
const counts = (events) =>
  Object.fromEntries(
    ["pass", "skip", "fail"].map((outcome) => [
      outcome,
      events.filter((event) => event.outcome === outcome).length,
    ]),
  );
const number = (pattern) => {
  const match = pattern.exec(log);
  return match ? Number(match[1]) : null;
};
console.log(
  JSON.stringify(
    {
      nativeWindowsQualification: false,
      vitest: {
        passed: number(/Tests\s+(\d+) passed/u),
        skipped: number(/Tests\s+\d+ passed \| (\d+) skipped/u),
      },
      node: {
        passed: nodeEvents.length
          ? nodeEvents.filter((event) => event.type === "test:pass" && !event.skip).length
          : number(/ℹ pass (\d+)/u),
        skipped: nodeEvents.length
          ? nodeEvents.filter((event) => event.skip).length
          : number(/ℹ skipped (\d+)/u),
        failed: nodeEvents.length
          ? nodeEvents.filter((event) => event.type === "test:fail").length
          : number(/ℹ fail (\d+)/u),
      },
      python: { tests: number(/Ran (\d+) tests/u) },
      goTopLevel: counts([...go.values()].filter((event) => !event.test.includes("/"))),
      goIncludingSubtests: counts([...go.values()]),
      skippedGo: [...go.entries()]
        .filter(([, event]) => event.outcome === "skip")
        .map(([test]) => test),
      stages,
      coverage,
    },
    null,
    2,
  ),
);
