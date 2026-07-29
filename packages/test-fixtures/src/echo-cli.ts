#!/usr/bin/env node

const ANSI_GREETING = "\u001b[32mHoney Bee Echo 벌 🐝\u001b[0m\r\n";

process.stdout.write(ANSI_GREETING);
process.stdin.setEncoding("utf8");
process.stdin.resume();

let lineBuffer = "";
let exiting = false;

const exitAfterFlush = (code: number, label: string): void => {
  if (exiting) {
    return;
  }
  exiting = true;
  process.stdin.pause();
  process.stdout.write(`${label}\r\n`, () => process.exit(code));
};

const handleLine = (line: string): void => {
  const normalized = line.trim();
  const exitMatch = /^exit\s+(-?\d+)$/u.exec(normalized);
  if (exitMatch !== null) {
    const exitCode = Number.parseInt(exitMatch[1] ?? "1", 10);
    exitAfterFlush(exitCode, `EXIT:${exitCode}`);
    return;
  }
  const burstMatch = /^burst\s+(\d+)$/u.exec(normalized);
  if (burstMatch !== null) {
    const count = Math.min(Number.parseInt(burstMatch[1] ?? "0", 10), 10000);
    process.stdout.write("x".repeat(count));
    return;
  }
  if (normalized === "unicode") {
    process.stdout.write("UTF8:한글:🐝\r\n");
  } else if (normalized === "ansi") {
    process.stdout.write("\u001b[31mANSI-RED\u001b[0m\r\n");
  } else if (normalized === "quit") {
    exitAfterFlush(0, "EXIT:0");
  }
};

process.stdin.on("data", (data: string) => {
  if (exiting) {
    return;
  }
  process.stdout.write(`ECHO:${data}`);
  lineBuffer += data;
  let lineEnd = lineBuffer.search(/[\r\n]/u);
  while (lineEnd >= 0) {
    const line = lineBuffer.slice(0, lineEnd);
    const separator = lineBuffer[lineEnd];
    const skip = separator === "\r" && lineBuffer[lineEnd + 1] === "\n" ? 2 : 1;
    lineBuffer = lineBuffer.slice(lineEnd + skip);
    handleLine(line);
    lineEnd = lineBuffer.search(/[\r\n]/u);
  }
});

process.once("SIGINT", () => exitAfterFlush(130, "INTERRUPTED"));
process.once("SIGTERM", () => exitAfterFlush(143, "TERMINATED"));
