import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import process from "node:process";

const MAX_PUBLIC_FILE_BYTES = 5 * 1024 * 1024;
const mode = process.argv.includes("--staged") ? "staged" : "all";

const secretRules = [
  ["private key", /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/u],
  ["AWS access key", /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/u],
  ["GitHub token", /\b(?:gh[pousr]_[A-Za-z0-9_]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/u],
  ["OpenAI API key", /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/u],
  ["Slack token", /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/u],
  ["Google API key", /\bAIza[0-9A-Za-z_-]{35}\b/u],
  ["Stripe live key", /\b[rs]k_live_[0-9A-Za-z]{16,}\b/u],
];

const forbiddenPathRules = [
  ["environment file", /(^|\/)\.env(?:\.|$)/iu],
  ["registry credentials", /(^|\/)(?:\.npmrc|\.pnpmrc|\.yarnrc|\.yarnrc\.yml|\.pypirc)$/iu],
  ["secret directory", /(^|\/)(?:\.secrets|secrets)\//iu],
  ["credential file", /(^|\/)(?:credentials[^/]*|service-account[^/]*)\.json$/iu],
  ["private key or keystore", /\.(?:pem|key|p8|p12|pfx|jks|keystore)$/iu],
  ["SSH private key", /(^|\/)id_(?:rsa|ed25519)(?:\.|$)/iu],
  ["private source document", /(^|\/)Honey_Bee_[^/]*\.docx$/iu],
  ["private documentation", /(^|\/)docs\/private\//iu],
  ["runtime state", /(^|\/)\.honeybee\//iu],
  ["generated dependency/build state", /(^|\/)(?:node_modules|dist|\.vscode-test)\//iu],
];

function git(args, encoding = "utf8") {
  return execFileSync("git", args, {
    encoding,
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function listCandidatePaths() {
  const args =
    mode === "staged"
      ? ["diff", "--cached", "--name-only", "--diff-filter=ACMR", "-z"]
      : ["ls-files", "--cached", "--others", "--exclude-standard", "-z"];
  const output = git(args, "buffer");
  return output
    .toString("utf8")
    .split("\0")
    .filter(Boolean)
    .filter((path) => mode === "staged" || existsSync(path))
    .sort((left, right) => left.localeCompare(right));
}

function readCandidate(path) {
  if (mode === "staged") {
    return git(["show", `:${path}`], "buffer");
  }
  return readFileSync(path);
}

function isBinary(buffer) {
  return buffer.subarray(0, Math.min(buffer.length, 8_192)).includes(0);
}

const findings = [];

for (const path of listCandidatePaths()) {
  const normalizedPath = path.replaceAll("\\", "/");

  for (const [ruleName, pattern] of forbiddenPathRules) {
    if (normalizedPath === ".env.example") {
      continue;
    }
    if (pattern.test(normalizedPath)) {
      findings.push(`${normalizedPath}: forbidden ${ruleName}`);
    }
  }

  const content = readCandidate(path);
  if (content.length > MAX_PUBLIC_FILE_BYTES) {
    findings.push(`${normalizedPath}: file exceeds 5 MiB public-source limit`);
    continue;
  }

  if (isBinary(content)) {
    continue;
  }

  const lines = content.toString("utf8").split(/\r?\n/u);
  for (const [ruleName, pattern] of secretRules) {
    const lineIndex = lines.findIndex((line) => pattern.test(line));
    if (lineIndex >= 0) {
      findings.push(`${normalizedPath}:${lineIndex + 1}: possible ${ruleName}`);
    }
  }
}

if (findings.length > 0) {
  process.stderr.write(
    `Security scan blocked ${findings.length} finding(s):\n${findings.map((item) => `- ${item}`).join("\n")}\n`,
  );
  process.exitCode = 1;
} else {
  process.stdout.write(`Security scan passed (${mode} content).\n`);
}
