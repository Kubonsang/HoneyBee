import * as vscode from "vscode";

import {
  GlobalStateDraftRepository,
  GlobalStateSelectionRepository,
  GlobalStateSessionRepository,
} from "./adapters/global-state-repositories.js";
import {
  JsonlRuntimeClient,
  NodeChildProcessRuntimeTransport,
} from "./adapters/jsonl-runtime-client.js";
import { resolveRuntimeLaunch } from "./adapters/runtime-launch.js";
import {
  ConfiguredAgentProfileResolver,
  RandomIdGenerator,
  SystemClock,
} from "./adapters/system-adapters.js";
import { ConsoleApplicationService } from "./application/console-service.js";
import { SessionSelectionService } from "./application/session-selection.js";
import { SessionApplicationService } from "./application/session-service.js";
import { ConsoleViewProvider } from "./presentation/console-view-provider.js";
import { registerSessionCommands } from "./presentation/session-commands.js";
import { SessionTreeProvider } from "./presentation/session-tree-provider.js";

const readStringArray = (
  configuration: vscode.WorkspaceConfiguration,
  key: string,
): readonly string[] => configuration.get<readonly string[]>(key, []);

interface ConfigurationInspection<T> {
  readonly globalValue?: T;
  readonly workspaceValue?: T;
  readonly workspaceFolderValue?: T;
}

const hasExplicitConfiguration = <T>(inspected: ConfigurationInspection<T> | undefined): boolean =>
  inspected !== undefined &&
  [inspected.globalValue, inspected.workspaceValue, inspected.workspaceFolderValue].some(
    (value) => value !== undefined,
  );

const processEnvironment = (): Readonly<Record<string, string>> => {
  const environment: Record<string, string> = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value !== undefined) {
      environment[key] = value;
    }
  }
  return environment;
};

export const activate = async (context: vscode.ExtensionContext): Promise<void> => {
  const output = vscode.window.createOutputChannel("Honey Bee");
  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[error] ${message}`);
    vscode.window.showErrorMessage(`Honey Bee: ${message}`);
  };
  const reportPromptDiagnostic = (message: string): void => {
    output.appendLine(`[prompt] ${message}`);
  };

  const sessions = new GlobalStateSessionRepository(context.globalState);
  const drafts = new GlobalStateDraftRepository(context.globalState);
  const selectionState = new GlobalStateSelectionRepository(context.globalState);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();
  const sessionService = new SessionApplicationService(sessions, drafts, clock, ids);
  const restoredSessionId = await selectionState.restore(await sessionService.list());
  const selection = new SessionSelectionService(restoredSessionId);
  const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
  const workspacePath = workspaceFolder?.uri.fsPath ?? process.cwd();
  const runtimeConfiguration = vscode.workspace.getConfiguration("honeyBee.runtime");
  const runtimeLaunch = resolveRuntimeLaunch({
    extensionRoot: context.extensionUri.fsPath,
    configuredCommand: runtimeConfiguration.get<string>("command", "node"),
    configuredArgs: readStringArray(runtimeConfiguration, "args"),
    usePackagedDefault:
      !hasExplicitConfiguration(runtimeConfiguration.inspect<string>("command")) &&
      !hasExplicitConfiguration(runtimeConfiguration.inspect<readonly string[]>("args")),
  });
  const transport = new NodeChildProcessRuntimeTransport({
    command: runtimeLaunch.command,
    args: runtimeLaunch.args,
    cwd: workspacePath,
    environment: process.env,
    onDiagnostic: (message) => {
      output.append(message);
    },
  });
  const runtime = new JsonlRuntimeClient(
    transport,
    ids,
    runtimeConfiguration.get<number>("requestTimeoutMs", 10_000),
  );
  const profiles = new ConfiguredAgentProfileResolver(() => {
    const agentConfiguration = vscode.workspace.getConfiguration("honeyBee.agent");
    return {
      command: agentConfiguration.get<string>("command", "codex"),
      args: readStringArray(agentConfiguration, "args"),
      cwd: workspacePath,
      environment: processEnvironment(),
      shell: false,
    };
  });
  const consoleService = new ConsoleApplicationService(
    sessions,
    drafts,
    selection,
    runtime,
    profiles,
    clock,
  );
  const tree = new SessionTreeProvider(sessionService);
  const consoleView = new ConsoleViewProvider(
    context.extensionUri,
    consoleService,
    reportError,
    reportPromptDiagnostic,
  );

  context.subscriptions.push(
    output,
    tree,
    consoleView,
    selection.onDidSelect((sessionId) => {
      void selectionState.save(sessionId).catch(reportError);
    }),
    vscode.window.registerTreeDataProvider("honeyBee.sessions", tree),
    vscode.window.registerWebviewViewProvider("honeyBee.console", consoleView, {
      webviewOptions: { retainContextWhenHidden: true },
    }),
    consoleService.onMessage((message) => {
      if (message.type === "console.state") {
        tree.refresh();
      }
    }),
    {
      dispose: () => {
        consoleService.dispose();
      },
    },
  );

  registerSessionCommands(context, {
    service: sessionService,
    selection,
    consoleService,
    tree,
    consoleView,
    defaultAgentProfile: () =>
      vscode.workspace.getConfiguration("honeyBee.agent").get<string>("defaultProfile", "codex"),
    defaultToolProfile: () =>
      vscode.workspace.getConfiguration("honeyBee.tool").get<string>("defaultProfile", "default"),
    reportError,
  });

  await tree.load();
  if (restoredSessionId !== undefined) {
    await consoleService.select(restoredSessionId);
  }
  consoleService.initialize().catch(reportError);
};

export const deactivate = (): void => {};
