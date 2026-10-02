const test = require("node:test");
const assert = require("node:assert/strict");
const { createModeration } = require("../src/moderation");

const logger = { log() {}, warn() {}, error() {} };
const participant = (id, admin = false) => ({ id: { _serialized: id }, isAdmin: admin });
function fixture({ botId = "100@c.us", members, mappings = {}, prefix = "." } = {}) {
  const replies = [], revoked = [], removed = [], warnings = [], lookups = [];
  const client = {
    info: { wid: { _serialized: botId } },
    async getContactLidAndPhone(ids) {
      lookups.push(...ids);
      return ids.map(id => mappings[id] || {});
    }
  };
  const chat = {
    isGroup: true,
    participants: members || [participant(botId, true), participant("200@c.us", true), participant("300@c.us")],
    sendMessage: async text => warnings.push(text),
    removeParticipants: async ids => { removed.push(...ids); return { status: 200 }; }
  };
  const message = {
    id: { _serialized: "command" }, from: "group@g.us", author: "200@c.us", body: ".d",
    hasQuotedMsg: true, getChat: async () => chat, reply: async text => replies.push(text),
    getQuotedMessage: async () => ({ id: { _serialized: "quoted" }, from: "group@g.us", author: "300@c.us" })
  };
  const options = { client, prefix, logger, revoke: async (_client, message) => revoked.push(message.id._serialized) };
  const handler = createModeration(options);
  return { client, chat, message, replies, revoked, removed, warnings, lookups, options, handle: handler.handleMessage };
}

test("recognizes the sender's phone ID against a different LID and allows admin links", async () => {
  const f = fixture({ members: [participant("100@c.us", true), participant("900@lid", true)], mappings: { "200@c.us": { pn: "200@c.us", lid: "900@lid" } } });
  f.message.body = "https://example.com";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.deepEqual(f.warnings, []);
  assert.deepEqual(f.lookups, ["200@c.us"]);
});

test("recognizes the bot's phone ID against its LID and revokes member links", async () => {
  const f = fixture({ members: [participant("901@lid", true), participant("300@lid")], mappings: { "100@c.us": { pn: "100@c.us", lid: "901@lid" } } });
  f.message.author = "300@lid";
  f.message.body = "(example.com)";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, ["command"]);
  assert.match(f.warnings[0], /warning 1/);
});

test("never grants admin permission from a matching number in a different namespace", async () => {
  const f = fixture({ members: [participant("100@c.us", true), participant("200@lid", true), participant("900@lid")], mappings: { "200@c.us": { pn: "200@c.us", lid: "900@lid" } } });
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.match(f.replies[0], /Admins only/);
});

test("failed sender ID lookup does not punish a possible admin", async () => {
  const f = fixture({ members: [participant("100@c.us", true)] });
  f.client.getContactLidAndPhone = async () => { throw new Error("Lookup unavailable"); };
  f.message.body = "example.com";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.deepEqual(f.warnings, []);
});

test("non-admin bot warns about links without attempting deletion", async () => {
  const f = fixture(); f.chat.participants[0].isAdmin = false;
  f.message.author = "300@c.us"; f.message.body = "example.com";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.equal(f.warnings.length, 1);
});

test("warnings share a count when a sender changes from phone ID to LID", async () => {
  const f = fixture({ members: [participant("100@c.us", true), participant("900@lid")], mappings: { "300@c.us": { pn: "300@c.us", lid: "900@lid" } } });
  f.message.author = "300@c.us"; f.message.body = "example.com";
  await f.handle(f.message);
  f.message.author = "900@lid"; await f.handle(f.message);
  assert.match(f.warnings[0], /warning 1/);
  assert.match(f.warnings[1], /warning 2/);
});

test("link deletion failure still sends a warning", async () => {
  const f = fixture();
  f.options.revoke = async () => { throw new Error("Too old"); };
  const handler = createModeration(f.options);
  f.message.author = "300@c.us"; f.message.body = "example.com";
  await handler.handleMessage(f.message);
  assert.equal(f.warnings.length, 1);
});

test(".d stops before deleting anything when bot is not admin", async () => {
  const f = fixture(); f.chat.participants[0].isAdmin = false;
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.match(f.replies[0], /bot must be a group admin/);
});

test(".d rejects non-admin senders", async () => {
  const f = fixture(); f.message.author = "300@c.us";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
  assert.match(f.replies[0], /Admins only/);
});

test(".d revokes the quoted message and then the command", async () => {
  const f = fixture(); await f.handle(f.message);
  assert.deepEqual(f.revoked, ["quoted", "command"]);
  assert.deepEqual(f.replies, []);
});

