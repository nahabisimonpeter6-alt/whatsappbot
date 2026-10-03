const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("./helpers/control-fixture.cjs");
const { createController } = require("../src/controller");
const { createAutomationStore } = require("../src/automation-store");

function setup(t, storage) {
  const f = fixture(); let messageNumber = 0;
  if (storage) f.storage = f.options.storage = storage;
  f.controller = createController({ ...f.options, revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) });
  t.after(() => f.controller.stop());
  f.message = (body, actor = "200@c.us", dm = false) => ({
    body, author: dm ? undefined : actor, from: dm ? actor : "1000@g.us", type: "chat", fromMe: false,
    id: { _serialized: `message-${++messageNumber}`, remote: "1000@g.us" },
    getChat: async () => f.chat, reply: async (text, _chatId, options) => f.sent.push(options ? { text, options } : { text })
  });
  f.notification = (recipient, type = "add", id = `join-${recipient}`) => ({
    chatId: "1000@g.us", recipientIds: [recipient], type, id: { _serialized: id }, getChat: async () => f.chat
  });
  return f;
}
async function command(f, body, actor, dm) { await f.controller.handleMessage(f.message(body, actor, dm)); }
async function addRule(f, source) {
  await command(f, `.rule add ${source}`);
  return f.storage.get("1000@g.us").rules.at(-1).id;
}
async function start(f) { f.controller.start(); await new Promise(setImmediate); await f.controller.tick(); }

test("the controller runs ping through the same registry from chat, DM, schedule and rule", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => { group.rules = []; });
  await command(f, ".ping");
  await command(f, ".use 1000@g.us", "200@c.us", true);
  await command(f, ".ping", "200@c.us", true);
  await addRule(f, 'WHEN schedule("07:00") THEN ping');
  await addRule(f, 'WHEN message_matches("hello") THEN ping');
  await start(f);
  await command(f, "hello", "300@lid");
  assert.equal(f.sent.filter(row => row.text === "pong").length, 4);
  const rows = f.storage.get("1000@g.us").audit.filter(row => row.command === "ping");
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.result === "success"));
  assert.deepEqual(rows.map(row => row.actor.type), ["user", "user", "rule", "rule"]);
});

test("production link moderation persists warnings, protects admins and can be disabled", async t => {
  const f = setup(t);
  await command(f, "https://example.com", "300@c.us");
  assert.equal(f.actions.length, 1);
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
  await command(f, "https://example.com");
  await command(f, "Please read report.pdf", "400@c.us");
  assert.equal(f.actions.length, 1);
  await command(f, ".rule disable builtin-links");
  await command(f, "https://example.com", "400@c.us");
  assert.equal(f.actions.length, 1);
});

test("link warnings still run when the bot cannot delete", async t => {
  const f = setup(t); f.chat.participants[0].isAdmin = false;
  await command(f, "(example.com)", "300@lid");
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
});

test("three link offences warn; the fourth removes the canonical member ID", async t => {
  const f = setup(t);
  for (let i = 1; i <= 3; i++) {
    await command(f, "https://example.com", "300@c.us");
    assert.equal(f.actions.filter(row => row.type === "remove").length, 0);
    assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], i);
  }
  await command(f, "(example.com)", "300@lid");
  assert.equal(f.actions.filter(row => row.type === "delete").length, 4);
  assert.deepEqual(f.actions.filter(row => row.type === "remove"), [{ type: "remove", ids: ["300@lid"] }]);
  assert.match(f.sent.at(-1).text, /removed for repeatedly posting links/);
  assert.deepEqual(f.sent.at(-1).options.mentions, ["300@lid"]);
});

test("unrelated manual warnings do not count as link offences, including undo", async t => {
  const f = setup(t);
  await command(f, "example.com", "300@lid");
  for (let i = 0; i < 3; i++) await command(f, ".warn 300@lid Please stay on topic");
  const manual = f.storage.get("1000@g.us").audit.filter(row => row.command === "warn").at(-1);
  await command(f, `.undo ${manual.id}`);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
  assert.equal(f.actions.filter(row => row.type === "remove").length, 0);
  await command(f, ".unwarn 300@lid");
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 0);
});

