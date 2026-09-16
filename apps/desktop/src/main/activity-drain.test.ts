import { expect, it, vi } from "vitest";
import { DesktopActivityDrain } from "./activity-drain.js";
it("waits for accepted work and refuses new work during quit", async () => {
  const ready = vi.fn(),
    gate = new DesktopActivityDrain(ready);
  let finish: () => void = () => {};
  const work = gate.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  expect(gate.requestQuit()).toBe(false);
  await expect(gate.run(() => "new work")).rejects.toThrow("closing");
  expect(ready).not.toHaveBeenCalled();
  finish();
  await work;
  expect(ready).toHaveBeenCalledOnce();
  expect(gate.requestQuit()).toBe(true);
});
it("cancelled quit reopens admission and does not request another quit", async () => {
  const ready = vi.fn(),
    gate = new DesktopActivityDrain(ready);
  let finish: () => void = () => {};
  const work = gate.run(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  gate.requestQuit();
  gate.cancelQuit();
  finish();
  await work;
  expect(ready).not.toHaveBeenCalled();
  expect(await gate.run(() => "allowed")).toBe("allowed");
});
it("failed work also drains without leaking a pending operation", async () => {
  const ready = vi.fn(),
    gate = new DesktopActivityDrain(ready);
  let fail: (error: Error) => void = () => {};
  const work = gate.run(
    () =>
      new Promise<void>((_, reject) => {
        fail = reject;
      }),
  );
  gate.requestQuit();
  const rejected = expect(work).rejects.toThrow("failed");
  fail(new Error("failed"));
  await rejected;
  expect(ready).toHaveBeenCalledOnce();
  expect(gate.requestQuit()).toBe(true);
});
