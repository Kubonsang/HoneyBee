/* eslint-disable @typescript-eslint/no-require-imports -- VS Code exposes its API to extension-host tests through CommonJS. */
/* global Buffer, process, suite, test */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const vscode = require("vscode");

const extensionId = "honeybee.honey-bee-vscode";
const fixtureEnvironment = "HONEY_BEE_TEST_PROMPT_RECOVERY_FIXTURE";
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

const digest = (content) =>
  "sha256:" + crypto.createHash("sha256").update(Buffer.from(content, "utf8")).digest("hex");

const session = (id, title) => ({
  id,
  title,
  agentProfileId: "custom",
  tags: [],
  relatedSessionIds: [],
  status: "idle",
  createdAt: "2026-07-30T11:00:00.000Z",
  updatedAt: "2026-07-30T11:00:00.000Z",
});

suite("Honey Bee extension host", () => {
  test("reconciles persisted receipts before Draft restore and registers commands", async () => {
    const staleSessionId = "receipt-stale-session";
    const newSessionId = "receipt-new-session";
    const staleContent = "delivered before restart";
    const deliveredOldContent = "older delivered content";
    const newDraftContent = "new unsent content";
    process.env[fixtureEnvironment] = JSON.stringify({
      sessions: [session(staleSessionId, "Stale receipt"), session(newSessionId, "New Draft")],
      drafts: [
        {
          sessionId: staleSessionId,
          content: staleContent,
          updatedAt: "2026-07-30T11:59:00.000Z",
        },
        {
          sessionId: newSessionId,
          content: newDraftContent,
          updatedAt: "2026-07-30T12:01:00.000Z",
        },
      ],
      receipts: [
        {
          requestId: "receipt-stale",
          sessionId: staleSessionId,
          contentDigest: digest(staleContent),
          contentLength: Buffer.byteLength(staleContent, "utf8"),
          deliveredAt: "2026-07-30T12:00:00.000Z",
          draftCleanup: "pending",
          schemaVersion: 1,
        },
        {
          requestId: "receipt-new",
          sessionId: newSessionId,
          contentDigest: digest(deliveredOldContent),
          contentLength: Buffer.byteLength(deliveredOldContent, "utf8"),
          deliveredAt: "2026-07-30T12:00:00.000Z",
          draftCleanup: "pending",
          schemaVersion: 1,
        },
      ],
      selectedSessionId: newSessionId,
    });

    const extension = vscode.extensions.getExtension(extensionId);
    assert.ok(extension, "Extension " + extensionId + " was not discovered.");

    const api = await extension.activate();
    assert.equal(extension.isActive, true);
    assert.deepEqual(api.promptRecoveryTestState.draftSessionIds, [newSessionId]);
    assert.equal(api.promptRecoveryTestState.selectedDraftPresent, true);
    assert.deepEqual(
      Object.fromEntries(
        api.promptRecoveryTestState.receiptCleanup.map((receipt) => [
          receipt.requestId,
          receipt.draftCleanup,
        ]),
      ),
      { "receipt-new": "cleared", "receipt-stale": "cleared" },
    );
    assert.equal(JSON.stringify(api).includes(staleContent), false);
    assert.equal(JSON.stringify(api).includes(newDraftContent), false);

    const commands = await vscode.commands.getCommands(true);
    for (const command of expectedCommands) {
      assert.ok(commands.includes(command), "Command " + command + " was not registered.");
    }

    await vscode.commands.executeCommand("honeyBee.session.refresh");
  });
});