test("link undo removes that offence and allows three remaining offences before removal", async t => {
  const f = setup(t);
  await command(f, "example.com", "300@lid");
  const warning = f.storage.get("1000@g.us").audit.find(row => row.command === "warn");
  await command(f, `.undo ${warning.id}`);
  for (let i = 0; i < 3; i++) await command(f, "example.com", "300@lid");
  assert.equal(f.actions.filter(row => row.type === "remove").length, 0);
  await command(f, "example.com", "300@lid");
  assert.equal(f.actions.filter(row => row.type === "remove").length, 1);
});

test("two members reaching the threshold in the same minute are both removed", async t => {
  const f = setup(t);
  for (let i = 0; i < 4; i++) {
    await command(f, "example.com", "300@lid");
    await command(f, "example.com", "400@c.us");
  }
  assert.deepEqual(f.actions.filter(row => row.type === "remove").map(row => row.ids[0]), ["300@lid", "400@c.us"]);
});

test("rapid posts finish removal before processing messages from a departed member", async t => {
  const f = setup(t);
  f.chat.removeParticipants = async ids => {
    await new Promise(setImmediate);
    f.actions.push({ type: "remove", ids });
    f.chat.participants = f.chat.participants.filter(person => !ids.includes(person.id._serialized));
    return { status: 200 };
  };
  await Promise.all(Array.from({ length: 5 }, () => command(f, "example.com", "300@lid")));
  assert.equal(f.actions.filter(row => row.type === "remove").length, 1);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 0);
});

test("the fourth link still warns when bot privileges prevent removal", async t => {
  const f = setup(t); f.chat.participants[0].isAdmin = false;
  for (let i = 0; i < 4; i++) await command(f, "example.com", "300@lid");
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 4);
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "remove" && row.result === "failed"));
});

test("admin promotion protects a member who already has three link offences", async t => {
  const f = setup(t);
  for (let i = 0; i < 3; i++) await command(f, "example.com", "300@lid");
  f.chat.participants[2].isAdmin = true;
  await command(f, "example.com", "300@lid");
  assert.equal(f.actions.filter(row => row.type === "remove").length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 3);
});

test("dry run does not increment link history or remove members at the threshold", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => { group.linkWarnings["300@lid"] = 3; group.warnings["300@lid"] = 3; group.dryRun = true; });
  await command(f, "example.com", "300@lid");
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 3);
});

test("destructive approval proposes fourth-offence removal and rechecks protection", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => { group.linkWarnings["300@lid"] = 3; group.warnings["300@lid"] = 3; group.approval = "destructive"; });
  await command(f, "example.com", "300@lid");
  const proposal = f.storage.get("1000@g.us").proposals.find(row => row.command === "remove");
  assert.ok(proposal);
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 4);
  f.chat.participants[2].isAdmin = true;
  await command(f, `.yes ${proposal.id}`);
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").proposals.find(row => row.id === proposal.id).status, "failed");
});

test("three saved link offences survive restart and the next link removes the member", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-links-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const f = setup(t, createAutomationStore(file));
  for (let i = 0; i < 3; i++) await command(f, "example.com", "300@lid");
  const restarted = setup(t, createAutomationStore(file));
  await command(restarted, "example.com", "300@c.us");
  assert.equal(restarted.actions.filter(row => row.type === "remove").length, 1);
  assert.equal(restarted.storage.get("1000@g.us").linkWarnings["300@lid"], 0);
  await command(restarted, ".rule remove builtin-link-removal");
  const disabled = createAutomationStore(file);
  assert.equal(disabled.get("1000@g.us").rules.some(rule => rule.id === "builtin-link-removal"), false);
});

test("link revocation errors still produce a targeted warning", async t => {
  const f = setup(t);
  f.controller = createController({ ...f.options, revoke: async () => { throw new Error("WhatsApp refused revocation"); } });
  await command(f, "https://example.com", "300@lid");
  assert.equal(f.actions.length, 0);
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
  const warning = f.sent.find(row => row.text.includes("warning 1"));
  assert.deepEqual(warning.options.mentions, ["300@lid"]);
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "delete" && row.result === "failed"));
});

