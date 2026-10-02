const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createAutomationStore, validDate } = require("../src/automation-store");
const { createAutomations, localClock } = require("../src/automations");
const logger = { log() {}, warn() {}, error() {} };

function fixture(t, store = createAutomationStore()) {
  const sent = [], replies = [];
  let timestamp = new Date("2026-10-02T03:00:00Z");
  const chat = {
    isGroup: true, name: "Our group",
    sendMessage: async (text, options) => { sent.push({ text, options }); return { id: { _serialized: "sent" } }; }
  };
  const client = { info: { wid: { _serialized: "100@c.us" } }, getChatById: async () => chat };
  const options = { client, store, isAdmin: async () => true, logger, now: () => timestamp };
  const auto = createAutomations(options);
  t.after(() => auto.stop());
  const message = {
    from: "1000@g.us", author: "200@c.us", body: "",
    getChat: async () => chat, reply: async text => replies.push(text)
  };
  async function command(body) { message.body = body; return auto.handleCommand(message); }
  return { auto, options, store, client, chat, message, sent, replies, command, setTime: value => timestamp = new Date(value) };
}

function seed(store, groupId = "1000@g.us", when = "daily") {
  store.update(groupId, group => group.activities.push({ id: "test", when, time: "14:00", text: "Group meeting" }));
}

test("welcomes every newly added member and mentions their phone or LID", async t => {
  const f = fixture(t);
  await f.auto.welcome({ chatId: "1000@g.us", id: { _serialized: "join" }, recipientIds: ["300@lid", "400@c.us"], getChat: async () => f.chat });
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /Welcome @300, @400 to Our group/);
  assert.deepEqual(f.sent[0].options.mentions, ["300@lid", "400@c.us"]);
  assert.match(f.sent[0].text, /\.activities/);
});

