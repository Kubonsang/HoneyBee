import type { BrowserWindow } from "electron";
export type FeedbackScenario =
  "unknown" | "cleanup" | "repair" | "normal" | "refresh-failed" | "late-error";
export const verifyWorkspaceFeedback = async (
  browser: BrowserWindow,
  configure: (scenario: FeedbackScenario) => void,
): Promise<void> => {
  const interact = async (scenario: FeedbackScenario): Promise<void> => {
    const waitFor = async (predicate: () => boolean): Promise<void> => {
      const deadline = Date.now() + 8_000;
      while (!predicate()) {
        if (Date.now() > deadline) throw new Error(`Feedback smoke timed out: ${scenario}`);
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
    };
    const button = (selector: string, text: string): HTMLButtonElement => {
      const result = [...document.querySelectorAll<HTMLButtonElement>(selector)].find((item) =>
        item.textContent?.includes(text),
      );
      if (result === undefined) throw new Error(`Missing feedback button: ${text}`);
      return result;
    };
    if (scenario === "late-error") {
      button(".workspace-row", "ui").click();
      await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "ui");
      document.querySelector<HTMLButtonElement>(".quick-actions .unity")?.click();
      button(".workspace-row", "combat").click();
      await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "combat");
      await new Promise((resolve) => setTimeout(resolve, 500));
      if (document.querySelector(".error-banner") !== null)
        throw new Error("Late error leaked to another Workspace.");
      button(".workspace-row", "ui").click();
      await waitFor(
        () =>
          document.querySelector(".error-banner")?.textContent?.includes("workspace.in-use") ===
          true,
      );
      if (!document.querySelector(".error-banner strong")?.textContent?.includes("ui"))
        throw new Error("Error lost its target.");
      return;
    }
    button(".workspace-row", "combat").click();
    await waitFor(() => document.querySelector(".workspace-name h1")?.textContent === "combat");
    document.querySelector<HTMLButtonElement>(".header-actions .secondary")?.click();
    if (scenario === "refresh-failed") {
      await waitFor(() => document.querySelector(".refresh-status.stale") !== null);
      if (document.querySelectorAll(".workspace-row").length !== 3)
        throw new Error("Failed refresh discarded existing rows.");
      return;
    }
    await waitFor(() => document.querySelector(".refresh-status.stale") === null);
    if (scenario === "unknown") {
      await waitFor(() =>
        /Status unavailable|상태 확인 불가/u.test(
          document.querySelector(".workspace-summary dl")?.textContent ?? "",
        ),
      );
      if (!document.querySelector<HTMLButtonElement>(".lifecycle-actions .danger-button")?.disabled)
        throw new Error("Unknown Git allowed removal.");
    } else if (scenario === "cleanup") {
      await waitFor(() =>
        /Retry removal|삭제 재시도/u.test(
          document.querySelector(".lifecycle-actions")?.textContent ?? "",
        ),
      );
      if (document.querySelectorAll(".lifecycle-actions > button").length !== 1)
        throw new Error("Cleanup incorrectly offered repair.");
    } else if (scenario === "repair") {
      await waitFor(() =>
        /Repair required|복구 필요/u.test(
          document.querySelector(".large-state")?.textContent ?? "",
        ),
      );
      if (!document.querySelector(".lifecycle-actions .primary"))
        throw new Error("Repair action missing.");
    } else {
      await waitFor(() =>
        /Ready|준비됨/u.test(document.querySelector(".large-state")?.textContent ?? ""),
      );
    }
  };
  for (const scenario of [
    "unknown",
    "cleanup",
    "repair",
    "normal",
    "refresh-failed",
    "normal",
    "late-error",
  ] as const) {
    configure(scenario);
    await browser.webContents.executeJavaScript(
      `(${interact.toString()})(${JSON.stringify(scenario)})`,
    );
  }
  configure("normal");
  const retry = async (): Promise<void> => {
    document.querySelector<HTMLButtonElement>(".error-banner div button")?.click();
    const deadline = Date.now() + 5_000;
    while (
      document.querySelector(".error-banner") !== null ||
      document.querySelector(".operation-progress") !== null
    ) {
      if (Date.now() > deadline) throw new Error("Manual retry did not complete.");
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  };
  await browser.webContents.executeJavaScript(`(${retry.toString()})()`);
};