test("antilink on restores deletion, warnings and fourth-offence removal", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => {
    group.rules = group.rules.filter(rule => !["builtin-links", "builtin-link-removal"].includes(rule.id));
    group.disabledCommands = ["delete", "warn", "remove"];
  });
  await command(f, ".antilink on");
  assert.match(f.sent.at(-1).text, /Ready to delete and warn/);
  assert.match(f.sent.at(-1).text, /from offence 4/);
  assert.equal(f.storage.get("1000@g.us").disabledCommands.length, 0);
  await command(f, "https://example.com", "300@lid");
  assert.equal(f.actions.length, 1);
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
  await command(f, ".antilink off");
  assert.equal(f.storage.get("1000@g.us").rules.find(rule => rule.id === "builtin-link-removal").enabled, false);
  await command(f, "https://example.com", "400@c.us");
  assert.equal(f.actions.length, 1);
  await command(f, ".antilink on", "400@c.us");
  assert.equal(f.storage.get("1000@g.us").rules.find(rule => rule.id === "builtin-links").enabled, false);
});

test("antilink diagnostics explain blockers while preserving intentional automation settings", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => { group.paused = true; group.autopilot = false; group.dryRun = true; group.approval = "all"; });
  f.chat.participants[0].isAdmin = false;
  await command(f, ".antilink on");
  const text = f.sent.at(-1).text;
  for (const pattern of [/Bot admin: false/, /set autopilot on/, /resume/, /set dryrun off/, /set approval off/]) assert.match(text, pattern);
  const group = f.storage.get("1000@g.us");
  assert.equal(group.paused, true); assert.equal(group.autopilot, false); assert.equal(group.dryRun, true); assert.equal(group.approval, "all");
});

test("help exposes moderation and automation commands to users", async t => {
  const f = setup(t);
  await command(f, ".help", "400@c.us");
  assert.match(f.sent.at(-1).text, /antilink on\|off\|status/);
  assert.match(f.sent.at(-1).text, /warn USER/);
  assert.match(f.sent.at(-1).text, /retrieve ID/);
  assert.match(f.sent.at(-1).text, /restorelink list/);
  assert.match(f.sent.at(-1).text, /restorelink ID restores one to the group chat/);
  assert.match(f.sent.at(-1).text, /reply to the media with \.v/);
  assert.match(f.sent.at(-1).text, /\.v list/);
  assert.match(f.sent.at(-1).text, /\.v ID/);
  assert.match(f.sent.at(-1).text, /\.viewonce is also supported/);
});

test("admins recover bot-deleted links; members and moderators cannot read the archive", async t => {
  const f = setup(t);
  await command(f, "https://example.com Important information", "300@lid");
  const saved = f.controller.archive.list("1000@g.us", row => row.deleted)[0];
  assert.ok(saved);
  await command(f, ".deleted", "400@c.us");
  assert.match(f.sent.at(-1).text, /Admins only/);
  await command(f, ".mod add 400@c.us");
  await command(f, `.retrieve ${saved.id}`, "400@c.us");
  assert.match(f.sent.at(-1).text, /Admins only/);
  await command(f, ".deleted");
  assert.ok(f.sent.at(-1).text.includes(saved.id));
  await command(f, `.retrieve ${saved.id}`);
  assert.match(f.sent.at(-1).text, /https:\/\/example.com Important information/);
});

test("restorelink restores the chosen or latest bot-deleted link into the group without changing offences", async t => {
  const f = setup(t);
  await command(f, "https://example.com First link", "300@lid");
  const first = f.controller.archive.list("1000@g.us", row => row.deleted)[0];
  await command(f, "https://example.org Second link", "300@lid");
  await command(f, ".restorelink list");
  assert.match(f.sent.at(-1).text, new RegExp(first.id));
  assert.match(f.sent.at(-1).text, /Restore to group: \.restorelink ID/);
  await command(f, `.restorelink ${first.id}`);
  assert.match(f.sent.at(-1).text, /Link restored to the group by an admin/);
  assert.match(f.sent.at(-1).text, /https:\/\/example.com First link/);
  assert.equal(first.deletedBy, "100@c.us");
  await command(f, ".restorelink");
  assert.match(f.sent.at(-1).text, /https:\/\/example.org Second link/);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 2);
  assert.equal(f.actions.filter(row => row.type === "delete").length, 2);
  assert.equal(f.storage.get("1000@g.us").audit.filter(row => row.command === "restorelink" && row.result === "success").length, 3);
});

