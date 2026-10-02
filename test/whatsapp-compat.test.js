const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { compatibleUtils, recoverMissedAuthSync } = require("../src/whatsapp-compat");
const { LoadUtils } = require("whatsapp-web.js/src/util/Injected/Utils");

function fixture() {
  const gets = [], fetches = [];
  const models = new Map();
  const modules = {
    WALinkify: { findLinks: () => [], findLink: () => null },
    WAWebCollections: { Msg: {
      get: id => { assert.equal(typeof id, "string", "Never query IndexedDB with an undefined message ID"); gets.push(id); return models.get(id); },
      getMessagesById: async ids => { assert.ok(ids.every(id => typeof id === "string")); fetches.push(ids); return { messages: ids.map(id => models.get(id)).filter(Boolean) }; }
    } }
  };
  const window = { require: name => { if (!modules[name]) throw new Error(`Unexpected module ${name}`); return modules[name]; } };
  vm.runInNewContext(`(${compatibleUtils(LoadUtils).toString()})()`, { window });
  return { window, gets, fetches, models, modules };
}

for (const field of ["_serialized", "$1"]) {
  test(`group lookup handles WhatsApp lastReceivedKey.${field}`, async () => {
    const f = fixture();
    const chat = { serialize: () => ({ msgs: ["one"] }), lastReceivedKey: { [field]: "message" } };
    const model = await f.window.WWebJS.getChatModel(chat);
    assert.equal(model.lastMessage, null);
    assert.deepEqual(f.gets, ["message"]);
    assert.deepEqual(f.fetches.map(ids => Array.from(ids)), [["message"]]);
  });
}

test("group lookup skips an unavailable key instead of issuing an invalid IndexedDB request", async () => {
  const f = fixture();
  const model = await f.window.WWebJS.getChatModel({ serialize: () => ({ msgs: ["one"] }), lastReceivedKey: {} });
  assert.equal(model.lastMessage, null);
  assert.deepEqual(f.gets, []); assert.deepEqual(f.fetches, []);
});

test("incoming message models expose normalized IDs for delete, proposals, and welcome deduplication", () => {
  const f = fixture();
  const model = f.window.WWebJS.getMessageModel({ serialize: () => ({ id: { $1: "incoming", remote: "group@g.us" } }) });
  assert.equal(model.id._serialized, "incoming");
});

test("existing serialized message IDs take precedence over renamed keys", () => {
  const f = fixture();
  assert.equal(f.window.WWebJS.getMsgKeyId({ _serialized: "old", $1: "new" }), "old");
  assert.equal(f.window.WWebJS.getMsgKeyId(undefined), undefined);
});

test("a warning send returns the created message when WhatsApp supplies only $1", async () => {
  const f = fixture();
  class MsgKey {
    static newId = async () => "new";
    constructor() { this.$1 = "new-message"; }
  }
  Object.assign(f.modules, {
    WAWebChatGetters: { getIsNewsletter: () => false, getIsBroadcast: () => false },
    WAWebUserPrefsMeUser: { getMaybeMeLidUser: () => "100@lid", getMaybeMePnUser: () => "100@c.us" },
    WAWebMsgKey: MsgKey,
    WAWebGetEphemeralFieldsMsgActionsUtils: { getEphemeralFields: () => ({}) },
    WAWebSendMsgChatAction: { addAndSendMsgToChat: (_chat, msg) => {
      f.models.set(msg.id.$1, msg); return [Promise.resolve(msg), Promise.resolve()];
    } }
  });
  const message = await f.window.WWebJS.sendMessage({ id: { isLid: () => false } }, "Warning 1: no links.");
  assert.equal(message.body, "Warning 1: no links.");
  assert.deepEqual(f.gets, ["new-message"]);
});

test("editing an existing message returns it using the renamed key", async () => {
  const f = fixture();
  f.modules.WAWebSendMessageEditAction = { sendMessageEdit: async (msg, content) => { msg.body = content; } };
  const msg = { id: { $1: "edit-message" }, body: "old" };
  f.models.set("edit-message", msg);
  assert.equal((await f.window.WWebJS.editMessage(msg, "new")).body, "new");
  assert.deepEqual(f.gets, ["edit-message"]);
});

test("a changed injection fails visibly rather than silently applying a partial patch", () => {
  assert.throws(() => compatibleUtils(() => {}), /no longer matches/);
});

function authFixture({ synced = true, injected = false, callback = true } = {}) {
  let recovered = 0;
  const window = { require: () => ({ Socket: { hasSynced: synced } }) };
  if (injected) window.WWebJS = {};
  if (callback) window.onAppStateHasSyncedEvent = async () => { recovered++; };
  const client = { pupPage: { evaluate: fn => vm.runInNewContext(`(${fn.toString()})()`, { window }) } };
  return { client, recovered: () => recovered };
}

test("a restored session already synced before subscription recovers its missed ready callback", async () => {
  const f = authFixture();
  assert.equal(await recoverMissedAuthSync(f.client), true);
  assert.equal(f.recovered(), 1);
});

for (const options of [{ synced: false }, { injected: true }, { callback: false }]) {
  test(`auth sync recovery leaves normal initialization unchanged: ${JSON.stringify(options)}`, async () => {
    const f = authFixture(options);
    assert.equal(await recoverMissedAuthSync(f.client), false);
    assert.equal(f.recovered(), 0);
  });
}

test("auth sync recovery skips a callback already signaled by the library", async () => {
  const f = authFixture();
  f.client.pupPage.evaluate = () => { throw new Error("An authenticated client must not be reinjected"); };
  assert.equal(await recoverMissedAuthSync(f.client, () => true), false);
});
