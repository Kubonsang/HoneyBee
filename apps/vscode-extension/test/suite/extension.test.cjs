/* eslint-disable @typescript-eslint/no-require-imports -- VS Code exposes its API to extension-host tests through CommonJS. */
/* global suite, test */
const assert = require("node:assert/strict");
const vscode = require("vscode");

const extensionId = "honeybee.honey-bee-vscode";
const expectedCommands = [
  "honeyBee.session.create",
  "honeyBee.session.refresh",
  "honeyBee.session.select",
  "honeyBee.session.rename",
  "honeyBee.session.delete",
  "honeyBee.session.addTag",
  "honeyBee.session.renameTag",
  "honeyBee.session.deleteTag",
  "honeyBee.session.setParent",
  "honeyBee.session.toggleRelated",
  "honeyBee.console.start",
  "honeyBee.console.interrupt",
  "honeyBee.console.stop",
];

suite("Honey Bee extension host", () => {
  test("activates the bundle and registers its public commands", async () => {
    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, "Extension " + extensionId + " was not discovered.");

    await extension.activate();
    assert.equal(extension.isActive, true);

    const commands = await vscode.commands.getCommands(true);
    for (const command of expectedCommands) {
      assert.ok(commands.includes(command), "Command " + command + " was not registered.");
    }

    await vscode.commands.executeCommand("honeyBee.session.refresh");
  });
});
