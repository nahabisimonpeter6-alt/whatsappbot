const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { revokeForEveryone } = require("../src/revoke");

function fixture({ canRevoke = true, missing = false, modern = true, sender = false, fetched = false } = {}) {
  const revocations = [], localDeletes = [];
  const stored = { id: { remote: "group@g.us", fromMe: sender } };
  const collections = {
    Msg: { get: () => missing || fetched ? undefined : stored, getMessagesById: async () => ({ messages: missing ? [] : [stored] }) },
    Chat: { get: () => undefined, find: async () => ({ id: "group@g.us" }) }
  };
  const window = {
    require(name) {
      if (name === "WAWebCollections") return collections;
      if (name === "WAWebMsgActionCapability") return { canSenderRevokeMsg: () => sender && canRevoke, canAdminRevokeMsg: () => canRevoke };
      if (name === "WAWebCmd") return { Cmd: {
        sendRevokeMsgs: async (...args) => revocations.push(args),
        sendDeleteMsgs: async (...args) => localDeletes.push(args)
      } };
      throw new Error(`Unexpected module: ${name}`);
    },
    WWebJS: { compareWwebVersions: () => modern }, Debug: { VERSION: "test" }
  };
  const client = { pupPage: { evaluate: async (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, { window, args }) } };
  const message = { id: { _serialized: "quoted" } };
  return { client, message, revocations, localDeletes };
}

test("revokes for everyone using the supported browser action", async () => {
  const f = fixture(); await revokeForEveryone(f.client, f.message);
  assert.equal(f.revocations.length, 1);
  assert.equal(f.revocations[0][1].type, "message");
  assert.deepEqual(f.localDeletes, []);
});

test("refuses deletion when revoke permission is missing, with no local fallback", async () => {
  const f = fixture({ canRevoke: false });
  await assert.rejects(revokeForEveryone(f.client, f.message), /does not allow deleting/);
  assert.deepEqual(f.revocations, []); assert.deepEqual(f.localDeletes, []);
});

test("refuses an unavailable message without local deletion", async () => {
  const f = fixture({ missing: true });
  await assert.rejects(revokeForEveryone(f.client, f.message), /does not allow deleting/);
  assert.deepEqual(f.revocations, []); assert.deepEqual(f.localDeletes, []);
});

test("loads a quoted message that is not in the browser cache", async () => {
  const f = fixture({ fetched: true }); await revokeForEveryone(f.client, f.message);
  assert.equal(f.revocations.length, 1);
});

test("revokes messages whose serialized ID uses WhatsApp's renamed field", async () => {
  const f = fixture(); f.message.id = { $1: "quoted" };
  await revokeForEveryone(f.client, f.message);
  assert.equal(f.revocations.length, 1);
  assert.deepEqual(f.localDeletes, []);
});

for (const sender of [true, false]) {
  test(`older WhatsApp Web uses the correct ${sender ? "Sender" : "Admin"} revocation mode`, async () => {
    const f = fixture({ modern: false, sender }); await revokeForEveryone(f.client, f.message);
    assert.equal(f.revocations[0][2].type, sender ? "Sender" : "Admin");
    assert.deepEqual(f.localDeletes, []);
  });
}

test("rejects missing message IDs before evaluating browser code", async () => {
  await assert.rejects(revokeForEveryone({}, {}), /could not be resolved/);
});

test("propagates browser action failures", async () => {
  const f = fixture(); f.client.pupPage.evaluate = async () => { throw new Error("Browser closed"); };
  await assert.rejects(revokeForEveryone(f.client, f.message), /Browser closed/);
});
