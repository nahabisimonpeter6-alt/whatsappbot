const test = require("node:test");
const assert = require("node:assert/strict");
const { classifyLocalContent } = require("../src/local-content-classifier");
const { createContentClassifier } = require("../src/content-classifier");
const { createController } = require("../src/controller");
const { fixture } = require("./helpers/control-fixture.cjs");

test("local checks catch clear profanity, disguised spellings, spaced letters and explicit threats", () => {
  for (const text of ["fuck you", "f*ck you", "fuuuck you", "F U C K you", "you fucking asshole", "sh1t", "s h i t", "b1tch", "asshole", "cunt", "I will kill you", "We are going to stab you", "Let's shoot them"]) {
    assert.equal(classifyLocalContent(text), "FLAG", text);
  }
});

test("local checks keep ordinary conversation, harmless substrings, quotes, discussion and ambiguous language", () => {
  for (const text of ["damn", "crap", "Hello everyone", "Wasuze otya?", "Habari yako?", "Niaje, uko poa?", "shirt", "shitake", "Scunthorpe", "classhole", "what does f*ck mean?", "what is shit?",
    'He wrote "fuck you".', "The news reported: I will kill you.", "Don't say fuck.", "Do not kill anyone.", "If I say I will kill you, is it a threat?", "fuck you bro, just kidding", "The word shit is vulgar.", "You are an idiot"]) {
    assert.equal(classifyLocalContent(text), "OK", text);
  }
  assert.equal(classifyLocalContent('"fuck you". I will kill you'), "FLAG");
});

test("a real classifier without a key deletes a flagged member message through the controller", async t => {
  const f = fixture(); let current;
  f.client.getMessageById = async () => current;
  const controller = createController({ ...f.options, contentClassifier: createContentClassifier({ apiKey: "" }),
    revoke: async (_client, message) => f.actions.push({ type: "delete", id: message.id._serialized }) });
  controller.start(); t.after(() => controller.stop());
  function message(body, author) {
    return { from: "1000@g.us", author, body, fromMe: false, type: "chat", id: { _serialized: `local-${body}`, remote: "1000@g.us" },
      getChat: async () => f.chat, reply: async text => f.sent.push({ text }) };
  }
  await controller.handleMessage(message(".filter on", "200@c.us"));
  assert.match(f.sent.at(-1).text, /Local checks/);
  current = message("f*ck you", "300@lid");
  await controller.handleMessage(current); await controller.contentFilter.drain();
  assert.deepEqual(f.actions, [{ type: "delete", id: current.id._serialized }]);
  current = message("what does f*ck mean?", "300@lid");
  await controller.handleMessage(current); await controller.contentFilter.drain();
  assert.equal(f.actions.length, 1);
  assert.deepEqual(f.storage.get("1000@g.us").linkWarnings, {});
});
