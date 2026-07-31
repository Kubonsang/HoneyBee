import * as vscode from "vscode";

import { RunIdSchema, SessionIdSchema, type AgentSession, type SessionId } from "@honeybee/domain";

import type { ConsoleApplicationService } from "../application/console-service.js";
import type { SessionSelectionService } from "../application/session-selection.js";
import type { SessionApplicationService } from "../application/session-service.js";
import type { ConsoleViewProvider } from "./console-view-provider.js";
import type { SessionTreeItem, SessionTreeProvider } from "./session-tree-provider.js";

export interface SessionCommandDependencies {
  readonly service: SessionApplicationService;
  readonly selection: SessionSelectionService;
  readonly consoleService: ConsoleApplicationService;
  readonly tree: SessionTreeProvider;
  readonly consoleView: ConsoleViewProvider;
  readonly defaultAgentProfile: () => string;
  readonly defaultToolProfile: () => string;
  readonly reportError: (error: unknown) => void;
}

interface SessionQuickPickItem extends vscode.QuickPickItem {
  readonly sessionId: SessionId;
}

const asSessionId = (item: SessionTreeItem | undefined): SessionId | undefined =>
  item?.node.session.id;

const quickPickItems = (sessions: readonly AgentSession[]): readonly SessionQuickPickItem[] =>
  sessions.map((session) => ({
    label: session.title,
    description: session.status.replaceAll("_", " "),
    detail: `${session.agentProfileId} · ${session.tags.map((tag) => `#${tag}`).join(" ")}`,
    sessionId: session.id,
  }));

const pickSession = async (
  service: SessionApplicationService,
  placeHolder: string,
  excluded: ReadonlySet<SessionId> = new Set(),
): Promise<SessionId | undefined> => {
  const sessions = (await service.list()).filter((session) => !excluded.has(session.id));
  const picked = await vscode.window.showQuickPick(quickPickItems(sessions), {
    placeHolder,
    matchOnDescription: true,
    matchOnDetail: true,
  });
  return picked?.sessionId;
};

const targetSession = async (
  dependencies: SessionCommandDependencies,
  item: SessionTreeItem | undefined,
  placeHolder: string,
): Promise<SessionId | undefined> =>
  asSessionId(item) ??
  dependencies.selection.selectedSessionId ??
  pickSession(dependencies.service, placeHolder);