test("private admin restorelink sends the link to the selected group and only confirms in private", async t => {
  const f = setup(t);
  await command(f, "https://example.com Group link", "300@lid");
  const saved = f.controller.archive.list("1000@g.us", row => row.deleted)[0];
  const posted = [];
  f.chat.sendMessage = async content => posted.push(content);
  await command(f, ".use 1000@g.us", "200@c.us", true);
  await command(f, `.restorelink ${saved.id}`, "200@c.us", true);
  assert.equal(posted.length, 1);
  assert.match(posted[0], /https:\/\/example.com Group link/);
  assert.match(f.sent.at(-1).text, /restored to Test group/);
  assert.doesNotMatch(f.sent.at(-1).text, /https:\/\/example.com/);
});

test("restorelink enforces admin permissions, matching archived records and dry run", async t => {
  const f = setup(t);
  await command(f, "https://example.com Moderated link", "300@lid");
  const saved = f.controller.archive.list("1000@g.us", row => row.deleted)[0];
  await command(f, ".mod add 400@c.us");
  for (const actor of ["300@lid", "400@c.us"]) {
    await command(f, `.restorelink ${saved.id}`, actor);
    assert.match(f.sent.at(-1).text, /Admins only/);
  }
  const ordinary = f.message("Ordinary deleted message", "300@lid");
  await f.controller.handleMessage(ordinary);
  f.controller.handleRevocation({ ...ordinary, type: "revoked", body: "" });
  const userDeleted = f.controller.archive.get("1000@g.us", ordinary.id._serialized);
  await command(f, `.restorelink ${userDeleted.id}`);
  assert.match(f.sent.at(-1).text, /not a link deleted by the bot/);
  const foreign = { ...f.message("https://example.net Foreign link", "300@lid"), from: "2000@g.us", id: { _serialized: "foreign-link" } };
  f.controller.archive.observe(foreign);
  f.controller.archive.suppress(foreign);
  f.controller.archive.revoked(foreign, foreign);
  const foreignRow = f.controller.archive.get("2000@g.us", foreign.id._serialized);
  await command(f, `.restorelink ${foreignRow.id}`);
  assert.match(f.sent.at(-1).text, /No saved bot-deleted link found/);
  const posted = [];
  f.chat.sendMessage = async content => posted.push(content);
  await command(f, ".set dryrun on");
  await command(f, `.restorelink ${saved.id}`);
  assert.match(f.sent.at(-1).text, /Dry run: restorelink/);
  assert.equal(posted.length, 0);
});

test("private admin recovery delivers the saved message to that admin's chat", async t => {
  const f = setup(t);
  const original = f.message("Meeting starts at nine", "300@lid");
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, body: "", type: "revoked" });
  await command(f, ".use 1000@g.us", "200@c.us", true);
  await command(f, ".retrieve", "200@c.us", true);
  assert.match(f.sent.at(-1).text, /Meeting starts at nine/);
});

test("view-once retrieval returns available media and explains unavailable media", async t => {
  const f = setup(t);
  const incoming = f.message("", "300@lid");
  incoming.id._serialized = "viewonce-photo";
  Object.assign(incoming, { type: "image", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("picture").toString("base64"), filename: "photo.png" }) });
  await f.controller.handleMessage(incoming);
  const saved = f.controller.archive.get("1000@g.us", "viewonce-photo");
  await command(f, `.viewonce ${saved.id}`);
  assert.equal(f.sent.at(-1).text.mimetype, "image/png");
  assert.equal(Buffer.from(f.sent.at(-1).text.data, "base64").toString(), "picture");
  const hidden = f.message("", "300@lid");
  hidden.id._serialized = "hidden-photo";
  Object.assign(hidden, { type: "image", _data: { isViewOnce: true }, downloadMedia: async () => undefined });
  await f.controller.handleMessage(hidden);
  await command(f, ".viewonce");
  assert.match(f.sent.at(-1).text, /cannot be retrieved/);
});