test("welcome includes today's games, upcoming events and rules from the current group only", async t => {
  const f = fixture(t);
  await f.command(".activity add today 20:00 | Truth or Dare");
  await f.command(".activity add tomorrow 19:00 | Sticker battle");
  f.store.update("2000@g.us", group => group.activities.push({ id: "private", when: "daily", time: "12:00", text: "Other group's event" }));
  await f.auto.welcome({ chatId: "1000@g.us", id: { _serialized: "games-join" }, recipientIds: ["300@lid"], getChat: async () => f.chat });
  const welcome = f.sent[0].text;
  assert.match(welcome, /Group rules/);
  assert.match(welcome, /Links from non-admins/);
  assert.match(welcome, /20:00 — Truth or Dare/);
  assert.match(welcome, /2026-10-03 19:00 — Sticker battle/);
  assert.doesNotMatch(welcome, /Other group's event/);
  assert.match(welcome, /\.activities week/);
});

test("an empty welcome schedule describes the absence of events without adding sample games", async t => {
  const f = fixture(t);
  await f.auto.welcome({ chatId: "1000@g.us", recipientIds: ["300@lid"], getChat: async () => f.chat });
  assert.match(f.sent[0].text, /No activities are scheduled for today/);
  assert.match(f.sent[0].text, /No upcoming activities are scheduled yet/);
  assert.equal(f.store.get("1000@g.us").activities.length, 0);
});

test("duplicate join notifications do not send duplicate welcomes", async t => {
  const f = fixture(t);
  const event = { chatId: "1000@g.us", id: { _serialized: "join" }, recipientIds: ["300@lid"], getChat: async () => f.chat };
  await Promise.all([f.auto.welcome(event), f.auto.welcome(event)]);
  assert.equal(f.sent.length, 1);
});

test("welcome excludes the bot account and rejects non-group events", async t => {
  const f = fixture(t);
  await f.auto.welcome({ chatId: "1000@g.us", recipientIds: ["100@c.us"], getChat: async () => f.chat });
  await f.auto.welcome({ chatId: "200@c.us", recipientIds: ["300@lid"], getChat: async () => f.chat });
  assert.equal(f.sent.length, 0);
});

test("failed welcomes can be retried and do not crash the bot", async t => {
  const f = fixture(t);
  const event = { chatId: "1000@g.us", id: { _serialized: "join" }, recipientIds: ["300@lid"], getChat: async () => { throw new Error("Offline"); } };
  await f.auto.welcome(event);
  event.getChat = async () => f.chat;
  await f.auto.welcome(event);
  assert.equal(f.sent.length, 1);
});

test("admins add dated and weekly activities with persistent IDs", async t => {
  const f = fixture(t);
  await f.command(".activity add 2026-10-03 16:00 | Sports day");
  await f.command(".activity add Friday 14:00 | Group meeting");
  const activities = f.store.get(f.message.from).activities;
  assert.equal(activities.length, 2);
  assert.equal(activities[0].when, "2026-10-03");
  assert.equal(activities[1].when, "friday");
  assert.match(f.replies[0], /Activity saved/);
});

test("today and tomorrow resolve using the group calendar across a year boundary", async t => {
  const f = fixture(t); f.setTime("2026-12-31T20:30:00Z");
  await f.command(".activity add today 23:45 | Countdown");
  await f.command(".activity add tomorrow 09:00 | New year quiz");
  assert.deepEqual(f.store.get("1000@g.us").activities.map(a => a.when), ["2026-12-31", "2027-01-01"]);
  f.setTime("2026-12-31T21:30:00Z");
  await f.command(".activity add today 10:00 | Morning games");
  assert.equal(f.store.get("1000@g.us").activities.at(-1).when, "2027-01-01");
});

test("admins edit an activity without changing its ID and invalid edits leave it unchanged", async t => {
  const f = fixture(t);
  await f.command(".activity add friday 20:00 | Truth or Dare");
  const id = f.store.get("1000@g.us").activities[0].id;
  await f.command(`.activity edit ${id} saturday 19:30 | Sticker battle`);
  const edited = f.store.get("1000@g.us").activities[0];
  assert.deepEqual(edited, { id, when: "saturday", time: "19:30", text: "Sticker battle" });
  for (const input of [`${id} today 25:00 | Invalid`, `missing today 19:00 | Unknown`, `${id} 2026-10-01 19:00 | Past`]) {
    await f.command(`.activity edit ${input}`);
    assert.match(f.replies.at(-1), /❌/);
    assert.deepEqual(f.store.get("1000@g.us").activities, [edited]);
  }
});

test("non-admins cannot add or change activities", async t => {
  const f = fixture(t);
  const auto = createAutomations({ ...f.options, isAdmin: async () => false });
  f.message.body = ".activity add daily 14:00 | Meeting";
  await auto.handleCommand(f.message);
  assert.deepEqual(f.store.entries(), []);
  assert.match(f.replies[0], /Only group admins/);
});

test("all members can view today's agenda in time order", async t => {
  const f = fixture(t);
  await f.command(".activity add daily 17:00 | Evening meeting");
  await f.command(".activity add friday 10:00 | Morning training");
  await f.command(".activity add saturday 09:00 | Tomorrow's activity");
  const auto = createAutomations({ ...f.options, isAdmin: async () => false });
  f.message.body = ".activities";
  await auto.handleCommand(f.message);
  const agenda = f.replies.at(-1);
  assert.match(agenda, /2026-10-02 \(Africa\/Kampala\)/);
  assert.ok(agenda.indexOf("10:00") < agenda.indexOf("17:00"));
  assert.doesNotMatch(agenda, /Tomorrow's activity/);
});

test("members can view tomorrow, the week and a chosen date, with recurring events in date order", async t => {
  const f = fixture(t); f.setTime("2026-12-31T18:00:00Z");
  await f.command(".activity add friday 20:00 | Truth or Dare");
  await f.command(".activity add 2027-01-02 19:00 | Sticker battle");
  await f.command(".activity add 2027-01-07 19:00 | Beyond this week");
  await f.command(".activities tomorrow");
  assert.match(f.replies.at(-1), /2027-01-01/);
  assert.match(f.replies.at(-1), /Truth or Dare/);
  assert.doesNotMatch(f.replies.at(-1), /Sticker battle/);
  await f.command(".activities week");
  const week = f.replies.at(-1);
  assert.ok(week.indexOf("2027-01-01 20:00") < week.indexOf("2027-01-02 19:00"));
  assert.doesNotMatch(week, /Beyond this week/);
  await f.command(".activities 2027-01-02");
  assert.match(f.replies.at(-1), /Sticker battle/);
  await f.command(".activities 2027-02-30");
  assert.match(f.replies.at(-1), /Use \.activities/);
});

test("large activity previews are bounded and retain commands to see the full schedule", async t => {
  const f = fixture(t);
  f.store.update("1000@g.us", group => {
    group.activities = Array.from({ length: 6 }, (_, i) => ({ id: String(i), when: "daily", time: `1${i}:00`, text: `Game ${i}` }));
  });
  await f.auto.welcome({ chatId: "1000@g.us", recipientIds: ["300@lid"], getChat: async () => f.chat });
  assert.equal((f.sent[0].text.match(/• .*Game/g) || []).length, 10);
  assert.match(f.sent[0].text, /\.activities for the full list/);
  await f.command(".activities week");
  assert.equal((f.replies.at(-1).match(/• .*Game/g) || []).length, 20);
  assert.match(f.replies.at(-1), /22 more/);
});

test("activity list and remove manage only the current group", async t => {
  const f = fixture(t); seed(f.store); seed(f.store, "2000@g.us");
  await f.command(".activity list"); assert.match(f.replies.at(-1), /test: daily 14:00/);
  await f.command(".activity remove test");
  assert.equal(f.store.get("1000@g.us").activities.length, 0);
  assert.equal(f.store.get("2000@g.us").activities.length, 1);
});

for (const command of [
  ".activity add 2026-02-30 14:00 | Impossible date",
  ".activity add 2026-10-01 14:00 | Past activity",
  ".activity add daily 24:00 | Invalid time",
  ".activity add sometime 14:00 | Invalid day",
  ".activity add daily 14:00 |   ",
  ".activity time 7:00",
  ".activity timezone Unknown/Place"
]) {
  test(`invalid schedule input is rejected: ${command}`, async t => {
    const f = fixture(t); await f.command(command);
    assert.match(f.replies.at(-1), /❌/);
    assert.equal(f.store.entries().length, 0);
  });
}

test("admins can customize announcement time and timezone", async t => {
  const f = fixture(t);
  await f.command(".activity time 08:30");
  await f.command(".activity timezone UTC");
  const group = f.store.get(f.message.from);
  assert.equal(group.announceAt, "08:30"); assert.equal(group.timezone, "UTC");
});

test("custom prefixes are supported and direct chats cannot configure schedules", async t => {
  const f = fixture(t); const auto = createAutomations({ ...f.options, prefix: "!" });
  f.message.body = "!activity add daily 14:00 | Meeting";
  assert.equal(await auto.handleCommand(f.message), true);
  f.message.from = "200@c.us";
  assert.equal(await auto.handleCommand(f.message), false);
});

test("daily announcement waits until 07:00 Kampala and sends only once", async t => {
  const f = fixture(t); seed(f.store); f.auto.start();
  await f.auto.tick(); assert.equal(f.sent.length, 0);
  f.setTime("2026-10-02T04:00:00Z");
  await f.auto.tick(); await f.auto.tick();
  assert.equal(f.sent.length, 1);
  assert.match(f.sent[0].text, /14:00 — Group meeting/);
  assert.equal(f.store.get("1000@g.us").lastAnnouncementDate, "2026-10-02");
});

test("restart after announcement does not resend and next day gets a new agenda", async t => {
  const f = fixture(t); seed(f.store); f.setTime("2026-10-02T04:00:00Z");
  f.auto.start(); await new Promise(resolve => setImmediate(resolve)); f.auto.stop();
  const restarted = createAutomations(f.options); t.after(() => restarted.stop());
  restarted.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
  f.setTime("2026-10-03T04:00:00Z"); await restarted.tick();
  assert.equal(f.sent.length, 2); assert.match(f.sent[1].text, /2026-10-03/);
});

test("a weekly activity announces on its weekday only", async t => {
  const f = fixture(t); seed(f.store, "1000@g.us", "friday");
  f.setTime("2026-10-03T04:00:00Z"); f.auto.start();
  await f.auto.tick(); assert.equal(f.sent.length, 0);
  f.setTime("2026-10-09T04:00:00Z"); await f.auto.tick();
  assert.equal(f.sent.length, 1);
});

test("a dated activity announces on its specified date only", async t => {
  const f = fixture(t); seed(f.store, "1000@g.us", "2026-10-03");
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start(); await f.auto.tick();
  assert.equal(f.sent.length, 0);
  f.setTime("2026-10-03T04:00:00Z"); await f.auto.tick();
  assert.equal(f.sent.length, 1);
  f.setTime("2026-10-04T04:00:00Z"); await f.auto.tick();
  assert.equal(f.sent.length, 1);
});

test("groups without activities for today receive no automated message", async t => {
  const f = fixture(t); f.store.update("1000@g.us", group => { group.announceAt = "06:00"; });
  f.auto.start(); await f.auto.tick(); assert.equal(f.sent.length, 0);
});

test("a late restart catches up today's agenda without sending previous days", async t => {
  const f = fixture(t); seed(f.store); f.setTime("2026-10-03T12:00:00Z");
  f.auto.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1); assert.match(f.sent[0].text, /2026-10-03/);
  assert.doesNotMatch(f.sent[0].text, /2026-10-02/);
});

test("failed announcement sends can retry without marking the day delivered", async t => {
  const f = fixture(t); seed(f.store);
  f.chat.sendMessage = async () => { throw new Error("Offline"); };
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.store.get("1000@g.us").lastAnnouncementDate, null);
  f.chat.sendMessage = async text => f.sent.push({ text });
  await f.auto.tick(); assert.equal(f.sent.length, 1);
});

