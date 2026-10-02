const test = require("node:test");
const assert = require("node:assert/strict");
const { fixture } = require("./helpers/control-fixture.cjs");
const { installControlPanel } = require("../src/control-panel");
const { createRulesEngine, parseRule } = require("../src/rules");
function setup() {
  const f = fixture(); f.panel = installControlPanel(f.engine, f.options); f.rules = createRulesEngine(f.engine, f.options);
  f.storage.update("1000@g.us", group => { group.rules = []; });
  return f;
}
async function add(f, source) {
  await f.panel.executeText(`.rule add ${source}`, f.context());
  return f.storage.get("1000@g.us").rules.at(-1)?.id;
}
function event(f, body = "hello") { return { groupId: "1000@g.us", trigger: "message", target: "300@lid", chat: f.chat, message: { id: { _serialized: "message", remote: "1000@g.us" }, from: "1000@g.us", author: "300@lid", body, type: "chat" } }; }

test("message rules honor role/time/type conditions and cooldowns", async () => {
  const f = setup(); await add(f, 'WHEN message_matches("hello") IF sender_role=member AND time_window=07:00-18:00 AND message_type=chat THEN warn @sender Hello rule');
  await f.rules.emit(event(f)); await f.rules.emit(event(f));
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 1);
  f.setTime("2026-10-02T04:02:00Z"); await f.rules.emit(event(f));
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 2);
});

test("HH:MM and cron rules run in group timezone once per matching minute", async () => {
  const f = setup(); await add(f, 'WHEN schedule("07:00") THEN say Morning');
  await add(f, 'WHEN schedule("0 7 * * *") THEN say Cron morning');
  await f.rules.tick(); await f.rules.tick();
  assert.equal(f.sent.filter(row => ["Morning", "Cron morning"].includes(row.text)).length, 2);
});

test("rule testing is a simulation and does not mutate warnings or send actual actions", async () => {
  const f = setup(); const id = await add(f, 'WHEN message_matches("hello") THEN warn @sender');
  await f.rules.emit(event(f, "other"));
  // Save a matching message without actually applying the rule.
  f.rules.lastMessages.set("1000@g.us", event(f));
  await f.panel.executeText(`.rule test ${id}`, f.context());
  assert.deepEqual(f.storage.get("1000@g.us").warnings, {});
  assert.match(f.sent.at(-1).text, /Simulation: warn: dry-run/);
});

test("unsafe patterns and non-automation-safe commands are rejected", async () => {
  const f = setup(); assert.throws(() => parseRule('WHEN message_matches("(a+)+$") THEN warn @sender'));
  assert.equal((await f.panel.executeText('.rule add WHEN member_joined THEN perm remove member', f.context())).ok, false);
});

test("media caption and membership/admin triggers call the registry", async () => {
  const f = setup(); await add(f, 'WHEN keyword_in_media_caption("sale") THEN say Caption matched');
  const incoming = event(f, "sale"); incoming.message.hasMedia = true;
  await f.rules.emit(incoming); assert.equal(f.sent.at(-1).text, "Caption matched");
  for (const trigger of ["member_left", "admin_changed", "bot_became_admin", "raid_detected"]) {
    await add(f, `WHEN ${trigger} THEN say ${trigger}`);
    await f.rules.emit({ ...event(f), trigger });
    assert.equal(f.sent.at(-1).text, trigger);
  }
});

test("account-age conditions skip when WhatsApp supplies no creation age", async () => {
  const f = setup(); await add(f, 'WHEN message_matches("hello") IF account_age_days>=30 THEN warn @sender');
  await f.rules.emit(event(f)); assert.deepEqual(f.storage.get("1000@g.us").warnings, {});
});

test("rule chain prevents a warning-trigger rule from triggering itself", async () => {
  const f = setup(); const id = await add(f, 'WHEN warn_count_reached(1) THEN warn @sender');
  await f.panel.executeText(`.rule cooldown ${id} 0`, f.context());
  f.engine.afterRun = async (_entry, ctx, outcome) => {
    if (outcome.result?.event) await f.rules.emit({ groupId: ctx.groupId, chat: ctx.chat, target: ctx.target, trigger: outcome.result.event, count: outcome.result.count }, ctx);
  };
  await f.engine.executeCommand("warn", f.context({ args: { target: "300@lid" } }));
  assert.equal(f.storage.get("1000@g.us").warnings["300@lid"], 2);
});