test("v lists view-once records and retrieves normal media by latest, ID, or reply", async t => {
  const f = setup(t);
  const incoming = f.message("", "300@lid");
  incoming.id._serialized = "short-viewonce";
  Object.assign(incoming, { type: "image", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("saved picture").toString("base64"), filename: "photo.png" }) });
  await f.controller.handleMessage(incoming);
  const saved = f.controller.archive.get("1000@g.us", incoming.id._serialized);
  await command(f, ".v list");
  assert.ok(f.sent.at(-1).text.includes(saved.id));
  assert.match(f.sent.at(-1).text, /Retrieve: \.v ID/);
  for (const text of [".v", `.v ${saved.id}`]) {
    await command(f, text);
    assert.equal(f.sent.at(-1).text.mimetype, "image/png");
    assert.equal(Buffer.from(f.sent.at(-1).text.data, "base64").toString(), "saved picture");
    assert.equal(f.sent.at(-1).text.isViewOnce, undefined);
    assert.deepEqual(f.sent.at(-1).options, { isViewOnce: false });
  }
  const request = f.message(".v");
  request.hasQuotedMsg = true; request.getQuotedMessage = async () => incoming;
  await f.controller.handleMessage(request);
  assert.equal(f.sent.at(-1).text.mimetype, "image/png");
  assert.deepEqual(f.sent.at(-1).options, { isViewOnce: false });
  assert.ok(f.storage.get("1000@g.us").audit.filter(row => row.command === "viewonce").every(row => row.result === "success"));
});

test("v reposts saved view-once video with repeatable viewing in private admin control", async t => {
  const f = setup(t);
  const incoming = f.message("", "300@lid");
  incoming.id._serialized = "viewonce-video";
  Object.assign(incoming, { type: "video", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "video/mp4", data: Buffer.from("saved video").toString("base64"), filename: "clip.mp4" }) });
  await f.controller.handleMessage(incoming);
  const saved = f.controller.archive.get("1000@g.us", incoming.id._serialized);
  await command(f, ".use 1000@g.us", "200@c.us", true);
  await command(f, `.v ${saved.id}`, "200@c.us", true);
  assert.equal(f.sent.at(-1).text.mimetype, "video/mp4");
  assert.equal(Buffer.from(f.sent.at(-1).text.data, "base64").toString(), "saved video");
  assert.deepEqual(f.sent.at(-1).options, { isViewOnce: false });
});

test("v retains admin permissions and explains when WhatsApp did not supply a file", async t => {
  const f = setup(t);
  const hidden = f.message("", "300@lid");
  hidden.id._serialized = "short-hidden-viewonce";
  Object.assign(hidden, { type: "image", _data: { isViewOnce: true }, downloadMedia: async () => undefined });
  await f.controller.handleMessage(hidden);
  await command(f, ".mod add 400@c.us");
  for (const actor of ["300@lid", "400@c.us"]) {
    await command(f, ".v", actor);
    assert.match(f.sent.at(-1).text, /Admins only/);
  }
  await command(f, ".v");
  assert.match(f.sent.at(-1).text, /cannot be retrieved/);
  assert.match(f.sent.at(-1).text, /resend it as normal media/);
});

test("recovery cannot use an ID or quote from a different group", async t => {
  const f = setup(t);
  const id = f.controller.archive.observe({ id: { _serialized: "other-group" }, from: "2000@g.us", author: "300@lid", body: "Secret", type: "chat" });
  await command(f, `.retrieve ${id}`);
  assert.match(f.sent.at(-1).text, /No saved message found/);
  const request = f.message(".retrieve");
  request.hasQuotedMsg = true;
  request.getQuotedMessage = async () => ({ from: "2000@g.us", id: { _serialized: "other-group" }, body: "Secret", type: "chat" });
  await f.controller.handleMessage(request);
  assert.match(f.sent.at(-1).text, /No saved message found/);
});

