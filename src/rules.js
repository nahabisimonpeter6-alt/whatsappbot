const { randomUUID } = require("node:crypto");
const safeRegex = require("safe-regex2");
const { CronExpressionParser } = require("cron-parser");
const { containsLink } = require("./links");
const { localClock } = require("./automations");
const { validTime } = require("./automation-store");
const { publicError } = require("./permissions");
const { invocation, splitCommands } = require("./control-panel");
const { raw } = require("./core-commands");
const TRIGGERS = ["message_matches", "member_joined", "member_left", "warn_count_reached", "link_warning_count_reached", "raid_detected", "schedule", "admin_changed", "bot_became_admin", "keyword_in_media_caption", "link_detected", "member_muted", "member_banned"];

function argument(text) {
  if (!text) return "";
  if (text.startsWith('"')) { try { return JSON.parse(text); } catch { throw publicError("Invalid quoted rule argument."); } }
  if (text.startsWith("'") && text.endsWith("'")) return text.slice(1, -1);
  return text;
}

function parseRule(source) {
  if (typeof source !== "string" || source.length > 2000) throw publicError("Rules must contain at most 2,000 characters.");
  const match = /^WHEN\s+([a-z_]+)(?:\(([\s\S]*?)\))?(?:\s+IF\s+([\s\S]*?))?\s+THEN\s+([\s\S]+)$/i.exec(source.trim());
  if (!match || !TRIGGERS.includes(match[1].toLowerCase())) throw publicError("Use WHEN trigger(argument) [IF conditions] THEN command; command.");
  const trigger = match[1].toLowerCase(), value = argument(match[2]?.trim());
  if (["message_matches", "keyword_in_media_caption"].includes(trigger)) {
    if (typeof value !== "string" || !value || value.length > 256 || !safeRegex(value)) throw publicError("Use a safe regex pattern of at most 256 characters.");
    try { new RegExp(value, "iu"); } catch { throw publicError("Invalid rule regex."); }
  }
  if (["warn_count_reached", "link_warning_count_reached"].includes(trigger) && (!/^\d+$/.test(String(value)) || Number(value) < 1)) throw publicError("Warning threshold must be positive.");
  if (trigger === "schedule") {
    if (typeof value !== "string") throw publicError("Schedules use HH:MM or a five-field cron expression.");
    if (!validTime(value)) {
      if (value.trim().split(/\s+/).length !== 5) throw publicError("Use HH:MM or a five-field cron expression.");
      try { CronExpressionParser.parse(value); } catch { throw publicError("Invalid cron expression."); }
    }
  }
  const conditions = (match[3] || "").split(/\s+AND\s+/i).filter(Boolean).map(text => {
    const condition = /^(sender_role|message_type|time_window|setting\.(?:autopilot|dryRun|approval)|account_age_days)\s*(=|>=|<=)\s*(.+)$/.exec(text.trim());
    if (!condition) throw publicError("Conditions: sender_role=ROLE, message_type=TYPE, time_window=HH:MM-HH:MM, setting.NAME=VALUE, account_age_days>=N.");
    const [, key, operator, value] = condition;
    if (key === "sender_role" && !["owner", "admin", "moderator", "member"].includes(value)) throw publicError("Invalid sender role.");
    if (key === "time_window" && (!validTime(value.slice(0, 5)) || value[5] !== "-" || !validTime(value.slice(6)))) throw publicError("Use time_window=07:00-18:00.");
    if (key === "account_age_days" && !/^\d+$/.test(value)) throw publicError("Account age must be a number of days.");
    if (key !== "account_age_days" && operator !== "=") throw publicError("This condition uses =.");
    return { key, operator, value };
  });
  return { trigger, argument: value, conditions, commands: splitCommands(match[4]) };
}

