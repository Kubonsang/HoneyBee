import test from "node:test";
import process from "node:process";

// These cases invoke the real lifecycle helper: Windows handle locks, activity
// admission or Job Objects. The non-Windows helper explicitly rejects them.
// Keep portable validation cases on normal node:test, even in the same file.
export const windowsTest = (name, options, fn) => {
  if (process.platform === "win32") return test(name, options, fn);
  return typeof options === "function"
    ? test(name, { skip: "windows-native: lifecycle" }, options)
    : test(name, { ...options, skip: "windows-native: lifecycle" }, fn);
};
