import { expect, it } from "vitest";
import { LatestRequest } from "./latest-request.js";

it("discards out-of-order responses and responses after leaving the view", async () => {
  const requests = new LatestRequest();
  let displayed = "";
  let finishOld: (() => void) | undefined;
  const old = requests.begin();
  const pending = new Promise<void>((resolve) => {
    finishOld = resolve;
  }).then(() => {
    if (old()) displayed = "old project";
  });
  const current = requests.begin();
  if (current()) displayed = "new project";
  finishOld?.();
  await pending;
  expect(displayed).toBe("new project");
  requests.invalidate();
  expect(current()).toBe(false);
});
