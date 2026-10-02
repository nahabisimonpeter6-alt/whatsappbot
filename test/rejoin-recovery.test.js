const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("./helpers/control-fixture.cjs");
const { createController } = require("../src/controller");
const { createMessageArchive } = require("../src/message-archive");

function setup(t, archive) {
  const f = fixture(); let number = 0;
  f.controller = createController({ ...f.options, archive, revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) });
  f.controller.start(); t.after(() => f.controller.stop());
  f.message = (body, extra = {}) => ({ body, author: "300@lid", from: "1000@g.us", type: "chat", fromMe: false,
    id: { _serialized: `incoming-${++number}`, remote: "1000@g.us" }, getChat: async () => f.chat,
    reply: async text => f.sent.push({ text }), ...extra });
  f.join = (id, recipient = "300@c.us") => f.controller.notification("member_joined", {
    chatId: "1000@g.us", recipientIds: [recipient], id: { _serialized: id }, getChat: async () => f.chat
  });
  f.send = body => f.controller.handleMessage(f.message(body));
  return f;
}

test("after fourth-link removal and re-addition the first three links warn again", async t => {
  const f = setup(t);
  for (let index = 0; index < 4; index++) await f.send("https://example.com");
  assert.equal(f.actions.filter(row => row.type === "remove").length, 1);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 0);
  await f.join("rejoin");
  for (let index = 1; index <= 3; index++) {
    await f.send("https://example.com");
    assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], index);
    assert.equal(f.actions.filter(row => row.type === "remove").length, 1);
  }
  await f.send("https://example.com");
  assert.equal(f.actions.filter(row => row.type === "remove").length, 2);
});

test("rejoining resets both ID aliases, preserves manual warnings, and ignores a duplicate join", async t => {
  const f = setup(t);
  f.storage.update("1000@g.us", group => {
    group.warnings = { "300@lid": 5, "300@c.us": 4 };
    group.linkWarnings = { "300@lid": 3, "300@c.us": 2 };
  });
  await f.join("fresh-join");
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 2);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@c.us"], 0);
  await f.send("example.com");
  assert.ok(f.sent.some(row => typeof row.text === "string" && row.text.includes("warning 1:")));
  await f.join("fresh-join", "300@lid");
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
});

test("failed removal retains offence counts and a join still resets them while panic is active", async t => {
  const f = setup(t);
  f.chat.removeParticipants = async () => ({ status: 403 });
  for (let i = 0; i < 4; i++) await f.send("example.com");
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 4);
  f.storage.update("1000@g.us", group => { group.paused = true; });
  await f.join("paused-rejoin");
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 0);
});

test("a new membership invalidates pending link removals and old warning undo", async t => {
  const f = setup(t);
  await f.send("example.com");
  const oldWarning = f.storage.get("1000@g.us").audit.find(row => row.command === "warn");
  f.storage.update("1000@g.us", group => { group.linkWarnings["300@lid"] = 3; group.warnings["300@lid"] = 3; group.approval = "destructive"; });
  await f.send("example.com");
  const proposal = f.storage.get("1000@g.us").proposals.find(row => row.command === "remove");
  await f.join("new-cycle");
  assert.equal(f.storage.get("1000@g.us").proposals.find(row => row.id === proposal.id).status, "rejected");
  f.storage.update("1000@g.us", group => { group.approval = "off"; });
  await f.send("example.com");
  await f.controller.handleMessage(f.message(`.undo ${oldWarning.id}`, { author: "200@c.us" }));
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
});

test("user-deleted text is automatically reposted once without a command", async t => {
  const f = setup(t);
  const original = f.message("Meeting starts at nine");
  await f.controller.handleMessage(original);
  const revoked = { ...original, body: "", type: "revoked", protocolMessageKey: { $1: original.id._serialized } };
  f.controller.handleRevocation(revoked);
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("Deleted message recovered")).length, 1);
  assert.ok(f.sent.some(row => typeof row.text === "string" && row.text.includes("Meeting starts at nine")));
  f.controller.handleRevocation(revoked);
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("Deleted message recovered")).length, 1);
});

