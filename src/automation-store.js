const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const DEFAULT_GROUP = {
  timezone: "Africa/Kampala",
  announceAt: "07:00",
  activities: [],
  lastAnnouncementDate: null,
  autopilot: true, paused: false, dryRun: false, approval: "off", proposalExpiryMs: 600000,
  repostDeleted: true, repostViewOnce: true,
  contentModeration: false,
  destructiveCap: 20, commandRate: 30,
  moderators: [], whitelist: [], permissions: {}, disabledCommands: [],
  aliases: {}, macros: {}, customCommands: {}, rules: [
    { id: "builtin-links", source: "WHEN link_detected IF sender_role=member THEN delete; warn @sender", trigger: "link_detected", enabled: true, cooldownMs: 0 },
    { id: "builtin-link-removal", source: "WHEN link_warning_count_reached(4) IF sender_role=member THEN remove @sender", trigger: "link_warning_count_reached", enabled: true, cooldownMs: 0 },
    { id: "builtin-welcome", source: "WHEN member_joined THEN welcome", trigger: "member_joined", enabled: true, cooldownMs: 0 },
    { id: "builtin-mute", source: "WHEN member_muted IF sender_role=member THEN delete", trigger: "member_muted", enabled: true, cooldownMs: 0 },
    { id: "builtin-ban", source: "WHEN member_banned THEN remove @sender", trigger: "member_banned", enabled: true, cooldownMs: 0 },
    { id: "builtin-raid", source: "WHEN raid_detected THEN lock", trigger: "raid_detected", enabled: false, cooldownMs: 60000 }
  ], raidThreshold: 5, raidWindowMs: 60000,
  warnings: {}, linkWarnings: {}, linkEscalationVersion: 1, warningCycles: {}, linkResetVersion: 1,
  muted: {}, bans: [], proposals: [], audit: [], destructiveActions: [], ruleRuns: {}
};

function migrateLinkEscalation(group) {
  if (group.linkEscalationVersion === 1) return group;
  const next = structuredClone(group);
  const counts = {};
  // Old warnings shared a counter. Recover only recorded link offences, never
  // assume that an unrelated manual warning was a posted link.
  for (const row of next.audit || []) {
    if (row.result !== "success" || row.dryRun || !row.target) continue;
    if (row.command === "warn" && (row.actor?.type === "rule" && row.actor.id === "builtin-links" || row.args?.linkWarning === true)) {
      counts[row.target] = (counts[row.target] || 0) + 1;
    } else if (row.command === "unwarn" && row.args?.linkWarning !== false) {
      counts[row.target] = Math.max(0, (counts[row.target] || 0) - (row.args?.amount || 1));
    }
  }
  next.linkWarnings = Object.fromEntries(Object.entries(counts).map(([id, count]) => [id, Math.min(count, next.warnings?.[id] || 0)]));
  next.rules ||= structuredClone(DEFAULT_GROUP.rules);
  if (!next.rules.some(rule => rule.id === "builtin-link-removal")) {
    if (next.rules.length >= 50) throw new Error("Remove a saved rule to make room for link-offence escalation.");
    next.rules.push(structuredClone(DEFAULT_GROUP.rules.find(rule => rule.id === "builtin-link-removal")));
  }
  next.linkEscalationVersion = 1;
  return next;
}

function validTime(value) {
  return typeof value === "string" && /^(?:[01]\d|2[0-3]):[0-5]\d$/.test(value);
}

function validDate(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const date = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(date.valueOf()) && date.toISOString().slice(0, 10) === value;
}

function validTimezone(value) {
  try {
    return typeof value === "string" && !!new Intl.DateTimeFormat("en", { timeZone: value });
  } catch {
    return false;
  }
}

const weekdays = ["sunday", "monday", "tuesday", "wednesday", "thursday", "friday", "saturday"];
function validWhen(value) {
  return value === "daily" || weekdays.includes(value) || validDate(value);
}

