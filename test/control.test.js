const test = require("node:test");
const assert = require("node:assert/strict");
const { createCommandEngine } = require("../src/command-engine");
const { installCoreCommands } = require("../src/core-commands");
const { createAutomationStore } = require("../src/automation-store");
const logger = { log() {}, warn() {}, error() {} };
const { fixture } = require("./helpers/control-fixture.cjs");

test("registry metadata and aliases route to the same command", async () => {
  const f = fixture();
  assert.equal(f.engine.get("d").name, "delete");
  for (const entry of f.engine.entries()) for (const field of ["description", "requiredRole", "needsBotAdmin", "destructive", "args", "automationSafe"]) assert.ok(field in entry);
  await f.engine.executeCommand("warn", f.context({ args: { target: "300@c.us" } }));
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
  assert.equal(f.storage.get("1000@g.us").audit.at(-1).result, "success");
});

test("delegated moderators can warn/delete but cannot remove members or change permissions", async () => {
  const f = fixture();
  await f.engine.executeCommand("mod", f.context({ args: "add @300" }));
  const moderator = { type: "user", id: "300@c.us" };
  assert.equal((await f.engine.executeCommand("warn", f.context({ actor: moderator, args: { target: "400@c.us" } }))).ok, true);
  assert.equal((await f.engine.executeCommand("remove", f.context({ actor: moderator, args: { target: "400@c.us" } }))).ok, false);
  assert.equal((await f.engine.executeCommand("perm", f.context({ actor: moderator, args: "remove member" }))).ok, false);
});

test("owners can act outside group membership and owners resolve through LIDs", async () => {
  const f = fixture();
  f.client.getContactLidAndPhone = async ids => ids.map(id => id === "888@lid" ? { pn: "999@c.us", lid: id } : { pn: id });
  const result = await f.engine.executeCommand("warn", f.context({ actor: { type: "user", id: "888@lid" }, args: { target: "400@c.us" } }));
  assert.equal(result.ok, true);
});

test("per-group command permissions and switches are enforced", async () => {
  const f = fixture();
  await f.engine.executeCommand("perm", f.context({ args: "warn member" }));
  assert.equal((await f.engine.executeCommand("warn", f.context({ actor: { type: "user", id: "400@c.us" }, args: { target: "300@lid" } }))).ok, true);
  await f.engine.executeCommand("cmd", f.context({ args: "disable warn" }));
  assert.equal((await f.engine.executeCommand("warn", f.context({ args: { target: "300@lid" } }))).ok, false);
  await f.engine.executeCommand("cmd", f.context({ args: "enable warn" }));
  assert.equal((await f.engine.executeCommand("warn", f.context({ args: { target: "300@lid" } }))).ok, true);
});


const { installControlPanel } = require("../src/control-panel");
function panelFixture() { const f = fixture(); f.panel = installControlPanel(f.engine, f.options); return f; }

test("DM group selection is restricted and admin status is rechecked on every command", async () => {
  const f = panelFixture();
  const dm = { from: "200@c.us", body: ".groups", reply: async text => f.sent.push({ text }) };
  await f.panel.executeText(dm.body, await f.panel.context(dm));
  assert.match(f.sent.at(-1).text, /1000@g.us/);
  await f.panel.executeText(".use 1000@g.us", await f.panel.context(dm));
  assert.equal((await f.panel.executeText(".status", await f.panel.context(dm))).ok, true);
  f.chat.participants[1].isAdmin = false;
  assert.equal((await f.panel.executeText(".status", await f.panel.context(dm))).ok, false);
});

test("member DMs cannot select or control another group's bot", async () => {
  const f = panelFixture();
  const dm = { from: "400@c.us", reply: async text => f.sent.push({ text }) };
  assert.equal((await f.panel.executeText(".use 1000@g.us", await f.panel.context(dm))).ok, false);
  assert.equal(f.panel.selected.size, 0);
});

test("macros and aliases cannot bypass permissions or recurse forever", async () => {
  const f = panelFixture();
  await f.panel.executeText(".alias caution warn @400 Be respectful", f.context());
  await f.panel.executeText(".macro greeting caution; ping", f.context());
  assert.equal((await f.panel.executeText(".greeting", f.context())).ok, true);
  assert.equal((await f.panel.executeText(".greeting", f.context({ actor: { type: "user", id: "300@lid" } }))).ok, false);
  await f.panel.executeText(".alias caution caution", f.context());
  assert.equal((await f.panel.executeText(".caution", f.context())).ok, false);
});