test("view-once retrieval retries media still available from the original message", async t => {
  const f = setup(t);
  const incoming = f.message("", "300@lid");
  incoming.id._serialized = "retry-viewonce";
  Object.assign(incoming, { type: "image", hasMedia: true, _data: { isViewOnce: true }, downloadMedia: async () => undefined });
  await f.controller.handleMessage(incoming);
  const saved = f.controller.archive.get("1000@g.us", "retry-viewonce");
  await f.controller.archive.waitFor(saved.id);
  f.client.getMessageById = async id => {
    assert.equal(id, "retry-viewonce");
    return { ...incoming, downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("retried picture").toString("base64") }) };
  };
  await command(f, `.viewonce ${saved.id}`);
  assert.equal(Buffer.from(f.sent.at(-1).text.data, "base64").toString(), "retried picture");
});

test("a media retry rejects a fetched message belonging to another group", async t => {
  const f = setup(t);
  const incoming = f.message("", "300@lid");
  incoming.id._serialized = "isolated-viewonce";
  Object.assign(incoming, { type: "image", hasMedia: true, _data: { isViewOnce: true }, downloadMedia: async () => undefined });
  await f.controller.handleMessage(incoming);
  const saved = f.controller.archive.get("1000@g.us", "isolated-viewonce");
  await f.controller.archive.waitFor(saved.id);
  f.client.getMessageById = async () => ({ ...incoming, from: "2000@g.us", body: "Private content",
    downloadMedia: async () => { throw new Error("A cross-group download must never start"); } });
  await command(f, `.viewonce ${saved.id}`);
  assert.match(f.sent.at(-1).text, /cannot be retrieved/);
  assert.equal(f.controller.archive.get("1000@g.us", saved.id).body, "");
});

test("media downloading in the background does not block link deletion and warnings", async t => {
  const f = setup(t);
  let release;
  const incoming = f.message("https://example.com", "300@lid");
  Object.assign(incoming, { hasMedia: true, downloadMedia: () => new Promise(resolve => { release = resolve; }) });
  await f.controller.handleMessage(incoming);
  assert.equal(f.actions.filter(row => row.type === "delete").length, 1);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
  release(undefined);
  const saved = f.controller.archive.list("1000@g.us", row => row.deleted)[0];
  await f.controller.archive.waitFor(saved.id);
});

test("welcomes, bot promotion, raid locking and panic use real controller event paths", async t => {
  const f = setup(t);
  f.chat.groupMetadata = { announce: false };
  await addRule(f, "WHEN bot_became_admin THEN say Bot is an admin");
  await command(f, ".set raidcount 2");
  await command(f, ".rule enable builtin-raid");
  await start(f);
  await f.controller.notification("member_joined", f.notification("300@c.us"));
  await f.controller.notification("member_joined", f.notification("400@c.us"));
  assert.equal(f.sent.filter(row => row.text.startsWith("👋")).length, 2);
  assert.deepEqual(f.sent.find(row => row.text.startsWith("👋")).options.mentions, ["300@lid"]);
  assert.ok(f.actions.some(action => action.type === "lock" && action.value));
  await f.controller.notification("admin_changed", f.notification("100@c.us", "promote", "promotion"));
  assert.ok(f.sent.some(row => row.text === "Bot is an admin"));
  await command(f, ".panic");
  const count = f.sent.filter(row => row.text.startsWith("👋")).length;
  await f.controller.notification("member_joined", f.notification("300@lid", "add", "paused-join"));
  assert.equal(f.sent.filter(row => row.text.startsWith("👋")).length, count);
  await command(f, ".resume");
  await f.controller.notification("member_joined", f.notification("300@lid", "add", "resumed-join"));
  assert.equal(f.sent.filter(row => row.text.startsWith("👋")).length, count + 1);
});

test("the activity scheduler sends once, respects panic and records the system actor", async t => {
  const f = setup(t);
  await command(f, ".activity add daily 09:00 | Morning meeting");
  await command(f, ".panic");
  await start(f);
  assert.equal(f.sent.filter(row => row.text.startsWith("📅 Activities")).length, 0);
  await command(f, ".resume");
  await f.controller.tick(); await f.controller.tick();
  assert.equal(f.sent.filter(row => row.text.startsWith("📅 Activities")).length, 1);
  assert.equal(f.storage.get("1000@g.us").lastAnnouncementDate, "2026-10-02");
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "agenda" && row.actor.type === "system"));
});