function validateGroup(group) {
  if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("Invalid saved group settings.");
  for (const key of ["autopilot", "paused", "dryRun", "repostDeleted", "repostViewOnce", "contentModeration"]) if (typeof group[key] !== "boolean") throw new Error("Invalid automation switch.");
  if (!["off", "destructive", "all"].includes(group.approval)) throw new Error("Invalid approval setting.");
  for (const [key, minimum, maximum] of [["proposalExpiryMs", 1000, 86400000], ["destructiveCap", 1, 1000], ["commandRate", 1, 1000], ["raidThreshold", 1, 1000], ["raidWindowMs", 1000, 1000000]]) {
    if (!Number.isInteger(group[key]) || group[key] < minimum || group[key] > maximum) throw new Error("Invalid automation limit.");
  }
  for (const key of ["moderators", "whitelist", "disabledCommands", "bans", "rules", "proposals", "audit", "destructiveActions"]) {
    if (!Array.isArray(group[key]) || group[key].length > 1000) throw new Error("Invalid saved automation list.");
  }
  for (const key of ["permissions", "aliases", "macros", "customCommands", "warnings", "linkWarnings", "warningCycles", "muted", "ruleRuns"]) {
    if (!group[key] || typeof group[key] !== "object" || Array.isArray(group[key])) throw new Error("Invalid automation mapping.");
  }
  for (const rank of Object.values(group.permissions)) if (!["member", "moderator", "admin", "owner"].includes(rank)) throw new Error("Invalid command role.");
  for (const key of ["moderators", "whitelist", "bans"]) if (group[key].some(id => typeof id !== "string" || !/^\d+@(c\.us|lid)$/.test(id))) throw new Error("Invalid saved member ID.");
  for (const until of Object.values(group.muted)) if (!Number.isFinite(until) || until < 0) throw new Error("Invalid local mute expiry.");
  for (const action of group.destructiveActions) if (!Number.isFinite(action.at) || !Number.isInteger(action.units) || action.units < 0) throw new Error("Invalid destructive action record.");
  for (const count of Object.values(group.warnings)) if (!Number.isInteger(count) || count < 0) throw new Error("Invalid warning count.");
  for (const count of Object.values(group.linkWarnings)) if (!Number.isInteger(count) || count < 0) throw new Error("Invalid link warning count.");
  if (group.linkEscalationVersion !== 1) throw new Error("Invalid link escalation version.");
  if (group.linkResetVersion !== 1 || Object.values(group.warningCycles).some(value => !Number.isInteger(value) || value < 0)) throw new Error("Invalid link warning cycle.");
  if (!group || !validTimezone(group.timezone) || !validTime(group.announceAt) ||
      !Array.isArray(group.activities) || group.activities.length > 50 ||
      (group.lastAnnouncementDate !== null && !validDate(group.lastAnnouncementDate))) {
    throw new Error("Invalid group automation settings.");
  }
  const ids = new Set();
  for (const activity of group.activities) {
    if (!activity || typeof activity.id !== "string" || !activity.id || ids.has(activity.id) ||
        !validWhen(activity.when) || !validTime(activity.time) ||
        typeof activity.text !== "string" || !activity.text.trim() || activity.text.length > 500) {
      throw new Error("Invalid saved activity.");
    }
    ids.add(activity.id);
  }
}

function createAutomationStore(filePath) {
  let state = { version: 1, groups: {} };
  if (filePath && fs.existsSync(filePath)) {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (state?.version !== 1 || !state.groups || typeof state.groups !== "object" || Array.isArray(state.groups)) {
      throw new Error("Invalid automation state file. Restore it before starting the bot.");
    }
    for (const [id, group] of Object.entries(state.groups)) {
      if (!group || typeof group !== "object" || Array.isArray(group)) throw new Error("Invalid saved group settings.");
      if (!id.endsWith("@g.us")) throw new Error("Invalid saved group ID.");
      state.groups[id] = { ...structuredClone(DEFAULT_GROUP), ...migrateLinkEscalation(group) };
      if (group.linkResetVersion !== 1) {
        const removed = new Set();
        for (const row of group.audit || []) {
          if (row.result !== "success" || row.dryRun || !row.target) continue;
          if (row.command === "warn" && (row.args?.linkWarning || row.actor?.id === "builtin-links")) removed.delete(row.target);
          if (row.command === "remove" && row.actor?.id === "builtin-link-removal") removed.add(row.target);
        }
        const { resetLinkCycle } = require("./warning-cycle");
        resetLinkCycle(state.groups[id], removed);
        state.groups[id].linkResetVersion = 1;
      }
      validateGroup(state.groups[id]);
    }
  }

  function update(groupId, edit) {
    if (typeof groupId !== "string" || !groupId.endsWith("@g.us")) throw new Error("A group ID is required.");
    const next = structuredClone(state);
    const group = next.groups[groupId] ||= structuredClone(DEFAULT_GROUP);
    edit(group);
    validateGroup(group);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next, null, 2) + "\n", { mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } finally {
        fs.rmSync(temporary, { force: true });
      }
    }
    state = next;
    return structuredClone(group);
  }

  return {
    get: id => structuredClone(state.groups[id] || DEFAULT_GROUP),
    entries: () => Object.entries(structuredClone(state.groups)),
    update
  };
}

module.exports = { DEFAULT_GROUP, validateGroup, createAutomationStore, migrateLinkEscalation, validTime, validDate, validTimezone, validWhen, weekdays };
