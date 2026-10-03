const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("./helpers/control-fixture.cjs");
const { createController } = require("../src/controller");
const { createAutomationStore } = require("../src/automation-store");

function setup(t, classify = async () => "FLAG", { configured = true, storage } = {}) {
  const f = fixture(), checked = [], current = new Map(); let number = 0;
  if (storage) f.options.storage = f.storage = storage;
  const classifier = { status: () => ({ configured, model: "test-model", lastError: null }), classify: async text => { checked.push(text); return classify(text); } };
  f.controller = createController({ ...f.options, contentClassifier: classifier,
    revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) });
  f.client.getMessageById = async id => current.get(id);
  f.controller.start(); t.after(() => f.controller.stop());
  f.message = (body, author = "300@lid", extra = {}) => {
    const message = { body, author, from: "1000@g.us", type: "chat", fromMe: false,
      id: { _serialized: `content-${++number}`, remote: "1000@g.us" }, getChat: async () => f.chat,
      reply: async text => f.sent.push({ text }), ...extra };
    current.set(message.id._serialized, message); return message;
  };
  f.command = async text => f.controller.handleMessage(f.message(text, "200@c.us"));
  f.send = async (text, author, extra) => {
    const message = f.message(text, author, extra);
    await f.controller.handleMessage(message); await f.controller.contentFilter.drain(); return message;
  };
  return { ...f, checked, current };
}

test("admins enable the filter, test exact labels, see status/help, and disable it", async t => {
  const f = setup(t, async text => text === "damn" ? "OK" : "FLAG");
  await f.send("f*ck you"); assert.equal(f.checked.length, 0);
  await f.command(".filter on"); assert.equal(f.storage.get("1000@g.us").contentModeration, true);
  await f.command(".filter test damn"); assert.equal(f.sent.at(-1).text, "OK");
  await f.command(".filter test f*ck you"); assert.equal(f.sent.at(-1).text, "FLAG");
  assert.equal(f.actions.length, 0);
  await f.command(".filter status"); assert.match(f.sent.at(-1).text, /Content filter: on/);
  await f.command(".help"); assert.match(f.sent.at(-1).text, /filter on\|off\|status/);
  await f.command(".filter off"); assert.equal(f.storage.get("1000@g.us").contentModeration, false);
});

test("ordinary members and moderators cannot configure the filter, and an unavailable classifier is reported honestly", async t => {
  const f = setup(t, undefined, { configured: false });
  await f.command(".filter on"); assert.match(f.sent.at(-1).text, /classifier is unavailable/);
  assert.equal(f.storage.get("1000@g.us").contentModeration, false);
  await f.controller.handleMessage(f.message(".filter on")); assert.match(f.sent.at(-1).text, /Admins only/);
  await f.command(".mod add 400@c.us");
  await f.controller.handleMessage(f.message(".filter on", "400@c.us")); assert.match(f.sent.at(-1).text, /Admins only/);
});

test("filter status reports deletion blockers and the last failed FLAG deletion", async t => {
  const f = setup(t); await f.command(".filter on");
  f.chat.participants[0].isAdmin = false;
  await f.send("f*ck you");
  await f.command(".filter status");
  assert.match(f.sent.at(-1).text, /Last flagged action: failed: The bot must be a group admin/);
  assert.match(f.sent.at(-1).text, /Make the linked bot account a group admin/);
  f.storage.update("1000@g.us", group => { group.dryRun = true; group.approval = "destructive"; group.disabledCommands = ["delete"]; });
  await f.command(".filter status");
  assert.match(f.sent.at(-1).text, /Dry-run is on/);
  assert.match(f.sent.at(-1).text, /need approval/);
  assert.match(f.sent.at(-1).text, /Deletion is disabled/);
});

test("FLAG deletes once through moderation without link warnings or automatic recovery", async t => {
  const f = setup(t); await f.command(".filter on");
  const message = await f.send("f*ck you");
  await f.controller.handleMessage(message); await f.controller.contentFilter.drain(); await f.controller.recovery.drain();
  assert.deepEqual(f.actions, [{ type: "delete", id: message.id._serialized }]);
  assert.equal(f.checked.length, 1);
  assert.deepEqual(f.storage.get("1000@g.us").linkWarnings, {});
  assert.equal(f.controller.archive.get(message.from, message.id._serialized).moderated, true);
  assert.ok(!f.sent.some(row => typeof row.text === "string" && row.text.includes("Deleted message recovered")));
});

test("OK, invalid decisions, classifier failures, direct chats, and protected members are kept", async t => {
  const f = setup(t, async text => { if (text === "error") throw new Error("failure"); return text === "protected" ? "FLAG" : text === "invalid" ? "FLAG because" : "OK"; });
  await f.command(".filter on");
  for (const text of ["damn", "crap", "what does f*ck mean?", "The news reported a threat.", "invalid", "error"]) await f.send(text);
  await f.send("protected", "200@c.us");
  await f.command(".mod add 400@c.us"); await f.send("protected", "400@c.us");
  f.storage.update("1000@g.us", group => { group.whitelist = ["300@lid"]; }); await f.send("protected");
  await f.send("protected", "300@lid", { from: "300@c.us", author: undefined });
  assert.equal(f.actions.length, 0);
  assert.ok(!f.checked.includes("protected"));
});