test("overlapping scheduler ticks cannot send duplicate messages", async t => {
  const f = fixture(t); seed(f.store);
  let release;
  f.client.getChatById = () => new Promise(resolve => { release = () => resolve(f.chat); });
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start();
  await f.auto.tick(); release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 1);
});

test("shutdown prevents an in-flight chat lookup from sending an announcement", async t => {
  const f = fixture(t); seed(f.store);
  let release;
  f.client.getChatById = () => new Promise(resolve => { release = () => resolve(f.chat); });
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start(); f.auto.stop(); release();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0);
});

test("persisting delivery failure does not repeatedly send during the same session", async t => {
  const f = fixture(t); seed(f.store);
  f.store.update = () => { throw new Error("Disk full"); };
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start();
  await new Promise(resolve => setImmediate(resolve)); await f.auto.tick();
  assert.equal(f.sent.length, 1);
});

test("Kampala calendar day is computed from timezone rather than host timezone", () => {
  assert.deepEqual(localClock(new Date("2026-10-01T21:05:00Z"), "Africa/Kampala"), { date: "2026-10-02", time: "00:05", weekday: "friday" });
  assert.equal(validDate("2028-02-29"), true); assert.equal(validDate("2026-02-29"), false);
});

test("activities and announcement records survive reloading the state file", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-activities-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "data", "automations.json");
  const store = createAutomationStore(file); seed(store);
  store.update("1000@g.us", group => { group.lastAnnouncementDate = "2026-10-02"; });
  assert.deepEqual(createAutomationStore(file).get("1000@g.us"), store.get("1000@g.us"));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(fs.readdirSync(path.dirname(file)), ["automations.json"]);
});

