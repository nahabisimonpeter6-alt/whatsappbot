const { createCommandEngine } = require("../../src/command-engine");
const { installCoreCommands } = require("../../src/core-commands");
const { createAutomationStore } = require("../../src/automation-store");
const logger = { log() {}, warn() {}, error() {} };
function fixture() {
  const storage = createAutomationStore();
  const sent = [], actions = [];
  let date = new Date("2026-10-02T04:00:00Z");
  const chat = { isGroup: true, id: { _serialized: "1000@g.us" }, name: "Test group", participants: [
    { id: { _serialized: "100@c.us" }, isAdmin: true },
    { id: { _serialized: "200@c.us" }, isAdmin: true },
    { id: { _serialized: "300@lid" }, isAdmin: false },
    { id: { _serialized: "400@c.us" }, isAdmin: false }
  ], sendMessage: async (text, options) => sent.push({ text, options }), removeParticipants: async ids => { actions.push({ type: "remove", ids }); return { status: 200 }; }, setMessagesAdminsOnly: async value => { actions.push({ type: "lock", value }); return true; } };
  const client = { info: { wid: { _serialized: "100@c.us" } }, getChatById: async id => { if (id !== "1000@g.us") throw new Error("Missing group"); return chat; }, getChats: async () => [chat], getContactLidAndPhone: async ids => ids.map(id => id === "300@c.us" || id === "300@lid" ? { pn: "300@c.us", lid: "300@lid" } : { pn: id }), getMessageById: async id => ({ id: { _serialized: id, remote: "1000@g.us" }, from: "1000@g.us", author: "300@lid" }) };
  const options = { client, storage, logger, now: () => date, ownerNumbers: "999" };
  client.sendMessage = async (id, text, options) => {
    assertGroup(id);
    return chat.sendMessage(text, options);
  };
  const engine = createCommandEngine(options);
  const core = installCoreCommands(engine, { ...options, revoke: async (_client, message) => actions.push({ type: "delete", id: message.id._serialized }) });
  const context = overrides => ({ groupId: "1000@g.us", actor: { type: "user", id: "200@c.us" }, args: {}, reply: async text => sent.push({ text }), ...overrides });
  return { engine, core, options, storage, client, chat, sent, actions, context, setTime: value => date = new Date(value) };
}

function assertGroup(id) { if (id !== "1000@g.us") throw new Error("Missing group"); }

module.exports = { fixture };
