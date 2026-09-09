import type { BrowserWindow } from "electron";
import type { HoneyBeeDesktopApi } from "../shared/ipc.js";

export const verifyWorkspaceBasePicker = async (browser: BrowserWindow): Promise<void> => {
  const interact = async () => {
    const api = (window as unknown as { honeybee: HoneyBeeDesktopApi }).honeybee;
    const waitFor = async (predicate: () => boolean) => {
      const deadline = Date.now() + 8_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error("Starting point picker timed out.");
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const click = (selector: string) => {
      const element = document.querySelector<HTMLElement>(selector);
      if (!element) throw new Error(`Missing starting point control: ${selector}`);
      element.click();
    };
    const setValue = (element: HTMLInputElement | HTMLSelectElement | null, value: string) => {
      if (!element) throw new Error("Missing starting point input.");
      const prototype: object =
        element instanceof HTMLInputElement
          ? HTMLInputElement.prototype
          : HTMLSelectElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(element, value);
      element.dispatchEvent(
        new Event(element instanceof HTMLInputElement ? "input" : "change", { bubbles: true }),
      );
    };
    await waitFor(() => document.querySelectorAll(".workspace-row").length === 3);
    click("[data-testid='new-workspace']");
    await waitFor(() => document.querySelector(".base-picker [role='alert']") !== null);
    if (
      !document.querySelector<HTMLButtonElement>(".workspace-create-modal footer .primary")
        ?.disabled
    )
      throw new Error("Failed query allowed creation.");
    click(".base-picker [role='alert'] button");
    await waitFor(
      () =>
        document.querySelectorAll(".base-commit").length === 2 &&
        document.querySelector("[data-testid='base-summary']") !== null,
    );
    const source = document.querySelector<HTMLSelectElement>("[data-testid='base-source']");
    setValue(source, "refs/heads/history-smoke");
    await new Promise((resolve) => setTimeout(resolve, 50));
    setValue(source, "HEAD");
    await waitFor(
      () =>
        document
          .querySelector("[data-testid='base-summary']")
          ?.textContent?.includes("Update combat balance") === true,
    );
    await new Promise((resolve) => setTimeout(resolve, 400));
    if (
      !document
        .querySelector("[data-testid='base-summary']")
        ?.textContent?.includes("Update combat balance")
    )
      throw new Error("Stale branch query replaced the current selection.");

    click(".base-picker summary");
    await waitFor(
      () => document.querySelector<HTMLDetailsElement>(".base-picker details")?.open === true,
    );
    setValue(document.querySelector<HTMLInputElement>("[data-testid='base-input']"), "missing-ref");
    await new Promise((resolve) => setTimeout(resolve, 25));
    click(".base-picker details button");
    await waitFor(() => document.querySelector(".base-picker [role='alert']") !== null);
    if (
      !document.querySelector<HTMLButtonElement>(".workspace-create-modal footer .primary")
        ?.disabled
    )
      throw new Error("Unresolved manual input allowed creation.");
    click(".base-picker summary");
    await waitFor(
      () =>
        document.querySelectorAll(".base-commit").length === 2 &&
        document.querySelector("[data-testid='base-summary']") !== null,
    );
    click(".base-commit:last-child input");
    setValue(
      document.querySelector<HTMLInputElement>(".workspace-create-modal > .field input"),
      "history-selection-smoke",
    );
    await waitFor(
      () =>
        document.querySelector<HTMLButtonElement>(".workspace-create-modal footer .primary")
          ?.disabled === false,
    );
    if (
      !document.querySelector("[data-testid='base-summary']")?.textContent?.includes("전투 씬 추가")
    )
      throw new Error("Historical commit summary is missing.");
    click(".workspace-create-modal footer .primary");
    await waitFor(() => document.querySelector("[data-testid='workspace-dialog']") === null);
    const created = (await api.workspaces({ projectId: "smoke-project" })).find(
      (workspace) => workspace.name === "history-selection-smoke",
    );
    if (created?.baseCommit !== "b".repeat(40) || created.git?.head !== created.baseCommit)
      throw new Error("Creation did not receive the selected immutable commit.");
    await api.removeWorkspace({ projectId: "smoke-project", workspaceId: created.workspaceId });
    click(".header-actions .secondary");
    await waitFor(() => document.querySelectorAll(".workspace-row").length === 3);
    const combat = [...document.querySelectorAll<HTMLButtonElement>(".workspace-row")].find(
      (element) => element.textContent?.includes("combat"),
    );
    combat?.click();
  };
  await browser.webContents.executeJavaScript(`(${interact.toString()})()`);
};
