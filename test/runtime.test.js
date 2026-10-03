const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter, once } = require("node:events");
const { createRuntime } = require("../src/bot");
const logger = { log() {}, warn() {}, error() {} };

function fixture(initialize = async () => {}, options = {}) {
  const exits = [];
  const client = new EventEmitter();
  let destroyed = 0;
  client.initialize = initialize;
  client.destroy = async () => { destroyed++; };
  const runtime = createRuntime({ client, port: 0, logger, onExit: code => exits.push(code), ...options });
  return { client, runtime, exits, destroyed: () => destroyed };
}

async function listen(f) {
  if (!f.runtime.server.listening) await once(f.runtime.server, "listening");
  return `http://127.0.0.1:${f.runtime.server.address().port}`;
}

test("readiness is 503 before pairing and 200 only after ready", async t => {
  const f = fixture(); t.after(() => f.runtime.stop());
  const base = await listen(f);
  let response = await fetch(`${base}/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, ready: false });
  response = await fetch(`${base}/live`);
  assert.equal(response.status, 200);
  f.client.emit("ready");
  response = await fetch(`${base}/health`);
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { ok: true, ready: true });
});

test("initialization rejection closes HTTP and exits unsuccessfully", async () => {
  const f = fixture(async () => { throw new Error("Chromium failed"); });
  await f.runtime.initialization;
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.destroyed(), 1);
  assert.equal(f.runtime.server.listening, false);
});

test("synchronous initialization errors are also fatal", async () => {
  const f = fixture(() => { throw new Error("Invalid configuration"); });
  await f.runtime.initialization;
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.runtime.server.listening, false);
});

test("a stalled browser startup exits so the hosting platform can restart the bot", async t => {
  const f = fixture(() => new Promise(() => {}), { startupTimeoutMs: 20 });
  t.after(() => f.runtime.stop()); await listen(f);
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.runtime.stop();
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.destroyed(), 1);
});

test("QR pairing waits for the user, but stalled startup after authentication times out", async t => {
  t.mock.method(require("qrcode-terminal"), "generate", () => {});
  const f = fixture(undefined, { startupTimeoutMs: 20 });
  t.after(() => f.runtime.stop()); await listen(f); await f.runtime.initialization;
  f.client.emit("qr", "pairing-needed");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.exits, []);
  f.client.emit("authenticated");
  await new Promise(resolve => setTimeout(resolve, 50));
  await f.runtime.stop();
  assert.deepEqual(f.exits, [1]);
});

test("successful readiness cancels the startup watchdog", async t => {
  const f = fixture(undefined, { startupTimeoutMs: 20 });
  t.after(() => f.runtime.stop()); await listen(f); await f.runtime.initialization;
  f.client.emit("authenticated"); f.client.emit("ready");
  await new Promise(resolve => setTimeout(resolve, 50));
  assert.deepEqual(f.exits, []);
});

test("a browser disconnect after ready stops the runtime instead of leaving stale readiness", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  f.client.pupBrowser = new EventEmitter(); f.client.pupBrowser.connected = true;
  f.client.emit("ready");
  f.client.pupBrowser.connected = false;
  f.client.pupBrowser.emit("disconnected");
  await f.runtime.stop();
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.destroyed(), 1);
  assert.equal(f.runtime.server.listening, false);
});

for (const event of ["close", "error"]) {
  test(`WhatsApp page ${event} stops the runtime for restart`, async t => {
    const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
    f.client.pupPage = new EventEmitter(); f.client.pupPage.isClosed = () => false;
    f.client.emit("ready");
    f.client.pupPage.emit(event, new Error("Page crashed"));
    await f.runtime.stop();
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.destroyed(), 1);
  });
}

test("health rejects a dead browser immediately and the monitor catches missed disconnect events", async t => {
  const f = fixture(undefined, { browserCheckIntervalMs: 100 });
  t.after(() => f.runtime.stop()); const base = await listen(f); await f.runtime.initialization;
  f.client.pupBrowser = new EventEmitter(); f.client.pupBrowser.connected = true;
  f.client.emit("ready");
  f.client.pupBrowser.connected = false;
  const response = await fetch(`${base}/health`);
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { ok: false, ready: false });
  await new Promise(resolve => setTimeout(resolve, 150));
  await f.runtime.stop();
  assert.deepEqual(f.exits, [1]);
});

test("expected browser shutdown preserves a successful exit code", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  f.client.pupBrowser = new EventEmitter(); f.client.pupBrowser.connected = true;
  f.client.emit("ready");
  f.client.destroy = async () => f.client.pupBrowser.emit("disconnected");
  await f.runtime.stop(0);
  assert.deepEqual(f.exits, [0]);
});

test("runtime recovers readiness when a paired session was synced before listener registration", async t => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; })); t.after(() => f.runtime.stop()); await listen(f);
  const window = {
    require: () => ({ Socket: { hasSynced: true } }),
    onAppStateHasSyncedEvent: async () => { f.client.emit("authenticated"); f.client.emit("ready"); }
  };
  f.client.pupPage = { evaluate: fn => require("node:vm").runInNewContext(`(${fn.toString()})()`, { window }) };
  release();
  await f.runtime.initialization;
  const response = await fetch(`http://127.0.0.1:${f.runtime.server.address().port}/health`);
  assert.equal(response.status, 200);
});

test("auth sync recovery errors stop the runtime instead of leaving it disconnected indefinitely", async t => {
  let release;
  const f = fixture(() => new Promise(resolve => { release = resolve; })); t.after(() => f.runtime.stop()); await listen(f);
  f.client.pupPage = { evaluate: async () => { throw new Error("Ready callback failed"); } };
  release();
  await f.runtime.initialization;
  assert.deepEqual(f.exits, [1]);
  assert.equal(f.destroyed(), 1);
});

for (const event of ["disconnected", "auth_failure"]) {
  test(`${event} stops the bot for supervisor restart`, async () => {
    const f = fixture(); await listen(f); await f.runtime.initialization;
    f.client.emit("ready"); f.client.emit(event, "test failure");
    await f.runtime.stop();
    assert.deepEqual(f.exits, [1]);
    assert.equal(f.destroyed(), 1);
    assert.equal(f.runtime.server.listening, false);
  });
}

test("repeated shutdown calls destroy the browser and exit once", async () => {
  const f = fixture(); await listen(f); await f.runtime.initialization;
  await Promise.all([f.runtime.stop(0), f.runtime.stop(1)]);
  assert.equal(f.destroyed(), 1);
  assert.deepEqual(f.exits, [0]);
});

test("messages before readiness are ignored and ping works after readiness", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  const replies = [];
  const message = { body: ".ping", from: "200@c.us", reply: async text => replies.push(text) };
  f.client.emit("message", message);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, []);
  f.client.emit("ready"); f.client.emit("message", message);
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(replies, ["pong"]);
});