test("different current admins manage games and new members receive their updated schedule", async t => {
  const f = setup(t);
  f.chat.participants.push({ id: { _serialized: "500@c.us" }, isAdmin: true });
  await command(f, ".activity add today 20:00 | Truth or Dare", "200@c.us");
  await command(f, ".activity add tomorrow 19:00 | Sticker battle", "500@c.us");
  const id = f.storage.get("1000@g.us").activities[0].id;
  await command(f, `.activity edit ${id} today 21:00 | Truth or Dare — hosted by another admin`, "500@c.us");
  assert.equal(f.storage.get("1000@g.us").activities.length, 2);
  await command(f, ".activity add daily 10:00 | Unauthorized", "300@lid");
  await command(f, `.activity edit ${id} daily 10:00 | Unauthorized`, "300@lid");
  assert.equal(f.storage.get("1000@g.us").activities.length, 2);
  assert.equal(f.storage.get("1000@g.us").activities[0].time, "21:00");
  await command(f, ".activities week", "300@lid");
  assert.match(f.sent.at(-1).text, /Sticker battle/);
  await start(f);
  await f.controller.notification("member_joined", f.notification("400@c.us"));
  const welcome = f.sent.find(row => row.text.startsWith("👋"));
  assert.match(welcome.text, /21:00 — Truth or Dare/);
  assert.match(welcome.text, /2026-10-03 19:00 — Sticker battle/);
  assert.match(welcome.text, /Group rules/);
  assert.deepEqual(welcome.options.mentions, ["400@c.us"]);
  assert.match(f.sent.find(row => row.text.startsWith("📅 Activities for 2026-10-02")).text, /Truth or Dare/);
  f.chat.participants.find(person => person.id._serialized === "500@c.us").isAdmin = false;
  await command(f, `.activity remove ${id}`, "500@c.us");
  assert.equal(f.storage.get("1000@g.us").activities.length, 2);
});

test("archive cleanup failure does not prevent scheduled rules from running", async t => {
  const f = setup(t);
  await addRule(f, 'WHEN schedule("07:00") THEN ping');
  f.controller.archive.sweep = () => { throw new Error("Archive cleanup failed"); };
  await start(f);
  assert.equal(f.sent.filter(row => row.text === "pong").length, 1);
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.command === "ping" && row.result === "success"));
});

test("local mute enforcement, FAQ and explicit rule targets work through message handling", async t => {
  const f = setup(t);
  await command(f, ".mute 300@c.us 10");
  await command(f, "ordinary message", "300@lid");
  assert.ok(f.actions.some(action => action.type === "delete"));
  await command(f, ".unmute 300@c.us");
  await command(f, ".addcmd price Tickets cost 5,000 UGX");
  await command(f, "price", "300@lid");
  assert.equal(f.sent.at(-1).text, "Tickets cost 5,000 UGX");
  await addRule(f, 'WHEN message_matches("trigger") THEN warn 400@c.us Fixed target');
  await command(f, "trigger", "300@lid");
  assert.equal(f.storage.get("1000@g.us").warnings["400@c.us"], 1);
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], undefined);
});

test("pending destructive proposals survive restart and approval rechecks protection", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-proposals-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "state.json");
  const f = setup(t, createAutomationStore(file));
  await command(f, ".set approval destructive");
  await addRule(f, 'WHEN message_matches("remove me") THEN remove @sender');
  await command(f, "remove me", "300@lid");
  assert.equal(f.actions.length, 0);
  const proposal = f.storage.get("1000@g.us").proposals.at(-1);
  const restarted = setup(t, createAutomationStore(file));
  await command(restarted, `.yes ${proposal.id}`);
  assert.ok(restarted.actions.some(row => row.type === "remove"));
  assert.equal(restarted.storage.get("1000@g.us").proposals.at(-1).status, "approved");
  f.setTime("2026-10-02T04:02:00Z");
  await command(f, "remove me", "400@c.us");
  const protectedProposal = f.storage.get("1000@g.us").proposals.at(-1);
  const promoted = setup(t, createAutomationStore(file));
  promoted.chat.participants.at(-1).isAdmin = true;
  await command(promoted, `.yes ${protectedProposal.id}`);
  assert.equal(promoted.actions.length, 0);
  assert.equal(promoted.storage.get("1000@g.us").proposals.at(-1).status, "failed");
});