test("custom FAQ answers work and config imports preserve operational history", async () => {
  const f = panelFixture();
  await f.panel.executeText(".addcmd rules Be respectful", f.context());
  await f.panel.executeText("rules", f.context({ actor: { type: "user", id: "400@c.us" } }));
  assert.equal(f.sent.at(-1).text, "Be respectful");
  await f.panel.executeText(".config export", f.context());
  const exported = f.sent.at(-1).text;
  assert.equal((await f.panel.executeText(`.config import ${exported}`, f.context())).ok, true);
  assert.ok(f.storage.get("1000@g.us").audit.length > 0);
});

test("panic pauses automatic commands and resume restores them", async () => {
  const f = panelFixture();
  await f.panel.executeText(".panic", f.context());
  const system = f.context({ actor: { type: "system", id: "scheduler" } });
  assert.equal((await f.engine.executeCommand("say", { ...system, args: "hello" })).ok, false);
  await f.panel.executeText(".resume", f.context());
  assert.equal((await f.engine.executeCommand("say", { ...system, args: "hello" })).ok, true);
});

test("destructive automation is proposed, persisted, approved once, and records the approver", async () => {
  const f = panelFixture();
  await f.panel.executeText(".set approval destructive", f.context());
  const request = f.context({ actor: { type: "rule", id: "rule-1" }, args: { target: "300@lid" } });
  const result = await f.engine.executeCommand("remove", request);
  assert.equal(result.status, "proposed"); assert.equal(f.actions.length, 0);
  assert.equal((await f.engine.executeCommand("remove", request)).proposalId, result.proposalId);
  await f.panel.executeText(`.yes ${result.proposalId}`, f.context());
  assert.equal(f.actions.length, 1);
  assert.equal(f.storage.get("1000@g.us").proposals[0].status, "approved");
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "remove" && row.approvedBy === "200@c.us"));
  assert.equal((await f.panel.executeText(`.yes ${result.proposalId}`, f.context())).ok, false);
});

test("proposals can be rejected or expire without taking action", async () => {
  const f = panelFixture(); await f.panel.executeText(".set approval all", f.context());
  let result = await f.engine.executeCommand("say", f.context({ actor: { type: "system", id: "schedule" }, args: "hello" }));
  await f.panel.executeText(`.no ${result.proposalId}`, f.context());
  assert.equal(f.storage.get("1000@g.us").proposals[0].status, "rejected");
  result = await f.engine.executeCommand("say", f.context({ actor: { type: "system", id: "schedule" }, args: "later" }));
  f.setTime("2026-10-02T04:11:00Z");
  assert.equal((await f.panel.executeText(`.yes ${result.proposalId}`, f.context())).ok, false);
  assert.equal(f.storage.get("1000@g.us").proposals.at(-1).status, "expired");
});

test("approval rechecks protection and current admin permissions", async () => {
  const f = panelFixture(); await f.panel.executeText(".set approval destructive", f.context());
  const result = await f.engine.executeCommand("remove", f.context({ actor: { type: "rule", id: "rule-1" }, args: { target: "300@lid" } }));
  assert.equal((await f.panel.executeText(`.yes ${result.proposalId}`, f.context({ actor: { type: "user", id: "400@c.us" } }))).ok, false);
  f.chat.participants[2].isAdmin = true;
  await f.panel.executeText(`.yes ${result.proposalId}`, f.context());
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").proposals[0].status, "failed");
});

test("dry-run makes no deletion, removal, warning, or outgoing operational message", async () => {
  const f = panelFixture(); await f.panel.executeText(".set dryrun on", f.context());
  const initialWarnings = f.storage.get("1000@g.us").warnings;
  for (const name of ["warn", "remove"]) {
    const outcome = await f.engine.executeCommand(name, f.context({ args: { target: "300@lid" } }));
    assert.equal(outcome.status, "dry-run");
  }
  assert.equal((await f.engine.executeCommand("delete", f.context({ args: { messageId: "message" } }))).status, "dry-run");
  assert.equal(f.actions.length, 0);
  assert.deepEqual(f.storage.get("1000@g.us").warnings, initialWarnings);
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.dryRun));
  await f.panel.executeText(".set dryrun off", f.context()); assert.equal(f.storage.get("1000@g.us").dryRun, false);
});

