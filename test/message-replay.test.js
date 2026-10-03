const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { fixture } = require("./helpers/control-fixture.cjs");
const { createController } = require("../src/controller");
const { createMessageArchive } = require("../src/message-archive");

function setup(t, archive) {
  const f = fixture(); let count = 0;
  f.controller = createController({ ...f.options, archive,
    revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) });
  f.controller.start(); t.after(() => f.controller.stop());
  f.message = (body, extra = {}) => ({ body, from: "1000@g.us", author: "300@lid", fromMe: false, type: "chat",
    id: { _serialized: `replay-${++count}`, remote: "1000@g.us" },
    getChat: async () => f.chat, reply: async text => f.sent.push({ text }), ...extra });
  f.photo = () => f.message("Saved photo caption", { type: "image", hasMedia: true, _data: { isViewOnce: true },
    downloadMedia: async () => ({ mimetype: "image/png", data: "aW1hZ2U=" }) });
  f.drain = async () => { await f.controller.contentFilter.drain(); await f.controller.recovery.drain(); };
  return f;
}

test("parallel and repeated deliveries of one group message produce one reply", async t => {
  const f = setup(t), message = f.message(".ping");
  await Promise.all(Array.from({ length: 5 }, () => f.controller.handleMessage({ ...message })));
  await f.controller.handleMessage(message);
  assert.equal(f.sent.filter(row => row.text === "pong").length, 1);
});

test("identical text in different messages is still handled separately", async t => {
  const f = setup(t);
  await f.controller.handleMessage(f.message(".ping"));
  await f.controller.handleMessage(f.message(".ping"));
  assert.equal(f.sent.filter(row => row.text === "pong").length, 2);
});

test("one link delivered repeatedly is deleted and warned once without premature removal", async t => {
  const f = setup(t), message = f.message("https://example.com");
  await Promise.all(Array.from({ length: 5 }, () => f.controller.handleMessage({ ...message })));
  assert.equal(f.actions.filter(row => row.type === "delete").length, 1);
  assert.equal(f.actions.filter(row => row.type === "remove").length, 0);
  assert.equal(f.storage.get("1000@g.us").linkWarnings["300@lid"], 1);
  assert.equal(f.sent.filter(row => typeof row.text === "string" && row.text.includes("warning 1:")).length, 1);
});

test("duplicate direct-chat messages and renamed message IDs reply once", async t => {
  const f = setup(t), message = f.message(".ping", { from: "300@c.us", author: undefined, id: { $1: "dm-ping" } });
  await Promise.all([f.controller.handleMessage(message), f.controller.handleMessage({ ...message })]);
  await f.controller.handleMessage(message);
  assert.equal(f.sent.filter(row => row.text === "pong").length, 1);
});

test("saved group replay claims stop duplicate commands after a controller restart", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-message-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.json");
  const first = setup(t, createMessageArchive(file, { now: () => new Date("2026-10-02T04:00:00Z") }));
  const original = first.message(".ping");
  await first.controller.handleMessage(original); first.controller.stop();
  const next = setup(t, createMessageArchive(file, { now: () => new Date("2026-10-02T04:00:00Z") }));
  await next.controller.handleMessage(next.message(".ping", { id: original.id }));
  assert.equal(next.sent.length, 0);
  await next.controller.handleMessage(next.message(".ping"));
  assert.equal(next.sent.filter(row => row.text === "pong").length, 1);
});

test("deleting a previously redisplayed view-once photo does not post it again", async t => {
  const f = setup(t), original = f.photo();
  await f.controller.handleMessage(original); await f.drain();
  assert.equal(f.sent.length, 1); // The attribution is the photo caption.
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" }, original);
  await f.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 1);
  assert.equal(f.sent.filter(row => typeof row.text === "string").length, 0);
  assert.match(f.sent[0].options.caption, /Saved photo caption/);
});

test("simultaneous view-once and deletion events share one delivery", async t => {
  const f = setup(t); let finish;
  const original = f.photo(); original.downloadMedia = () => new Promise(resolve => { finish = resolve; });
  await f.controller.handleMessage(original);
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" }, original);
  finish({ mimetype: "image/png", data: "aW1hZ2U=" }); await f.drain();
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 1);
  assert.equal(f.sent.filter(row => typeof row.text === "string").length, 0);
});

test("cross-reason recovery retries only missing media after a partial failure", async t => {
  const f = setup(t), original = f.photo(); original.body = "Long caption ".repeat(120);
  const send = f.chat.sendMessage; let fail = true;
  f.chat.sendMessage = async (text, options) => {
    if (text?.mimetype && fail) { fail = false; throw new Error("Media send failed"); }
    return send(text, options);
  };
  await f.controller.handleMessage(original); await f.drain();
  assert.equal(f.sent.length, 1);
  f.controller.handleRevocation({ ...original, type: "revoked", body: "" }, original); await f.drain();
  assert.equal(f.sent.filter(row => typeof row.text === "string").length, 1);
  assert.equal(f.sent.filter(row => row.text?.mimetype).length, 1);
});

test("persisted view-once delivery prevents a deletion repost after restart", async t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-recovery-replay-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.json");
  const options = { now: () => new Date("2026-10-02T04:00:00Z") };
  const first = setup(t, createMessageArchive(file, options)), original = first.photo();
  await first.controller.handleMessage(original); await first.drain(); first.controller.stop();
  const next = setup(t, createMessageArchive(file, options));
  next.controller.handleRevocation({ ...original, type: "revoked", body: "" }, original); await next.drain();
  assert.equal(next.sent.length, 0);
});