test("a slow content check does not delay ping or immediate link moderation", async t => {
  let release;
  const f = setup(t, () => new Promise(resolve => { release = resolve; }));
  await f.command(".filter on");
  const message = f.message("A text to classify");
  await f.controller.handleMessage(message);
  await new Promise(setImmediate); assert.equal(typeof release, "function");
  await f.command(".ping"); assert.equal(f.sent.at(-1).text, "pong");
  await f.controller.handleMessage(f.message("https://example.com"));
  assert.equal(f.actions.length, 1); assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
  release("OK"); await f.controller.contentFilter.drain();
});

test("panic, dry-run, missing bot admin, disabled delete and hourly caps prevent deletion", async t => {
  for (const mode of ["paused", "dryRun", "bot-admin", "disabled", "cap"]) {
    const f = setup(t); await f.command(".filter on");
    if (mode === "bot-admin") f.chat.participants[0].isAdmin = false;
    else f.storage.update("1000@g.us", group => {
      if (mode === "paused" || mode === "dryRun") group[mode] = true;
      if (mode === "disabled") group.disabledCommands.push("delete");
      if (mode === "cap") { group.destructiveCap = 1; group.destructiveActions = [{ at: f.options.now().valueOf(), command: "delete", units: 1 }]; }
    });
    await f.send("f*ck you"); assert.equal(f.actions.length, 0, mode);
  }
});

test("pending filter deletion requires approval and an edited or disabled-filter message is kept", async t => {
  const f = setup(t); await f.command(".filter on");
  f.storage.update("1000@g.us", group => { group.approval = "destructive"; });
  const first = await f.send("f*ck you");
  let pending = f.storage.get("1000@g.us").proposals.find(row => row.status === "pending");
  assert.ok(pending); assert.equal(f.actions.length, 0);
  f.current.set(first.id._serialized, { ...first, body: "Good morning!" });
  await f.command(`.yes ${pending.id}`); assert.equal(f.actions.length, 0);
  await f.send("Another synthetic flagged text");
  pending = f.storage.get("1000@g.us").proposals.find(row => row.status === "pending");
  await f.command(".filter off"); await f.command(`.yes ${pending.id}`); assert.equal(f.actions.length, 0);
});

test("a permitted approved FLAG deletion uses the same policy and audit path", async t => {
  const f = setup(t); await f.command(".filter on");
  f.storage.update("1000@g.us", group => { group.approval = "destructive"; });
  const message = await f.send("f*ck you");
  const pending = f.storage.get("1000@g.us").proposals.find(row => row.status === "pending");
  await f.command(`.yes ${pending.id}`);
  assert.ok(f.actions.some(row => row.id === message.id._serialized));
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "delete" && row.approvedBy === "200@c.us" && row.result === "success"));
});

test("edited messages and shutdown during classification prevent a delayed deletion", async t => {
  for (const mode of ["edited", "stopped"]) {
    let release;
    const f = setup(t, () => new Promise(resolve => { release = resolve; })); await f.command(".filter on");
    const message = f.message("f*ck you"); await f.controller.handleMessage(message); await new Promise(setImmediate);
    if (mode === "edited") f.current.set(message.id._serialized, { ...message, body: "Hello everyone" });
    else f.controller.stop();
    release("FLAG"); await f.controller.contentFilter.drain(); assert.equal(f.actions.length, 0, mode);
  }
});

test("automatic deletion recovery and view-once recovery never repost flagged text", async t => {
  const f = setup(t); await f.command(".filter on");
  const message = f.message("Synthetic flagged text");
  f.controller.handleRevocation({ ...message, body: "", type: "revoked" }, message);
  await f.controller.recovery.drain();
  assert.ok(!f.sent.some(row => typeof row.text === "string" && row.text.includes("Deleted message recovered")));
  await f.send("Synthetic flagged caption", "300@lid", { type: "image", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: "aW1hZ2U=" }) });
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 0);
});

test("the group filter setting persists and appears in config export", async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-filter-store-")); t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, "state.json"), storage = createAutomationStore(file);
  const f = setup(t, undefined, { storage }); await f.command(".filter on");
  assert.equal(createAutomationStore(file).get("1000@g.us").contentModeration, true);
  await f.command(".config export"); assert.equal(JSON.parse(f.sent.at(-1).text).settings.contentModeration, true);
  const old = JSON.parse(fs.readFileSync(file)); delete old.groups["1000@g.us"].contentModeration;
  fs.writeFileSync(file, JSON.stringify(old));
  assert.equal(createAutomationStore(file).get("1000@g.us").contentModeration, false);
});
