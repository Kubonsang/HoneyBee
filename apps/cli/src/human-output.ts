import { type DoctorReportV1, WorkspaceCoreError, type WorkspaceViewV1 } from "@honeybee/core";

const table = (headers: readonly string[], rows: readonly (readonly string[])[]): string => {
  const widths = headers.map((header, column) =>
    Math.max(header.length, ...rows.map((row) => (row[column] ?? "").length)),
  );
  const line = (values: readonly string[]): string =>
    values
      .map((value, column) =>
        column === values.length - 1 ? value : value.padEnd(widths[column] ?? value.length),
      )
      .join("  ")
      .trimEnd();
  return [line(headers), ...rows.map(line)].join("\n");
};

const changeLabel = (workspace: WorkspaceViewV1): string => {
  if (workspace.git === undefined) return "unavailable";
  const count = workspace.git.changes.length;
  return count === 0 ? "clean" : `${count} file${count === 1 ? "" : "s"}`;
};

export const formatWorkspaceList = (workspaces: readonly WorkspaceViewV1[]): string =>
  workspaces.length === 0
    ? "No Workspaces."
    : table(
        ["NAME", "BRANCH", "STATE", "CHANGES"],
        workspaces.map((workspace) => [
          workspace.name,
          workspace.branch,
          workspace.state,
          changeLabel(workspace),
        ]),
      );

export const formatWorkspaceStatus = (workspace: WorkspaceViewV1): string => {
  const values = [
    ["Workspace", workspace.name],
    ["Branch", workspace.git?.branch ?? workspace.branch],
    ["HEAD", workspace.git?.head.slice(0, 7) ?? "unavailable"],
    ["State", workspace.state],
    ["Git", workspace.git === undefined ? "unavailable" : workspace.git.dirty ? "dirty" : "clean"],
    ["Changes", changeLabel(workspace)],
    ["Library", workspace.libraryConnected ? "connected" : "disconnected"],
    ["Path", workspace.workspacePath],
  ] as const;
  const width = Math.max(...values.map(([label]) => label.length));
  return values.map(([label, value]) => `${label.padEnd(width)}  ${value}`).join("\n");
};

export const formatWorkspaceCreated = (
  workspace: WorkspaceViewV1,
  action: "Created" | "Attached",
): string =>
  [
    `${action} Workspace ${workspace.name}.`,
    `Branch  ${workspace.branch}`,
    `State   ${workspace.state}`,
    `Path    ${workspace.workspacePath}`,
    "",
    "Next:",
    `  cd "${workspace.workspacePath}"`,
  ].join("\n");

export const formatDoctor = (report: DoctorReportV1): string => {
  const checks = report.checks.flatMap((item) => {
    const subject = item.subject === undefined ? "" : ` [${item.subject}]`;
    const lines = [
      `${item.status.toUpperCase().padEnd(7)} ${item.code}${subject}  ${item.message}`,
    ];
    if (item.remediation !== undefined) {
      lines.push(...item.remediation.map((line) => `        ${line}`));
    }
    return lines;
  });
  return [
    ...checks,
    "",
    `Ready: ${report.ready ? "yes" : "no"} (${report.summary.pass} pass, ${report.summary.warning} warning, ${report.summary.fail} fail)`,
  ].join("\n");
};

export const formatError = (error: unknown): string => {
  if (error instanceof WorkspaceCoreError) {
    return [
      `Error [${error.code}]`,
      "",
      error.message,
      ...(error.remediation.length === 0 ? [] : ["", ...error.remediation]),
    ].join("\n");
  }
  return [
    "Error [cli.invalid-request]",
    "",
    error instanceof Error ? error.message : String(error),
  ].join("\n");
};