test("concurrent automated destructive commands respect the persistent hourly cap", async () => {
  const f = panelFixture(); await f.panel.executeText(".set cap 1", f.context());
  const ctx = f.context({ actor: { type: "system", id: "schedule" }, args: { target: "300@lid" } });
  const outcomes = await Promise.all([f.engine.executeCommand("remove", ctx), f.engine.executeCommand("remove", ctx)]);
  assert.equal(outcomes.filter(outcome => outcome.ok).length, 1); assert.equal(f.actions.length, 1);
  assert.equal(f.storage.get("1000@g.us").paused, true);
  assert.match(f.sent.find(row => row.text.includes("hourly destructive-action limit")).text, /Automation paused/);
});

test("automation protects admins, owners, moderators, whitelist and the bot", async () => {
  const f = panelFixture();
  f.storage.update("1000@g.us", group => { group.moderators = ["300@lid"]; group.whitelist = ["400@c.us"]; });
  for (const target of ["100@c.us", "200@c.us", "300@lid", "400@c.us"]) {
    assert.equal((await f.engine.executeCommand("remove", f.context({ actor: { type: "rule", id: "test" }, args: { target } }))).ok, false);
  }
  assert.equal(f.actions.length, 0);
});

test("unsafe automatic commands and identity lookup failures skip and audit", async () => {
  const f = panelFixture();
  assert.equal((await f.engine.executeCommand("perm", f.context({ actor: { type: "rule", id: "test" }, args: "remove member" }))).ok, false);
  f.client.getContactLidAndPhone = async () => { throw new Error("Lookup failed"); };
  assert.equal((await f.engine.executeCommand("remove", f.context({ actor: { type: "rule", id: "test" }, args: { target: "777@lid" } }))).ok, false);
  assert.equal(f.actions.length, 0); assert.equal(f.storage.get("1000@g.us").audit.at(-1).result, "failed");
});

test("rate limits stop commands but allow administrative recovery", async () => {
  const f = panelFixture(); await f.panel.executeText(".set rate 1", f.context());
  const actor = { type: "user", id: "300@lid" };
  assert.equal((await f.engine.executeCommand("ping", f.context({ actor }))).ok, true);
  assert.equal((await f.engine.executeCommand("ping", f.context({ actor }))).ok, false);
  assert.equal((await f.panel.executeText(".panic", f.context())).ok, true);
});


const { installAuditCommands } = require("../src/audit-commands");
function auditFixture() { const f = panelFixture(); installAuditCommands(f.engine, { ...f.options, revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) }, f.core); return f; }

test("undo reverses warnings, mutes, locks, and local bans through the same executor", async () => {
  const f = auditFixture();
  f.chat.groupMetadata = { announce: false };
  f.chat.setMessagesAdminsOnly = async value => { f.chat.groupMetadata.announce = value; f.actions.push({ type: "lock", value }); return true; };
  for (const name of ["warn", "mute", "lock", "ban"]) {
    const outcome = await f.engine.executeCommand(name, f.context({ args: { target: "300@lid" } }));
    assert.equal(outcome.ok, true);
    const result = await f.panel.executeText(`.undo ${outcome.auditId}`, f.context());
    assert.equal(result.ok, true);
  }
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 0);
  assert.deepEqual(f.storage.get("1000@g.us").muted, {});
  assert.deepEqual(f.storage.get("1000@g.us").bans, []);
  assert.equal(f.chat.groupMetadata.announce, false);
});

test("undo clearly reports irreversible deletes and removals without faking restoration", async () => {
  const f = auditFixture();
  for (const [name, args] of [["delete", { messageId: "message" }], ["remove", { target: "300@lid" }]]) {
    const outcome = await f.engine.executeCommand(name, f.context({ args }));
    await f.panel.executeText(`.undo ${outcome.auditId}`, f.context());
    assert.match(f.sent.at(-1).text, /cannot be restored|cannot be undone/);
  }
});

test("audit can filter actors and records arguments, dry-run, approval and results", async () => {
  const f = auditFixture();
  await f.engine.executeCommand("warn", f.context({ args: { target: "300@lid" } }));
  await f.panel.executeText(".audit 10 user 200", f.context());
  assert.match(f.sent.at(-1).text, /user 200@c.us: warn/);
  assert.match(f.sent.at(-1).text, /success/);
});