test("failed proposal announcements can be retried instead of silently remaining pending", async t => {
  const f = setup(t);
  await command(f, ".set approval destructive");
  const ctx = { groupId: "1000@g.us", actor: { type: "system", id: "test" }, args: { target: "300@lid" }, reply: async () => {} };
  const send = f.chat.sendMessage;
  f.chat.sendMessage = async () => { throw new Error("Send failed"); };
  assert.equal((await f.controller.engine.executeCommand("remove", ctx)).ok, false);
  assert.equal(f.storage.get("1000@g.us").proposals.at(-1).status, "failed");
  f.chat.sendMessage = send;
  assert.equal((await f.controller.engine.executeCommand("remove", ctx)).status, "proposed");
  assert.equal(f.storage.get("1000@g.us").proposals.at(-1).status, "pending");
});

test("rule chains stop at depth three even with distinct warning-trigger rules", async t => {
  const f = setup(t);
  for (let i = 0; i < 6; i++) await addRule(f, `WHEN warn_count_reached(${i + 1}) THEN warn @sender`);
  await command(f, ".warn 300@lid");
  const rows = f.storage.get("1000@g.us").audit.filter(row => row.command === "warn");
  assert.equal(rows.length, 4);
  assert.ok(rows.every(row => row.result === "success"));
  // Depth limiting is also enforced for nested aliases, independent of rule IDs.
  await command(f, ".alias one ping");
  await command(f, ".alias two one");
  await command(f, ".alias three two");
  await command(f, ".alias four three");
  await command(f, ".alias five four");
  const before = f.sent.filter(row => row.text === "pong").length;
  await command(f, ".five");
  assert.equal(f.sent.filter(row => row.text === "pong").length, before);
  assert.ok(f.storage.get("1000@g.us").audit.some(row => row.error?.includes("maximum depth")));
});

test("editing a default rule preserves its settings and changes its actual behavior", async t => {
  const f = setup(t);
  await command(f, ".rule edit builtin-links WHEN link_detected IF sender_role=member THEN warn @sender New link rule");
  const rule = f.storage.get("1000@g.us").rules.find(rule => rule.id === "builtin-links");
  assert.equal(rule.cooldownMs, 0); assert.equal(rule.enabled, true);
  await command(f, "https://example.com", "300@lid");
  assert.equal(f.actions.length, 0);
  assert.match(f.sent.at(-1).text, /New link rule/);
});

test("automatic mass deletion skips bot messages and admins and counts each selected message", async t => {
  const f = setup(t);
  f.chat.fetchMessages = async () => [
    { id: { _serialized: "bot" }, fromMe: true, from: "1000@g.us" },
    { id: { _serialized: "admin" }, author: "200@c.us", from: "1000@g.us" },
    { id: { _serialized: "member" }, author: "300@lid", from: "1000@g.us" }
  ];
  const result = await f.controller.engine.executeCommand("massdelete", {
    groupId: "1000@g.us", actor: { type: "system", id: "test" }, args: "3", reply: async () => {}
  });
  assert.equal(result.ok, true);
  assert.deepEqual(f.actions, [{ type: "delete", id: "member" }]);
  assert.equal(f.storage.get("1000@g.us").destructiveActions.at(-1).units, 1);
});

test("storage failure prevents external actions and pauses automation until recovery", async t => {
  const f = setup(t);
  const update = f.storage.update;
  f.storage.update = () => { throw new Error("Disk is full"); };
  const result = await f.controller.engine.executeCommand("remove", {
    groupId: "1000@g.us", actor: { type: "system", id: "test" }, args: { target: "300@lid" }, reply: async () => {}
  });
  assert.equal(result.ok, false); assert.equal(result.auditError, true);
  assert.equal(f.actions.length, 0);
  f.storage.update = update;
  assert.equal(f.controller.engine.auditPaused.has("1000@g.us"), true);
  await command(f, ".resume");
  assert.equal(f.controller.engine.auditPaused.has("1000@g.us"), false);
});