test(".d reports failure and preserves the command if target cannot be revoked", async () => {
  const f = fixture();
  f.options.revoke = async () => { throw new Error("Cannot revoke"); };
  await createModeration(f.options).handleMessage(f.message);
  assert.match(f.replies[0], /Could not delete that message for everyone/);
});

test("command cleanup failure does not report target deletion as failed", async () => {
  const f = fixture();
  f.options.revoke = async (_client, msg) => { if (msg.id._serialized === "command") throw new Error("Cannot cleanup"); f.revoked.push(msg.id._serialized); };
  await createModeration(f.options).handleMessage(f.message);
  assert.deepEqual(f.revoked, ["quoted"]);
  assert.deepEqual(f.replies, []);
});

test(".r accepts a LID target", async () => {
  const f = fixture(); f.chat.participants.push(participant("777@lid"));
  f.message.body = ".r";
  f.message.getQuotedMessage = async () => ({ author: "777@lid" });
  await f.handle(f.message);
  assert.deepEqual(f.removed, ["777@lid"]);
  assert.match(f.replies[0], /Removal requested/);
});

test(".r resolves a phone ID to the current participant LID", async () => {
  const f = fixture({ mappings: { "777@c.us": { pn: "777@c.us", lid: "999@lid" } } });
  f.chat.participants.push(participant("999@lid")); f.message.body = ".r";
  f.message.getQuotedMessage = async () => ({ author: "777@c.us" });
  await f.handle(f.message);
  assert.deepEqual(f.removed, ["999@lid"]);
});

test(".r rejects a target that has already left", async () => {
  const f = fixture(); f.message.body = ".r";
  f.message.getQuotedMessage = async () => ({ author: "777@lid" });
  await f.handle(f.message);
  assert.deepEqual(f.removed, []);
  assert.match(f.replies[0], /no longer in the group/);
});

test(".r reports an unsuccessful status", async () => {
  const f = fixture(); f.message.body = ".r";
  f.chat.removeParticipants = async () => ({ status: 403 });
  await f.handle(f.message);
  assert.match(f.replies[0], /Could not remove/);
});

for (const command of [".d", ".r"]) {
  test(`${command} explains the missing quote`, async () => {
    const f = fixture(); f.message.body = command; f.message.hasQuotedMsg = false;
    await f.handle(f.message);
    assert.match(f.replies[0], /Reply to/);
    assert.deepEqual(f.revoked, []); assert.deepEqual(f.removed, []);
  });
}

test(".ping handles surrounding whitespace and custom prefixes", async () => {
  const f = fixture({ prefix: "!" }); f.message.body = " !ping ";
  await f.handle(f.message);
  assert.deepEqual(f.replies, ["pong"]);
});

test("empty bodies and outgoing messages cause no actions", async () => {
  const f = fixture(); f.message.body = undefined;
  await f.handle(f.message);
  f.message.body = ".d"; f.message.fromMe = true;
  await f.handle(f.message);
  assert.deepEqual(f.replies, []); assert.deepEqual(f.revoked, []);
});

test("group moderation commands do not run in direct chats", async () => {
  const f = fixture(); f.message.from = "200@c.us";
  await f.handle(f.message);
  assert.deepEqual(f.revoked, []);
});

test("admin activity commands containing links reach the activity handler", async () => {
  const f = fixture(); const commands = [];
  f.options.handleCommand = async message => { commands.push(message.body); return true; };
  f.message.body = ".activity add friday 14:00 | Join https://example.com";
  await createModeration(f.options).handleMessage(f.message);
  assert.deepEqual(commands, [f.message.body]);
  assert.deepEqual(f.revoked, []); assert.deepEqual(f.warnings, []);
});

test("non-admin activity commands containing links are moderated before configuration", async () => {
  const f = fixture(); const commands = [];
  f.options.handleCommand = async message => { commands.push(message.body); return true; };
  f.message.author = "300@c.us";
  f.message.body = ".activity add friday 14:00 | Join https://example.com";
  await createModeration(f.options).handleMessage(f.message);
  assert.deepEqual(commands, []); assert.deepEqual(f.revoked, ["command"]);
  assert.match(f.warnings[0], /@300, warning 1/);
});

test("link warnings mention the specific offending member", async () => {
  const f = fixture(); const sent = [];
  f.chat.sendMessage = async (text, options) => sent.push({ text, options });
  f.message.author = "300@c.us"; f.message.body = "example.com";
  await f.handle(f.message);
  assert.match(sent[0].text, /@300, warning 1/);
  assert.deepEqual(sent[0].options.mentions, ["300@c.us"]);
});
