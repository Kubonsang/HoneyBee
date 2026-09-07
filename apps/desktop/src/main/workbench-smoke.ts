import type { BrowserWindow } from "electron";
import type { HoneyBeeDesktopApi } from "../shared/ipc.js";

/** Runs production renderer interactions against the isolated main-process fixture. */
export const verifyWorkbench = async (browser: BrowserWindow): Promise<void> => {
  const interact = async () => {
    const api = (window as unknown as { honeybee: HoneyBeeDesktopApi }).honeybee;
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (!predicate()) {
        if (Date.now() >= deadline) throw new Error("Workbench interaction timed out.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const button = (selector: string, text: string): HTMLButtonElement => {
      const result = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((element) =>
        element.textContent?.includes(text),
      );
      if (result === undefined) throw new Error(`Missing button: ${text}`);
      return result;
    };
    await waitFor(() => document.querySelectorAll(".workspace-row").length === 3);
    document.querySelector<HTMLButtonElement>("[data-testid='usage-tab']")?.click();
    await waitFor(() => document.querySelector(".usage-panel") !== null);
    if (document.querySelector(".usage-panel table") !== null)
      throw new Error("Usage scanned without an explicit request.");
    document.querySelector<HTMLButtonElement>(".usage-toolbar button")?.click();
    await waitFor(() => document.querySelectorAll(".usage-panel tbody tr").length === 3);
    if (!document.querySelector(".usage-panel")?.textContent?.match(/확인 불가|Unknown/u))
      throw new Error("Unknown allocation rendered as zero.");
    document.querySelector<HTMLButtonElement>(".detail-tabs button:first-child")?.click();
    button(".workspace-row", "ui").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "ui");
    button(".changed-files button", "Hud.prefab.meta").click();
    await waitFor(
      () =>
        document.querySelector(".diff-view")?.textContent?.includes("guid: smoke-preview") === true,
    );
    if (!document.querySelector(".changed-files") || !document.querySelector(".diff-line.added"))
      throw new Error("File list and colored preview must stay visible together.");

    button(".changed-files button", "ShaderGraphSettings.asset").click();
    await waitFor(
      () => document.querySelector(".diff-view")?.textContent?.includes("setting_0") === true,
    );
    const review = document.querySelector<HTMLDivElement>(".diff-view");
    if (!review) throw new Error("Missing diff scroll view.");
    review.scrollTop = 8000;
    await waitFor(() => review.textContent?.includes("setting_360") === true);
    if (document.querySelectorAll(".diff-line").length > 180)
      throw new Error("Large diff rendered an unbounded number of rows.");
    button(".changed-files button", "Hud.prefab.meta").click();
    await waitFor(() => review.textContent?.includes("guid: smoke-preview") === true);
    button(".changed-files button", "ShaderGraphSettings.asset").click();
    await waitFor(
      () => review.scrollTop >= 7990 && review.textContent?.includes("setting_360") === true,
    );
    document.querySelector<HTMLButtonElement>(".workbench-header button.secondary")?.click();
    await new Promise((resolve) => setTimeout(resolve, 650));
    if (
      !document
        .querySelector(".diff-toolbar strong")
        ?.textContent?.includes("ShaderGraphSettings.asset") ||
      review.scrollTop < 7990
    )
      throw new Error("Refresh lost the selected file or its scroll position.");

    // Start a slow file diff, then a faster all-files diff. The older reply must not replace it.
    document.querySelector<HTMLButtonElement>(".detail-tabs button:first-child")?.click();
    await waitFor(() => document.querySelector(".changed-files") !== null);
    button(".changed-files button", "Hud.prefab").click();
    document.querySelector<HTMLButtonElement>(".detail-tabs button:first-child")?.click();
    await waitFor(() => document.querySelector(".changed-files") !== null);
    document.querySelector<HTMLButtonElement>(".changed-files button:first-child")?.click();
    await waitFor(
      () => document.querySelector(".diff-view")?.textContent?.includes("diff --git") === true,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (!document.querySelector(".diff-view")?.textContent?.includes("diff --git"))
      throw new Error("Older file diff replaced the current all-files diff.");

    document.querySelector<HTMLButtonElement>(".detail-tabs button:first-child")?.click();
    await waitFor(() => document.querySelector(".changed-files") !== null);
    button(".changed-files button", "Hud.prefab").click();
    button(".workspace-row", "combat").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "combat");
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (
      document.querySelector(".diff-toolbar strong")?.textContent?.includes("Hud.prefab") ||
      document.querySelector(".error-banner") !== null
    )
      throw new Error("Old Workspace response leaked into the current Workspace.");

    document.querySelector<HTMLButtonElement>(".detail-tabs button:last-child")?.click();
    let sessions = await api.listPtys();
    const deadline = Date.now() + 8_000;
    while (sessions.length === 0 && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      sessions = await api.listPtys();
    }
    const session = sessions[0];
    if (session === undefined) throw new Error("No terminal was created.");
    await api.writePty({
      sessionId: session.sessionId,
      data: "$hbUi = 7 * 6; Write-Output ('UI' + 'STATE:' + $PID + ':' + $hbUi)\r",
    });
    let output = "";
    while (!/UISTATE:[0-9]+:42/u.test(output) && Date.now() < deadline) {
      output = (await api.ptySnapshot({ sessionId: session.sessionId })).chunks
        .map((chunk) => chunk.data)
        .join("");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const pid = /UISTATE:([0-9]+):42/u.exec(output)?.[1];
    if (pid === undefined) throw new Error("PowerShell did not evaluate the UI marker.");
    const terminal = document.querySelector(".xterm");
    document.querySelector<HTMLButtonElement>(".detail-tabs button:first-child")?.click();
    await waitFor(() => document.querySelector(".changed-files") !== null);
    button(".workspace-row", "ui").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "ui");
    button(".workspace-row", "combat").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "combat");
    document.querySelector<HTMLButtonElement>(".detail-tabs button:last-child")?.click();
    await waitFor(() => document.querySelector(".xterm") !== null);
    if (document.querySelector(".xterm") !== terminal)
      throw new Error("Navigation recreated xterm.");
    const resumed = await api.listPtys();
    if (resumed.length !== 1 || resumed[0]?.sessionId !== session.sessionId)
      throw new Error("Navigation replaced the shell.");
    await api.writePty({
      sessionId: session.sessionId,
      data: "Write-Output ('UI' + 'RESUME:' + $PID + ':' + $hbUi)\r",
    });
    const resumeDeadline = Date.now() + 5_000;
    while (!output.includes(`UIRESUME:${pid}:42`) && Date.now() < resumeDeadline) {
      output = (await api.ptySnapshot({ sessionId: session.sessionId })).chunks
        .map((chunk) => chunk.data)
        .join("");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (!output.includes(`UIRESUME:${pid}:42`))
      throw new Error("Shell state did not survive navigation.");
    try {
      await api.removeWorkspace({
        projectId: session.projectId,
        workspaceId: session.workspaceId,
      });
      throw new Error("Removal accepted a running terminal.");
    } catch (error) {
      if (!(error instanceof Error) || !error.message.includes("desktop.terminal-running"))
        throw error;
    }
    document.querySelector<HTMLButtonElement>(".breadcrumb-project")?.click();
    await waitFor(() => document.querySelector("[data-testid='project-picker']") !== null);
    button(".project-row", "Other project").click();
    await waitFor(
      () => document.querySelector(".workbench-header strong")?.textContent === "Other project",
    );
    document.querySelector<HTMLButtonElement>(".breadcrumb-project")?.click();
    await waitFor(() => document.querySelector("[data-testid='project-picker']") !== null);
    button(".project-row", "GKF_").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "combat");
    document.querySelector<HTMLButtonElement>(".detail-tabs button:last-child")?.click();
    await waitFor(() => document.querySelector(".xterm") !== null);
    if (
      document.querySelector(".xterm") !== terminal ||
      (await api.listPtys())[0]?.sessionId !== session.sessionId
    )
      throw new Error("Project navigation replaced the terminal.");
    await api.closePty({ sessionId: session.sessionId });
  };
  await browser.webContents.executeJavaScript(`(${interact.toString()})()`);
};