test("view-once media is automatically redisplayed as ordinary media once", async t => {
  const f = setup(t);
  const original = f.message("Photo caption", { type: "image", hasMedia: false, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("view once picture").toString("base64") }) });
  await f.controller.handleMessage(original);
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype === "image/png").length, 1);
  await f.controller.handleMessage(original);
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype === "image/png").length, 1);
});

test("user-deleted media is recovered after its background download finishes", async t => {
  const f = setup(t); let release;
  const original = f.message("Caption", { type: "image", hasMedia: true,
    downloadMedia: () => new Promise(resolve => { release = resolve; }) });
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" });
  release({ mimetype: "image/png", data: Buffer.from("deleted picture").toString("base64") });
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype === "image/png").length, 1);
  assert.ok(f.sent.some(row => typeof row.text === "string" && row.text.includes("Caption")));
});

test("automatic recovery does not restore moderated links or view-once captions containing links", async t => {
  const f = setup(t);
  const original = f.message("https://example.com", { type: "image", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("picture").toString("base64") }) });
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" });
  await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype === "image/png").length, 0);
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("recovered")).length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
});

test("an archive marker failure does not prevent moderation or cause an automatic repost", async t => {
  const f = setup(t);
  f.controller.archive.suppress = () => { throw new Error("Archive is temporarily unwritable"); };
  const original = f.message("example.com");
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" });
  await f.controller.recovery.drain();
  assert.equal(f.actions.filter(row => row.type === "delete").length, 1);
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("recovered")).length, 0);
});

test("a failed automatic media send retries without reposting the header twice", async t => {
  const f = setup(t);
  const send = f.chat.sendMessage; let failed = false;
  f.chat.sendMessage = async (text, options) => {
    if (text?.mimetype && !failed) { failed = true; throw new Error("Temporary send error"); }
    return send(text, options);
  };
  const original = f.message("", { type: "image", _data: { isViewOnce: true }, downloadMedia: async () => ({ mimetype: "image/png", data: "aW1hZ2U=" }) });
  await f.controller.handleMessage(original); await f.controller.recovery.drain();
  await f.controller.handleMessage(original); await f.controller.recovery.drain();
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("redisplayed")).length, 1);
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 1);
});

test("unavailable view-once media reports its limitation once instead of pretending to send an image", async t => {
  const f = setup(t);
  const original = f.message("", { type: "image", _data: { isViewOnce: true }, downloadMedia: async () => undefined });
  await f.controller.handleMessage(original); await f.controller.recovery.drain();
  assert.ok(f.sent.some(row => typeof row.text === "string" && row.text.includes("View-once media unavailable")));
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 0);
});

test("automatic recovery honors switches, panic, dry run and admin approval", async t => {
  const f = setup(t);
  for (const change of [{ repostViewOnce: false }, { paused: true }, { dryRun: true }, { approval: "all" }]) {
    f.storage.update("1000@g.us", group => Object.assign(group, { repostViewOnce: true, paused: false, dryRun: false, approval: "off" }, change));
    const original = f.message("", { type: "image", _data: { isViewOnce: true }, downloadMedia: async () => ({ mimetype: "image/png", data: "aW1hZ2U=" }) });
    await f.controller.handleMessage(original); await f.controller.recovery.drain();
    assert.equal(f.sent.filter(row => row.text?.mimetype).length, 0);
  }
  const proposal = f.storage.get("1000@g.us").proposals.find(row => row.command === "repost");
  assert.ok(proposal);
  await f.controller.handleMessage(f.message(`.yes ${proposal.id}`, { author: "200@c.us" }));
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 1);
});

test("saved repost records prevent duplicate delivery after restart", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-repost-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.json");
  const f = setup(t, createMessageArchive(file));
  const original = f.message("Restart test");
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, body: "", type: "revoked" });
  await f.controller.recovery.drain();
  const next = setup(t, createMessageArchive(file));
  next.controller.handleRevocation({ ...original, body: "", type: "revoked" });
  await next.controller.recovery.drain();
  assert.equal(next.sent.length, 0);
});
