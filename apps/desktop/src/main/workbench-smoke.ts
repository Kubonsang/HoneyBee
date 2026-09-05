import type { BrowserWindow } from "electron";

/** Runs production renderer interactions against the isolated main-process fixture. */
export const verifyWorkbench = async (browser: BrowserWindow): Promise<void> => {
  const interact = async () => {
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
    button(".workspace-row", "ui").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "ui");
    button(".changed-files button", "Hud.prefab.meta").click();
    await waitFor(() =>
      /Untracked|미추적/u.test(document.querySelector(".diff-view")?.textContent ?? ""),
    );

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
      document.querySelector(".diff-view") !== null ||
      document.querySelector(".error-banner") !== null
    )
      throw new Error("Old Workspace response leaked into the current Workspace.");
  };
  await browser.webContents.executeJavaScript(`(${interact.toString()})()`);
};
