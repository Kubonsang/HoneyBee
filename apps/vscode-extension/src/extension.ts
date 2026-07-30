import * as vscode from "vscode";

import {
  applyPromptRecoveryTestFixture,
  type PromptRecoveryExtensionTestState,
} from "./adapters/extension-test-state.js";
import { GlobalStatePromptDeliveryAttemptRepository } from "./adapters/global-state-prompt-attempt-repository.js";
import { GlobalStatePromptDeliveryReceiptRepository } from "./adapters/global-state-prompt-receipt-repository.js";
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
import {
  PromptDeliveryAttemptReconciler,
  type PromptAttemptReconciliationReport,
} from "./application/prompt-delivery-attempt-reconciler.js";
import {
  PromptDeliveryReconciler,
  type PromptDeliveryReconciliationReport,
} from "./application/prompt-delivery-reconciler.js";
import { SessionSelectionService } from "./application/session-selection.js";
import { SessionApplicationService } from "./application/session-service.js";
import { ConsoleViewProvider } from "./presentation/console-view-provider.js";
import { registerSessionCommands } from "./presentation/session-commands.js";
import { SessionTreeProvider } from "./presentation/session-tree-provider.js";

const SHUTDOWN_TIMEOUT_MS = 5_000;
let activeShutdown: (() => Promise<void>) | undefined;

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

const reportReconciliation = (
  report: PromptDeliveryReconciliationReport,
  output: vscode.OutputChannel,
): boolean => {
  let hasFailure = false;
  for (const event of report.events) {
    if (event.type === "reconciled") {
      output.appendLine(
        `[prompt] Reconciled delivered Draft for Session ${event.sessionId}, request ${event.requestId}.`,
      );
      continue;
    }
    if (event.type === "preserved") {
      output.appendLine(
        `[prompt] Preserved a newer Draft that does not match delivered receipt ${event.requestId} for Session ${event.sessionId}.`,
      );
      continue;
    }
    hasFailure = true;
    const identity =
      event.sessionId === undefined || event.requestId === undefined
        ? ""
        : ` for Session ${event.sessionId}, request ${event.requestId}`;
    output.appendLine(`[prompt] Could not reconcile delivered Draft${identity} (${event.code}).`);
  }
  if (report.prunedReceipts > 0) {
    output.appendLine(`[prompt] Pruned ${report.prunedReceipts} cleared delivery receipts.`);
  }
  return hasFailure;
};

const reportAttemptReconciliation = (
  report: PromptAttemptReconciliationReport,
  output: vscode.OutputChannel,
): boolean => {
  let hasFailure = false;
  for (const event of report.events) {
    const identity =
      event.sessionId === undefined || event.requestId === undefined
        ? ""
        : ` for Session ${event.sessionId}, request ${event.requestId}`;
    if (event.type === "failed" || event.type === "conflict") {
      hasFailure = true;
      output.appendLine(`[prompt] Attempt reconciliation ${event.code}${identity}.`);
    } else {
      output.appendLine(`[prompt] Attempt ${event.type}${identity}.`);
    }
  }
  if (report.prunedAttempts > 0) {
    output.appendLine(`[prompt] Pruned ${report.prunedAttempts} terminal delivery Attempts.`);
  }
  return hasFailure;
};
/** Extension exports are empty in production and expose sanitized recovery state in Test mode. */
export interface HoneyBeeExtensionApi {
  readonly promptRecoveryTestState?: PromptRecoveryExtensionTestState;
}
const boundedShutdown = async (work: Promise<void>, onTimeout: () => void): Promise<void> => {
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutResult = new Promise<void>((resolve) => {
    timeout = setTimeout(() => {
      onTimeout();
      resolve();
    }, SHUTDOWN_TIMEOUT_MS);
  });
  try {
    await Promise.race([work, timeoutResult]);
  } finally {
    if (timeout !== undefined) {
      clearTimeout(timeout);
    }
  }
};

export const activate = async (context: vscode.ExtensionContext): Promise<HoneyBeeExtensionApi> => {
  const output = vscode.window.createOutputChannel("Honey Bee");
  const reportError = (error: unknown): void => {
    const message = error instanceof Error ? error.message : String(error);
    output.appendLine(`[error] ${message}`);
    void vscode.window.showErrorMessage(`Honey Bee: ${message}`);
  };
  const reportPromptDiagnostic = (message: string): void => {
    output.appendLine(`[prompt] ${message}`);
  };

  await applyPromptRecoveryTestFixture(context);

  const sessions = new GlobalStateSessionRepository(context.globalState);
  const drafts = new GlobalStateDraftRepository(context.globalState);
  const attempts = new GlobalStatePromptDeliveryAttemptRepository(context.globalState);
  const receipts = new GlobalStatePromptDeliveryReceiptRepository(context.globalState);
  const selectionState = new GlobalStateSelectionRepository(context.globalState);
  const clock = new SystemClock();
  const ids = new RandomIdGenerator();

  const attemptReconciliation = await new PromptDeliveryAttemptReconciler({
    attempts,
    receipts,
    drafts,
  }).reconcile();
  const attemptRecoveryFailure = reportAttemptReconciliation(attemptReconciliation, output);
  const reconciliation = await new PromptDeliveryReconciler({ drafts, receipts }).reconcile();
  if (attemptRecoveryFailure || reportReconciliation(reconciliation, output)) {
    void vscode.window.showWarningMessage(
      "Honey Bee could not fully reconcile local Prompt recovery records. Drafts were preserved where delivery state was uncertain.",
    );
  }

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
    attempts,
    receipts,
    selection,
    runtime,
    profiles,
    clock,
    ids,
    attemptReconciliation.issues,
  );
  const tree = new SessionTreeProvider(sessionService);
  const consoleView = new ConsoleViewProvider(
    context.extensionUri,
    consoleService,
    reportError,
    reportPromptDiagnostic,
  );

  let shutdownPromise: Promise<void> | undefined;
  const shutdown = (): Promise<void> => {
    shutdownPromise ??= boundedShutdown(
      (async () => {
        await consoleView.shutdown();
        await attempts.flush();
        await receipts.flush();
        await consoleService.dispose();
      })(),
      () => output.appendLine("[warning] Honey Bee shutdown exceeded 5000 ms."),
    );
    return shutdownPromise;
  };
  activeShutdown = shutdown;

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
        void shutdown().catch(reportError);
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
  void consoleService.initialize().catch(reportError);

  if (context.extensionMode !== vscode.ExtensionMode.Test) {
    return {};
  }
  const [draftResult, attemptResult, receiptResult] = await Promise.all([
    drafts.list(),
    attempts.list(),
    receipts.list(),
  ]);
  if (!draftResult.ok || !attemptResult.ok || !receiptResult.ok) {
    throw new Error("Prompt recovery test state could not be read.");
  }
  return {
    promptRecoveryTestState: {
      draftSessionIds: draftResult.value.map((draft) => draft.sessionId),
      receiptCleanup: receiptResult.value.map((receipt) => ({
        requestId: receipt.requestId,
        draftCleanup: receipt.draftCleanup,
      })),
      selectedDraftPresent: consoleService.state.draft.length > 0,
      attemptPhases: attemptResult.value.map((attempt) => ({
        requestId: attempt.requestId,
        phase: attempt.phase,
      })),
      recoveryIssueRequestIds: attemptReconciliation.issues.map((issue) => issue.requestId),
    },
  };
};

export const deactivate = async (): Promise<void> => {
  const shutdown = activeShutdown;
  activeShutdown = undefined;
  await shutdown?.();
};
