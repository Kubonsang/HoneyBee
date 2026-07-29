import * as vscode from "vscode";

import type { AgentSession } from "@honeybee/domain";

import type { SessionApplicationService } from "../application/session-service.js";
import { buildSessionTree, type SessionTreeNode } from "./session-tree-model.js";

const statusIcon = (status: AgentSession["status"]): vscode.ThemeIcon => {
  switch (status) {
    case "starting":
      return new vscode.ThemeIcon("loading~spin", new vscode.ThemeColor("charts.yellow"));
    case "running":
      return new vscode.ThemeIcon("circle-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "waiting_for_input":
      return new vscode.ThemeIcon("bell-dot", new vscode.ThemeColor("charts.yellow"));
    case "failed":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("testing.iconFailed"));
    case "completed":
      return new vscode.ThemeIcon("pass-filled", new vscode.ThemeColor("testing.iconPassed"));
    case "stopped":
      return new vscode.ThemeIcon("debug-stop");
    case "idle":
      return new vscode.ThemeIcon("circle-outline");
  }
};

export class SessionTreeItem extends vscode.TreeItem {
  public constructor(public readonly node: SessionTreeNode) {
    super(
      node.session.title,
      node.children.length > 0
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
    );
    const tags = node.session.tags.length === 0 ? "" : ` · #${node.session.tags.join(" #")}`;
    this.description = `${node.session.status.replaceAll("_", " ")}${tags}`;
    this.contextValue =
      node.session.tags.length > 0 ? "honeyBee.sessionTagged" : "honeyBee.session";
    this.iconPath = statusIcon(node.session.status);
    this.tooltip = new vscode.MarkdownString(
      [
        `**${node.session.title}**`,
        "",
        `- Status: ${node.session.status.replaceAll("_", " ")}`,
        `- Agent: ${node.session.agentProfileId}`,
        `- Workspace: ${node.session.workspaceId ?? "Current workspace"}`,
        `- Tool profile: ${node.session.toolProfileId ?? "Default"}`,
        `- Tags: ${node.session.tags.length === 0 ? "None" : node.session.tags.join(", ")}`,
      ].join("\n"),
    );
    this.command = {
      command: "honeyBee.session.select",
      title: "Open Session Console",
      arguments: [this],
    };
    this.accessibilityInformation = {
      label: `${node.session.title}, ${node.session.status.replaceAll("_", " ")}`,
      role: "treeitem",
    };
  }
}

export class SessionTreeProvider implements vscode.TreeDataProvider<SessionTreeItem> {
  readonly #changeEmitter = new vscode.EventEmitter<SessionTreeItem | undefined>();
  #roots: readonly SessionTreeNode[] = [];

  public readonly onDidChangeTreeData = this.#changeEmitter.event;

  public constructor(private readonly service: SessionApplicationService) {}

  public async load(): Promise<void> {
    this.#roots = buildSessionTree(await this.service.list());
    this.#changeEmitter.fire(undefined);
  }

  public refresh(): void {
    this.load();
  }

  public getTreeItem(element: SessionTreeItem): vscode.TreeItem {
    return element;
  }

  public getChildren(element?: SessionTreeItem): SessionTreeItem[] {
    return (element?.node.children ?? this.#roots).map((node) => new SessionTreeItem(node));
  }

  public dispose(): void {
    this.#changeEmitter.dispose();
  }
}