test("failed persistence leaves the in-memory schedule unchanged", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-activities-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const blocker = path.join(folder, "blocker"); fs.writeFileSync(blocker, "file");
  const store = createAutomationStore(path.join(blocker, "automations.json"));
  assert.throws(() => seed(store)); assert.deepEqual(store.entries(), []);
});

test("corrupted activity files fail visibly instead of overwriting saved schedules", t => {
  const folder = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-activities-"));
  t.after(() => fs.rmSync(folder, { recursive: true, force: true }));
  const file = path.join(folder, "automations.json"); fs.writeFileSync(file, "broken JSON");
  assert.throws(() => createAutomationStore(file));
  assert.equal(fs.readFileSync(file, "utf8"), "broken JSON");
});

test("removing today's activities during a chat lookup cancels the pending agenda", async t => {
  const f = fixture(t); seed(f.store);
  let release;
  f.client.getChatById = () => new Promise(resolve => { release = () => resolve(f.chat); });
  f.setTime("2026-10-02T04:00:00Z"); f.auto.start();
  f.store.update("1000@g.us", group => { group.activities = []; });
  release(); await new Promise(resolve => setImmediate(resolve));
  assert.equal(f.sent.length, 0);
});

test("storage errors are logged without exposing filesystem paths in group replies", async t => {
  const f = fixture(t);
  f.store.update = () => { throw new Error("EACCES /app/private/automations.json"); };
  await f.command(".activity add daily 14:00 | Meeting");
  assert.match(f.replies[0], /Could not update the schedule/);
  assert.doesNotMatch(f.replies[0], /EACCES|\/app\/private/);
});