test("the runtime captures deletion events only while ready and retains the original text", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  const original = { from: "1000@g.us", author: "300@lid", id: { _serialized: "deleted" }, type: "chat", body: "Saved content" };
  const revoked = { ...original, type: "revoked", body: "" };
  f.client.emit("message_revoke_everyone", revoked, original);
  assert.equal(f.runtime.controller.archive.list("1000@g.us").length, 0);
  f.client.emit("ready");
  f.client.emit("message_revoke_everyone", revoked, original);
  assert.equal(f.runtime.controller.archive.get("1000@g.us", "deleted").body, "Saved content");
  assert.equal(f.runtime.controller.archive.get("1000@g.us", "deleted").deleted, true);
});

test("runtime routes ciphertext placeholders only while WhatsApp is ready", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  const received = [];
  f.runtime.controller.handleUnavailableViewOnce = message => received.push(message);
  const placeholder = { from: "1000@g.us", type: "ciphertext", _data: { subtype: "view_once_unavailable_fanout" } };
  f.client.emit("message_ciphertext", placeholder);
  assert.equal(received.length, 0);
  f.client.emit("ready");
  f.client.emit("message_ciphertext", placeholder);
  assert.deepEqual(received, [placeholder]);
  await f.runtime.stop();
  f.client.emit("message_ciphertext", placeholder);
  assert.equal(received.length, 1);
});

test("runtime welcomes group joins only after readiness", async t => {
  const f = fixture(); t.after(() => f.runtime.stop()); await listen(f);
  f.client.info = { wid: { _serialized: "100@c.us" } };
  const sent = [];
  const notification = {
    chatId: "1000@g.us", id: { _serialized: "join" }, recipientIds: ["300@lid"],
    getChat: async () => ({ isGroup: true, name: "Our group", sendMessage: async (text, options) => sent.push({ text, options }) })
  };
  f.client.emit("group_join", notification);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(sent.length, 0);
  f.client.emit("ready"); f.client.emit("group_join", notification);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(sent[0].text, /Welcome @300/);
  assert.deepEqual(sent[0].options.mentions, ["300@lid"]);
});

test("runtime routes admin activity commands, including descriptions with links", async t => {
  const { createAutomationStore } = require("../src/automation-store");
  const store = createAutomationStore();
  const f = fixture(undefined, { automationStore: store, now: () => new Date("2026-10-02T03:00:00Z") });
  t.after(() => f.runtime.stop()); await listen(f);
  f.client.info = { wid: { _serialized: "100@c.us" } };
  const replies = [];
  const chat = { isGroup: true, participants: [{ id: { _serialized: "200@c.us" }, isAdmin: true }] };
  const message = {
    from: "1000@g.us", author: "200@c.us", body: ".activity add friday 14:00 | Join https://example.com",
    getChat: async () => chat, reply: async text => replies.push(text)
  };
  f.client.emit("ready"); f.client.emit("message", message);
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(store.get("1000@g.us").activities.length, 1);
  assert.match(replies[0], /Activity saved/);
  message.body = ".activities"; f.client.emit("message", message);
  await new Promise(resolve => setImmediate(resolve));
  assert.match(replies.at(-1), /14:00 — Join https:\/\/example.com/);
});

test("runtime starts the daily scheduler when WhatsApp becomes ready", async t => {
  const { createAutomationStore } = require("../src/automation-store");
  const store = createAutomationStore();
  store.update("1000@g.us", group => group.activities.push({ id: "meeting", when: "daily", time: "14:00", text: "Group meeting" }));
  const f = fixture(undefined, { automationStore: store, now: () => new Date("2026-10-02T04:00:00Z") });
  t.after(() => f.runtime.stop()); await listen(f);
  const sent = [];
  f.client.getChatById = async () => ({ isGroup: true, sendMessage: async text => sent.push(text) });
  f.client.emit("ready");
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(sent.length, 1); assert.match(sent[0], /14:00 — Group meeting/);
  assert.equal(store.get("1000@g.us").lastAnnouncementDate, "2026-10-02");
});