function createRulesEngine(engine, { client, storage, now = () => new Date(), logger = console, prefix = "." }) {
  const lastMessages = new Map();
  const joined = new Map();
  const seenJoins = new Set();

  function validateRules(rules) {
    if (!Array.isArray(rules) || rules.length > 50) throw publicError("A group can have at most 50 rules.");
    const ids = new Set();
    for (const rule of rules) {
      if (!rule || typeof rule.id !== "string" || ids.has(rule.id) || typeof rule.enabled !== "boolean" || !Number.isInteger(rule.cooldownMs) || rule.cooldownMs < 0 || rule.cooldownMs > 86400000) throw publicError("Invalid saved rule.");
      ids.add(rule.id); const parsed = parseRule(rule.source); if (rule.trigger !== parsed.trigger) throw publicError("Rule metadata does not match its source.");
    }
  }
  engine.validateRules = validateRules;

  async function matches(rule, event, group, simulation) {
    const clock = localClock(now(), group.timezone);
    switch (rule.trigger) {
      case "message_matches": if (event.trigger !== "message" || !new RegExp(rule.argument, "iu").test(String(event.message?.body || "").slice(0, 4000))) return false; break;
      case "keyword_in_media_caption": if (event.trigger !== "message" || !event.message?.hasMedia || !new RegExp(rule.argument, "iu").test(String(event.message.body || "").slice(0, 4000))) return false; break;
      case "link_detected": if (event.trigger !== "message" || !containsLink(event.message?.body)) return false; break;
      case "member_muted": if (event.trigger !== "message" || !(group.muted[event.target] > now().valueOf())) return false; break;
      case "member_banned": if (event.trigger !== "member_joined" || !group.bans.includes(event.target)) return false; break;
      case "warn_count_reached":
      case "link_warning_count_reached": if (event.trigger !== rule.trigger || event.count < Number(rule.argument)) return false; break;
      case "schedule": {
        if (event.trigger !== "schedule") return false;
        if (validTime(rule.argument)) { if (clock.time !== rule.argument) return false; }
        else {
          const current = now().valueOf();
          const previous = CronExpressionParser.parse(rule.argument, { currentDate: new Date(current + 1), tz: group.timezone }).prev().toDate().valueOf();
          if (Math.floor(previous / 60000) !== Math.floor(current / 60000)) return false;
        }
        break;
      }
      default: if (event.trigger !== rule.trigger && !simulation) return false;
    }
    for (const condition of rule.conditions) {
      let actual;
      if (condition.key === "sender_role") {
        const chat = event.chat || await client.getChatById(event.groupId);
        actual = await engine.permissions.role(chat, event.groupId, event.target);
      } else if (condition.key === "message_type") actual = event.message?.type;
      else if (condition.key === "time_window") {
        const start = condition.value.slice(0, 5), end = condition.value.slice(6);
        if (!(start <= end ? clock.time >= start && clock.time <= end : clock.time >= start || clock.time <= end)) return false;
        continue;
      } else if (condition.key.startsWith("setting.")) actual = String(group[condition.key.slice(8)]);
      else if (condition.key === "account_age_days") {
        if (!Number.isFinite(event.accountAgeDays)) { logger.warn("[RULE] account creation age is unavailable; condition skipped safely"); return false; }
        actual = event.accountAgeDays;
        if (condition.operator === ">=" && actual < Number(condition.value) || condition.operator === "<=" && actual > Number(condition.value) || condition.operator === "=" && actual !== Number(condition.value)) return false;
        continue;
      }
      if (actual !== condition.value) return false;
    }
    return true;
  }

  async function emit(event, parent = {}, onlyRule = null, simulation = false) {
    const group = storage.get(event.groupId);
    if (!simulation && (!group.autopilot || group.paused)) return [];
    if (event.trigger === "message") lastMessages.set(event.groupId, event);
    const outcomes = [];
    for (const saved of group.rules) {
      if (onlyRule && saved.id !== onlyRule || !simulation && !saved.enabled) continue;
      if ((parent.ruleChain || []).includes(saved.id) || (parent.depth || 0) >= 3) continue;
      try {
        const rule = { ...saved, ...parseRule(saved.source) };
        if (!(await matches(rule, event, group, simulation))) continue;
        const previous = group.ruleRuns[saved.id];
        const minute = `${localClock(now(), group.timezone).date}:${localClock(now(), group.timezone).time}`;
        if (!simulation && previous && (now().valueOf() - previous.at < saved.cooldownMs || rule.trigger === "schedule" && previous.minute === minute)) continue;
        if (!simulation) storage.update(event.groupId, current => { current.ruleRuns[saved.id] = { at: now().valueOf(), minute: rule.trigger === "schedule" ? minute : null }; });
        for (const command of rule.commands) {
          const parsed = invocation(command, prefix);
          const outcome = await engine.executeCommand(parsed.name, {
            groupId: event.groupId, actor: { type: "rule", id: saved.id }, args: parsed.args,
            event, ruleTrigger: rule.trigger, message: event.message, notification: event.notification, chat: event.chat,
            target: event.target, dryRun: simulation || parent.dryRun,
            ruleChain: [...parent.ruleChain || [], saved.id], depth: (parent.depth || 0) + 1,
            stack: parent.stack || [], reply: text => event.chat ? event.chat.sendMessage(text) : client.sendMessage(event.groupId, text)
          });
          outcomes.push(outcome);
          // Link deletion failures should still allow the warning step.
          if (!outcome.ok && saved.id !== "builtin-links") break;
        }
      } catch (error) {
        logger.error(`[RULE ${saved.id}] skipped:`, error);
        storage.update(event.groupId, current => {
          current.audit.push({ id: randomUUID().slice(0, 8), at: now().toISOString(), actor: { type: "rule", id: saved.id }, command: "rule-check", args: {}, result: "failed", error: error.message, dryRun: simulation, approvedBy: null });
          current.audit = current.audit.slice(-200);
        });
      }
    }
    return outcomes;
  }

  async function memberJoined(event) {
    const key = `${event.groupId}:${event.notification?.id?._serialized}:${event.target}`;
    if (event.notification?.id?._serialized && seenJoins.has(key)) return;
    if (event.notification?.id?._serialized) seenJoins.add(key); if (seenJoins.size > 1000) seenJoins.delete(seenJoins.values().next().value);
    const outcomes = await emit({ ...event, trigger: "member_joined" });
    const group = storage.get(event.groupId);
    const recent = (joined.get(event.groupId) || []).filter(time => now().valueOf() - time < group.raidWindowMs);
    recent.push(now().valueOf()); joined.set(event.groupId, recent);
    if (recent.length >= group.raidThreshold) outcomes.push(...await emit({ ...event, trigger: "raid_detected", joins: recent.length }));
    return outcomes;
  }

  async function tick() {
    for (const [groupId] of storage.entries()) { engine.expireProposals(groupId); await emit({ groupId, trigger: "schedule" }); }
  }

  engine.register({ name: "rule", description: "Manage automation rules", requiredRole: "admin", minimumRole: "admin", control: true, args: { raw: "string" }, parseArgs: raw,
    run: async ctx => {
      const [action, ...rest] = (ctx.args.raw || "").trim().split(/\s+/); const value = rest.join(" ");
      if (["add", "edit"].includes(action)) {
        const edit = action === "edit";
        const split = /^(\S+)\s+([\s\S]+)$/.exec(value);
        if (edit && !split) throw publicError("Use .rule edit ID WHEN trigger THEN command.");
        const source = edit ? split[2] : value;
        const parsed = parseRule(source);
        for (const text of parsed.commands) if (!engine.get(invocation(text, prefix).name, ctx)?.automationSafe) throw publicError("Rules can only call automation-safe commands.");
        const id = edit ? split[1] : randomUUID().slice(0, 8);
        storage.update(ctx.groupId, group => {
          if (edit) {
            const rule = group.rules.find(rule => rule.id === id);
            if (!rule) throw publicError("Rule not found.");
            rule.source = source; rule.trigger = parsed.trigger; delete group.ruleRuns[id];
          } else {
            if (group.rules.length >= 50) throw publicError("A group can have at most 50 rules.");
            group.rules.push({ id, source, trigger: parsed.trigger, enabled: true, cooldownMs: 60000 });
          }
        });
        await ctx.reply(`✅ Rule ${id} ${edit ? "updated" : "saved (60-second cooldown)"}.`);
      } else if (action === "list") {
        await ctx.reply(storage.get(ctx.groupId).rules.map(rule => `${rule.id} [${rule.enabled ? "on" : "off"}] ${rule.source}`).join("\n") || "No rules saved.");
      } else if (["remove", "enable", "disable", "cooldown"].includes(action)) {
        const [id, seconds] = value.split(/\s+/);
        storage.update(ctx.groupId, group => {
          const rule = group.rules.find(rule => rule.id === id); if (!rule) throw publicError("Rule not found.");
          if (action === "remove") group.rules = group.rules.filter(rule => rule.id !== id);
          else if (action === "cooldown") { const number = Number(seconds); if (!Number.isInteger(number) || number < 0 || number > 86400) throw publicError("Cooldown must be 0–86400 seconds."); rule.cooldownMs = number * 1000; }
          else rule.enabled = action === "enable";
        });
        await ctx.reply(`✅ Rule ${id} updated.`);
      } else if (action === "test") {
        if (!storage.get(ctx.groupId).rules.some(rule => rule.id === value)) throw publicError("Rule not found.");
        const event = lastMessages.get(ctx.groupId); if (!event) throw publicError("No recent message is available to simulate.");
        const results = await emit(event, { dryRun: true }, value, true);
        await ctx.reply(`🧪 Simulation: ${results.map(result => `${result.command}: ${result.status}`).join(", ") || "no match"}. No real actions performed.`);
      } else throw publicError("Use .rule add|edit|list|remove|enable|disable|cooldown|test.");
    }
  });
  return { emit, memberJoined, tick, lastMessages, validateRules };
}

module.exports = { createRulesEngine, parseRule };