export const registerSessionCommands = (
  context: vscode.ExtensionContext,
  dependencies: SessionCommandDependencies,
): void => {
  const run = (work: Promise<void>): void => {
    work.catch(dependencies.reportError);
  };
  const refresh = async (): Promise<void> => {
    await dependencies.tree.load();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("honeyBee.session.refresh", () => {
      run(refresh());
    }),
    vscode.commands.registerCommand("honeyBee.session.create", () => {
      run(
        (async () => {
          const title = await vscode.window.showInputBox({
            title: "Create Honey Bee Session",
            prompt: "Session title",
            placeHolder: "Investigate failing Unity tests",
            validateInput: (value) =>
              value.trim().length === 0 ? "A session title is required." : undefined,
          });
          if (title === undefined) {
            return;
          }
          const created = await dependencies.service.create({
            title,
            agentProfileId: dependencies.defaultAgentProfile(),
            toolProfileId: dependencies.defaultToolProfile(),
          });
          await refresh();
          dependencies.selection.select(created.id);
          await vscode.commands.executeCommand("honeyBee.console.focus");
          dependencies.consoleView.reveal();
        })(),
      );
    }),
    vscode.commands.registerCommand(
      "honeyBee.session.select",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a session to open");
            if (sessionId === undefined) {
              return;
            }
            dependencies.selection.select(sessionId);
            await vscode.commands.executeCommand("honeyBee.console.focus");
            dependencies.consoleView.reveal();
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.rename",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a session to rename");
            if (sessionId === undefined) {
              return;
            }
            const session = await dependencies.service.get(sessionId);
            const title = await vscode.window.showInputBox({
              title: "Rename Session",
              value: session.title,
              validateInput: (value) =>
                value.trim().length === 0 ? "A session title is required." : undefined,
            });
            if (title === undefined || title === session.title) {
              return;
            }
            await dependencies.service.rename(sessionId, title);
            await refresh();
            if (dependencies.selection.selectedSessionId === sessionId) {
              await dependencies.consoleService.select(sessionId);
            }
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.delete",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a session to delete");
            if (sessionId === undefined) {
              return;
            }
            const session = await dependencies.service.get(sessionId);
            const answer = await vscode.window.showWarningMessage(
              `Delete "${session.title}"? Parent and related links will be detached.`,
              { modal: true },
              "Delete",
            );
            if (answer !== "Delete") {
              return;
            }
            await dependencies.service.delete(sessionId);
            if (dependencies.selection.selectedSessionId === sessionId) {
              dependencies.selection.select(undefined);
            }
            await refresh();
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.addTag",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a session to tag");
            if (sessionId === undefined) {
              return;
            }
            const tag = await vscode.window.showInputBox({
              title: "Add Session Tag",
              prompt: "Tag (1–64 characters)",
              validateInput: (value) =>
                value.trim().length === 0 ? "A tag is required." : undefined,
            });
            if (tag === undefined) {
              return;
            }
            await dependencies.service.addTag(sessionId, tag);
            await refresh();
            if (dependencies.selection.selectedSessionId === sessionId) {
              await dependencies.consoleService.select(sessionId);
            }
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.renameTag",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a tagged session");
            if (sessionId === undefined) {
              return;
            }
            const session = await dependencies.service.get(sessionId);
            const currentTag = await vscode.window.showQuickPick([...session.tags], {
              title: "Rename Session Tag",
            });
            if (currentTag === undefined) {
              return;
            }
            const replacement = await vscode.window.showInputBox({
              title: `Rename #${currentTag}`,
              value: currentTag,
              validateInput: (value) =>
                value.trim().length === 0 ? "A tag is required." : undefined,
            });
            if (replacement === undefined || replacement === currentTag) {
              return;
            }
            await dependencies.service.renameTag(sessionId, currentTag, replacement);
            await refresh();
            if (dependencies.selection.selectedSessionId === sessionId) {
              await dependencies.consoleService.select(sessionId);
            }
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.deleteTag",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select a tagged session");
            if (sessionId === undefined) {
              return;
            }
            const session = await dependencies.service.get(sessionId);
            const tag = await vscode.window.showQuickPick([...session.tags], {
              title: "Delete Session Tag",
            });
            if (tag === undefined) {
              return;
            }
            await dependencies.service.deleteTag(sessionId, tag);
            await refresh();
            if (dependencies.selection.selectedSessionId === sessionId) {
              await dependencies.consoleService.select(sessionId);
            }
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.setParent",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select the child session");
            if (sessionId === undefined) {
              return;
            }
            const candidates = (await dependencies.service.list()).filter(
              (session) => session.id !== sessionId,
            );
            const noParent: vscode.QuickPickItem = {
              label: "$(remove-close) No parent",
              description: "Move to the session tree root",
            };
            const picked = await vscode.window.showQuickPick(
              [noParent, ...quickPickItems(candidates)],
              { title: "Set Parent Session" },
            );
            if (picked === undefined) {
              return;
            }
            const parentId =
              "sessionId" in picked
                ? SessionIdSchema.parse((picked as SessionQuickPickItem).sessionId)
                : undefined;
            await dependencies.service.setParent(sessionId, parentId);
            await refresh();
          })(),
        );
      },
    ),
    vscode.commands.registerCommand(
      "honeyBee.session.toggleRelated",
      (item: SessionTreeItem | undefined) => {
        run(
          (async () => {
            const sessionId = await targetSession(dependencies, item, "Select the source session");
            if (sessionId === undefined) {
              return;
            }
            const relatedId = await pickSession(
              dependencies.service,
              "Select a session to add or remove as related",
              new Set([sessionId]),
            );
            if (relatedId === undefined) {
              return;
            }
            await dependencies.service.toggleRelated(sessionId, relatedId);
            await refresh();
            if (dependencies.selection.selectedSessionId === sessionId) {
              await dependencies.consoleService.select(sessionId);
            }
          })(),
        );
      },
    ),
    vscode.commands.registerCommand("honeyBee.console.start", () => {
      const selected = dependencies.selection.selectedSessionId;
      if (selected !== undefined) {
        run(dependencies.consoleService.start(selected));
      }
    }),
    vscode.commands.registerCommand("honeyBee.console.interrupt", () => {
      const selected = dependencies.selection.selectedSessionId;
      const selectedRun = dependencies.consoleService.state.selectedRun;
      if (
        selected !== undefined &&
        selectedRun?.sessionId === selected &&
        dependencies.consoleService.state.canInterrupt
      ) {
        run(dependencies.consoleService.interrupt(selected, RunIdSchema.parse(selectedRun.runId)));
      }
    }),
    vscode.commands.registerCommand("honeyBee.console.stop", () => {
      const selected = dependencies.selection.selectedSessionId;
      const selectedRun = dependencies.consoleService.state.selectedRun;
      if (
        selected !== undefined &&
        selectedRun?.sessionId === selected &&
        dependencies.consoleService.state.canStop
      ) {
        run(dependencies.consoleService.stop(selected, RunIdSchema.parse(selectedRun.runId)));
      }
    }),
  );
};
