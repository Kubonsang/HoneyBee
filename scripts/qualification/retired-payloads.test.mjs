import assert from "node:assert/strict";
import test from "node:test";
import { validateRetiredPayloads } from "./retired-payloads.mjs";

const entry = {
  path: "HoneyBeeSetup.exe",
  sha256: "a".repeat(64),
  size: 123,
  hostCopyVerified: true,
};

test("retirement only accepts distinct pinned transport copies", () => {
  validateRetiredPayloads([entry]);
  for (const name of [
    "../HoneyBeeSetup.exe",
    "Evidence/result.json",
    "children/data.vhdx",
    "C:\\Windows\\file",
    "updates/service/../../HoneyBeeSetup.exe",
  ]) {
    assert.throws(() => validateRetiredPayloads([{ ...entry, path: name }]));
  }
  assert.throws(() => validateRetiredPayloads([entry, entry]));
});

test("retirement requires host preservation and complete identity before filesystem access", () => {
  for (const override of [
    { hostCopyVerified: false },
    { sha256: "bad" },
    { size: 0 },
    { size: 1.5 },
  ]) {
    assert.throws(() => validateRetiredPayloads([{ ...entry, ...override }]));
  }
  assert.throws(() => validateRetiredPayloads([null]));
});
