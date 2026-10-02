const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { DEFAULT_GROUP, createAutomationStore } = require("../src/automation-store");

function legacyStore(t, edit) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-link-migration-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const group = structuredClone(DEFAULT_GROUP);
  delete group.linkWarnings;
  delete group.linkEscalationVersion;
  group.rules = group.rules.filter(rule => rule.id !== "builtin-link-removal");
  edit(group);
  fs.writeFileSync(file, JSON.stringify({ version: 1, groups: { "1000@g.us": group } }));
  return { file, store: createAutomationStore(file) };
}

test("legacy migration recovers recorded link offences without including manual or simulated warnings", t => {
  const { store } = legacyStore(t, group => {
    group.warnings = { "300@lid": 6, "400@c.us": 3 };
    group.audit = [
      ...Array.from({ length: 5 }, () => ({ command: "warn", target: "300@lid", actor: { type: "rule", id: "builtin-links" }, result: "success" })),
      { command: "warn", target: "300@lid", actor: { type: "user", id: "200@c.us" }, result: "success" },
      { command: "warn", target: "300@lid", actor: { type: "rule", id: "builtin-links" }, result: "success", dryRun: true },
      { command: "warn", target: "300@lid", actor: { type: "rule", id: "builtin-links" }, result: "failed" },
      ...Array.from({ length: 3 }, () => ({ command: "warn", target: "400@c.us", actor: { type: "user", id: "200@c.us" }, result: "success" }))
    ];
    group.activities = [{ id: "meeting", when: "daily", time: "09:00", text: "Meeting" }];
    group.paused = true;
  });
  const group = store.get("1000@g.us");
  assert.deepEqual(group.linkWarnings, { "300@lid": 5 });
  assert.deepEqual(group.warnings, { "300@lid": 6, "400@c.us": 3 });
  assert.equal(group.rules.find(rule => rule.id === "builtin-link-removal").enabled, true);
  assert.equal(group.activities[0].id, "meeting");
  assert.equal(group.paused, true);
});

test("legacy warning reversals reduce recovered offences without creating negative counts", t => {
  const { store } = legacyStore(t, group => {
    group.warnings = { "300@lid": 1 };
    group.audit = [
      { command: "unwarn", target: "300@lid", args: { amount: 5 }, result: "success" },
      { command: "warn", target: "300@lid", actor: { type: "rule", id: "builtin-links" }, result: "success" },
      { command: "warn", target: "300@lid", actor: { type: "rule", id: "builtin-links" }, result: "success" },
      { command: "unwarn", target: "300@lid", args: { amount: 1 }, result: "success" }
    ];
  });
  assert.equal(store.get("1000@g.us").linkWarnings["300@lid"], 1);
});

test("migration persists once and an intentionally disabled removal rule remains disabled", t => {
  const { file, store } = legacyStore(t, group => { group.warnings = {}; });
  store.update("1000@g.us", group => { group.rules.find(rule => rule.id === "builtin-link-removal").enabled = false; });
  const restored = createAutomationStore(file).get("1000@g.us");
  assert.equal(restored.linkEscalationVersion, 1);
  assert.equal(restored.rules.filter(rule => rule.id === "builtin-link-removal").length, 1);
  assert.equal(restored.rules.find(rule => rule.id === "builtin-link-removal").enabled, false);
});
