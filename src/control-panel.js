const { randomUUID } = require("node:crypto");
const { ROLES, publicError } = require("./permissions");
const { validateGroup, DEFAULT_GROUP } = require("./automation-store");
const { raw } = require("./core-commands");

function invocation(text, prefix = ".") {
  const source = String(text || "").trim();
  const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(source.startsWith(prefix) ? source.slice(prefix.length) : source);
  return match ? { name: match[1].toLowerCase(), args: match[2] || "" } : null;
}

function splitCommands(text) {
  const result = []; let current = "", quote = null, escaped = false;
  for (const char of text) {
    if (escaped) { current += char; escaped = false; continue; }
    if (char === "\\") { current += char; escaped = true; continue; }
    if (quote) { current += char; if (char === quote) quote = null; continue; }
    if (["\"", "'"].includes(char)) { quote = char; current += char; continue; }
    if (char === ";") { if (current.trim()) result.push(current.trim()); current = ""; } else current += char;
  }
  if (quote) throw publicError("Close the quote in your command.");
  if (current.trim()) result.push(current.trim());
  if (!result.length || result.length > 10) throw publicError("Use 1–10 commands separated by semicolons.");
  return result;
}

const SETTINGS_KEYS = ["timezone", "announceAt", "activities", "autopilot", "dryRun", "approval", "proposalExpiryMs", "destructiveCap", "commandRate", "moderators", "whitelist", "permissions", "disabledCommands", "aliases", "macros", "customCommands", "rules", "raidThreshold", "raidWindowMs", "repostDeleted", "repostViewOnce"];
function validName(name) { return /^[a-z][a-z0-9_-]{0,31}$/.test(name) && !["constructor", "prototype"].includes(name); }

function installControlPanel(engine, { client, storage, prefix = ".", now = () => new Date() }) {
  const selected = new Map();
  const register = entry => engine.register({ requiredRole: "admin", minimumRole: "admin", control: true, args: { raw: "string" }, parseArgs: raw, ...entry });

  async function linkStatus(ctx) {
    const group = storage.get(ctx.groupId);
    const rule = group.rules.find(rule => rule.id === "builtin-links");
    const escalation = group.rules.find(rule => rule.id === "builtin-link-removal");
    let botAdmin = "unknown";
    try { botAdmin = await engine.permissions.botAdmin(ctx.chat); } catch { /* no assumed privileges */ }
    const blockers = [];
    if (!rule?.enabled) blockers.push(`${prefix}antilink on`);
    if (!group.autopilot) blockers.push(`${prefix}set autopilot on`);
    if (group.paused || engine.auditPaused.has(ctx.groupId)) blockers.push(`${prefix}resume`);
    if (group.dryRun) blockers.push(`${prefix}set dryrun off`);
    if (group.approval !== "off") blockers.push(`${prefix}set approval off for immediate action, or approve proposals`);
    if (["delete", "warn", "remove"].some(name => group.disabledCommands.includes(name))) blockers.push(`${prefix}antilink on`);
    const used = group.destructiveActions.filter(action => now().valueOf() - action.at < 3600000).reduce((sum, action) => sum + action.units, 0);
    if (used >= group.destructiveCap) blockers.push("Wait for hourly capacity or adjust the cap before resuming");
    if (botAdmin !== true) blockers.push("Make the linked bot account a group admin; warnings can still work without deletion privileges");
    const threshold = /link_warning_count_reached\((\d+)\)/.exec(escalation?.source || "")?.[1];
    return `Link moderation: ${rule?.enabled ? "on" : "off"}\nRepeated-link removal: ${escalation?.enabled ? threshold ? `from offence ${threshold}` : "custom rule" : `off (${prefix}rule enable builtin-link-removal)`}\nBot admin: ${botAdmin}\nAutomated destructive attempts this hour: ${used}/${group.destructiveCap}\n${blockers.length ? `To enable immediate deletion, warnings and removal:\n${[...new Set(blockers)].join("\n")}` : "Ready to delete and warn on non-admin members' links."}\nTest using another non-admin account; the linked bot, admins, owners, moderators, and whitelist are exempt.`;
  }

  register({ name: "help", description: "Show available bot commands", groupOptional: true, requiredRole: "member", minimumRole: "member",
    run: ctx => ctx.reply([
      `Members: ${prefix}ping, ${prefix}activities, ${prefix}cmds`,
      `Moderation: ${prefix}warn USER reason, ${prefix}unwarn USER, ${prefix}d (reply to a message), ${prefix}mute USER MINUTES, ${prefix}unmute USER`,
      `Admins: ${prefix}antilink on|off|status, ${prefix}status, ${prefix}r (reply to a member), ${prefix}ban USER, ${prefix}unban USER, ${prefix}lock, ${prefix}unlock`,
      `Admin recovery: ${prefix}deleted lists saved deleted messages; ${prefix}retrieve ID reposts one; ${prefix}retrieve gets the latest deletion.`,
      `Admin link recovery: ${prefix}restorelink list shows links deleted by the bot; ${prefix}restorelink ID restores one to the group chat; ${prefix}restorelink restores the latest. Also sends to the selected group when used in private control.`,
      `Admin view-once recovery: reply to the media with ${prefix}v; ${prefix}v retrieves the latest saved view-once file; ${prefix}v list shows saved IDs; ${prefix}v ID retrieves one. ${prefix}viewonce is also supported. Available copies are reposted as normal media. WhatsApp sometimes delivers only a placeholder with no file; those cannot be recovered. Archive: 24 hours.`,
      `Automatic recovery: on by default. Admins: ${prefix}set repostdeleted on|off, ${prefix}set repostviewonce on|off. Rejoined members start link warnings from zero.`,
      `Activities: ${prefix}activities week. Any group admin can add games or events: ${prefix}activity add friday 20:00 | Truth or Dare. More: ${prefix}activity help`,
      `Automation: ${prefix}rule list, ${prefix}set approval off|destructive|all, ${prefix}panic, ${prefix}resume, ${prefix}audit`,
      `Private admin control: ${prefix}groups, then ${prefix}use GROUP_ID`,
      "Commands must come from another account. Give the bot admin privileges to delete group messages."
    ].join("\n")) });
  register({ name: "antilink", description: "Enable, disable, or diagnose default link moderation",
    run: async ctx => {
      const action = ctx.args.raw?.trim() || "status";
      if (!["on", "off", "status"].includes(action)) throw publicError(`Use ${prefix}antilink on|off|status.`);
      if (action !== "status") storage.update(ctx.groupId, group => {
        if (action === "on") {
          for (const id of ["builtin-links", "builtin-link-removal"]) {
            const rule = structuredClone(DEFAULT_GROUP.rules.find(rule => rule.id === id));
            const index = group.rules.findIndex(saved => saved.id === id);
            if (index < 0) {
              if (group.rules.length >= 50) throw publicError("Remove an old rule before restoring link moderation.");
              group.rules.push(rule);
            } else group.rules[index] = rule;
            delete group.ruleRuns[rule.id];
          }
          group.disabledCommands = group.disabledCommands.filter(name => !["delete", "warn", "remove"].includes(name));
        } else for (const rule of group.rules) if (["builtin-links", "builtin-link-removal"].includes(rule.id)) rule.enabled = false;
      });
      await ctx.reply(await linkStatus(ctx));
    }
  });

  async function groups(actorId) {
    const available = [];
    for (const chat of await client.getChats()) {
      if (!chat.isGroup) continue;
      try {
        if (ROLES[await engine.permissions.role(chat, chat.id._serialized, actorId)] >= ROLES.admin) available.push(chat);
      } catch { /* unresolved identities do not grant access */ }
    }
    return available;
  }

  async function selectionKey(id) {
    const aliases = await engine.permissions.identities(id);
    return [...aliases].find(id => id.endsWith("@c.us")) || id;
  }

  async function context(message) {
    const actorId = message.author || message.from;
    const inGroup = message.from?.endsWith("@g.us");
    return { groupId: inGroup ? message.from : selected.get(await selectionKey(actorId)),
      actor: { type: "user", id: actorId }, isDM: !inGroup, message,
      reply: text => message.reply(text), client, storage };
  }

  async function executeText(text, ctx) {
    const parsed = invocation(text, prefix);
    if (!parsed) throw publicError("Enter a command.");
    return engine.executeCommand(parsed.name, { ...ctx, groupId: ["groups", "use"].includes(parsed.name) ? null : ctx.groupId, args: parsed.args });
  }

  engine.resolveDynamic = (name, ctx) => {
    if (!ctx.groupId) return null;
    const group = storage.get(ctx.groupId);
    if (Object.hasOwn(group.aliases, name)) return {
      name: `alias:${name}`, requiredRole: "member", automationSafe: true, effect: false,
      args: { raw: "string" }, parseArgs: raw,
      run: async child => {
        const parsed = invocation(group.aliases[name], prefix);
        const outcome = await child.executeCommand(parsed.name, { args: `${parsed.args} ${child.args.raw || ""}`.trim() });
        if (!outcome.ok) throw publicError("Shortcut stopped because its command was denied or failed.");
        return outcome;
      }
    };
    if (Object.hasOwn(group.macros, name)) return {
      name: `macro:${name}`, requiredRole: "member", automationSafe: true, effect: false,
      args: { raw: "string" }, parseArgs: raw,
      run: async child => {
        const results = [];
        for (const text of group.macros[name]) {
          const parsed = invocation(text, prefix);
          const result = await child.executeCommand(parsed.name, { args: parsed.args }); results.push(result);
          if (!result.ok) throw publicError("Macro stopped because a step was denied or failed.");
        }
        return { results };
      }
    };
    if (Object.hasOwn(group.customCommands, name)) return {
      name: `custom:${name}`, description: "Group FAQ answer", requiredRole: "member", automationSafe: true, effect: true, args: {}, run: child => child.reply(group.customCommands[name])
    };
    return null;
  };

  register({ name: "groups", description: "List groups you administer", groupOptional: true,
    run: async ctx => ctx.reply((await groups(ctx.actor.id)).map(chat => `${chat.name}: ${chat.id._serialized}`).join("\n") || "You do not administer any accessible groups.") });
  register({ name: "use", description: "Select a group for private control", groupOptional: true,
    run: async ctx => {
      const query = (ctx.args.raw || "").trim();
      const matches = (await groups(ctx.actor.id)).filter(chat => chat.id._serialized === query || chat.name?.toLowerCase() === query.toLowerCase());
      if (matches.length !== 1) throw publicError("Use one exact group ID from .groups (or a unique group name).");
      const chat = matches[0];
      selected.set(await selectionKey(ctx.actor.id), chat.id._serialized);
      ctx.groupId = chat.id._serialized;
      await ctx.reply(`✅ Selected ${chat.name}. Admin status will be checked on every command.`);
    }
  });
  register({ name: "status", description: "Show group bot status",
    run: async ctx => {
      const group = storage.get(ctx.groupId); let botAdmin = "unknown";
      try { botAdmin = await engine.permissions.botAdmin(ctx.chat); } catch { /* show unknown rather than assume privilege */ }
      const removals = group.audit.filter(row => ["remove", "ban"].includes(row.command) && row.result === "success" && now() - new Date(row.at) < 3600000).length;
      const errors = group.audit.filter(row => row.result === "failed").slice(-3).map(row => `${row.command}: ${row.error}`).join("\n") || "none";
      const pending = group.proposals.filter(proposal => proposal.status === "pending").map(proposal => `${proposal.id}: ${proposal.command}`).join(", ") || "none";
      const linkRule = group.rules.find(rule => rule.id === "builtin-links");
      await ctx.reply(`Autopilot: ${group.autopilot ? "on" : "off"}\nPaused: ${group.paused || engine.auditPaused.has(ctx.groupId)}\nDry run: ${group.dryRun}\nApproval: ${group.approval}\nLink moderation: ${linkRule?.enabled ? "on" : "off"} (${prefix}antilink status for details)\nPending proposals: ${pending}\nBot admin: ${botAdmin}\nActive timers: ${group.activities.length ? 1 : 0} agenda, ${group.rules.filter(rule => rule.enabled && rule.trigger === "schedule").length} scheduled rules\nWarnings: ${JSON.stringify(group.warnings)}\nLink offences: ${JSON.stringify(group.linkWarnings)}\nRemovals this hour: ${removals}\nRecent errors:\n${errors}`);
    }
  });
  register({ name: "set", description: "Change an automation setting",
    run: async ctx => {
      const [key, ...rest] = (ctx.args.raw || "").trim().split(/\s+/); const value = rest.join(" ");
      storage.update(ctx.groupId, group => {
        if (["autopilot", "dryrun", "repostdeleted", "repostviewonce"].includes(key)) {
          if (!["on", "off"].includes(value)) throw publicError("Use on or off.");
          group[{ dryrun: "dryRun", repostdeleted: "repostDeleted", repostviewonce: "repostViewOnce" }[key] || key] = value === "on";
        } else if (key === "approval") {
          if (!["off", "destructive", "all"].includes(value)) throw publicError("Approval mode: off, destructive, or all.");
          group.approval = value;
        } else if (["cap", "rate", "approvalttl", "raidcount", "raidwindow"].includes(key)) {
          const number = Number(value); if (!Number.isInteger(number) || number < 1 || number > (key === "approvalttl" ? 1440 : 1000)) throw publicError("Enter a valid positive limit.");
          group[{ cap: "destructiveCap", rate: "commandRate", approvalttl: "proposalExpiryMs", raidcount: "raidThreshold", raidwindow: "raidWindowMs" }[key]] = key === "approvalttl" ? number * 60000 : key === "raidwindow" ? number * 1000 : number;
        } else throw publicError("Settings: autopilot, dryrun, repostdeleted, repostviewonce, approval, cap, rate, approvalttl, raidcount, raidwindow.");
      });
      await ctx.reply(`✅ ${key} set to ${value}.`);
    }
  });
  for (const action of ["panic", "resume"]) register({ name: action, groupOptional: true, description: action === "panic" ? "Pause automation immediately" : "Resume automation", urgent: true,
    run: async ctx => {
      const all = ctx.args.raw?.trim() === "all";
      if (!all && !ctx.groupId) throw publicError("Select a group first with .use GROUP_ID.");
      if (all && !(await engine.permissions.isOwner(ctx.actor.id))) throw publicError("Only owners can pause or resume all groups.");
      const ids = all ? [...new Set([...storage.entries().map(([id]) => id), ...(await client.getChats()).filter(chat => chat.isGroup).map(chat => chat.id._serialized)])] : [ctx.groupId];
      for (const id of ids) storage.update(id, group => {
        group.paused = action === "panic";
        if (id !== ctx.groupId) group.audit.push({ id: randomUUID().slice(0, 8), at: now().toISOString(), actor: ctx.actor, command: action, args: { all: true }, result: "success", dryRun: false, approvedBy: null });
        group.audit = group.audit.slice(-200);
      });
      if (action === "resume") for (const id of ids) engine.auditPaused.delete(id);
      await ctx.reply(`✅ Automation ${action === "panic" ? "paused" : "resumed"}${all ? " in all groups" : " in this group"}.`);
    }
  });
  register({ name: "config", description: "Export or import group settings",
    run: async ctx => {
      const text = ctx.args.raw || "";
      if (text === "export") {
        const group = storage.get(ctx.groupId);
        return ctx.reply(JSON.stringify({ version: 1, settings: Object.fromEntries(SETTINGS_KEYS.map(key => [key, group[key]])) }, null, 2));
      }
      if (!text.startsWith("import ") || text.length > 30000) throw publicError("Use .config export or .config import JSON (maximum 30,000 characters).");
      let data; try { data = JSON.parse(text.slice(7)); } catch { throw publicError("The import must contain valid JSON."); }
      if (data?.version !== 1 || !data.settings || Object.keys(data.settings).some(key => !SETTINGS_KEYS.includes(key))) throw publicError("Unsupported settings backup.");
      const candidate = { ...storage.get(ctx.groupId), ...data.settings };
      validateGroup(candidate);
      for (const key of ["aliases", "macros", "customCommands"]) {
        if (Object.keys(candidate[key]).some(name => !validName(name))) throw publicError("Invalid shortcut or command name in backup.");
      }
      if (Object.keys(candidate.permissions).some(name => !validName(name.replace(/^(alias|macro|custom):/, "")))) throw publicError("Invalid command name in backup.");
      const shortcutNames = ["aliases", "macros", "customCommands"].flatMap(key => Object.keys(candidate[key]));
      if (new Set(shortcutNames).size !== shortcutNames.length || shortcutNames.some(name => engine.entries().some(entry => entry.name === name || entry.aliases.includes(name)))) throw publicError("Conflicting shortcut names in backup.");
      for (const value of Object.values(candidate.aliases)) if (typeof value !== "string" || !invocation(value, prefix)) throw publicError("Invalid alias in backup.");
      for (const value of Object.values(candidate.macros)) if (!Array.isArray(value) || value.length > 10 || value.some(text => typeof text !== "string" || !invocation(text, prefix))) throw publicError("Invalid macro in backup.");
      for (const value of Object.values(candidate.customCommands)) if (typeof value !== "string" || value.length > 2000) throw publicError("Invalid FAQ answer in backup.");
      if (candidate.rules.length) engine.validateRules?.(candidate.rules);
      storage.update(ctx.groupId, group => { for (const key of SETTINGS_KEYS) group[key] = candidate[key]; });
      await ctx.reply("✅ Group settings imported. Audit and proposal history were preserved.");
    }
  });
  register({ name: "alias", description: "Create a command shortcut",
    run: async ctx => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(ctx.args.raw || "");
      if (!match || !validName(match[1])) throw publicError("Use .alias NAME COMMAND [fixed arguments].");
      if (engine.entries().some(entry => entry.name === match[1] || entry.aliases.includes(match[1]))) throw publicError("A built-in command already uses that name.");
      if (!engine.get(invocation(match[2], prefix).name, ctx)) throw publicError("The shortcut must refer to an existing command.");
      if (Object.hasOwn(storage.get(ctx.groupId).macros, match[1]) || Object.hasOwn(storage.get(ctx.groupId).customCommands, match[1])) throw publicError("Another shortcut already uses that name.");
      storage.update(ctx.groupId, group => { group.aliases[match[1]] = match[2]; });
      await ctx.reply(`✅ Shortcut ${prefix}${match[1]} saved.`);
    }
  });
  register({ name: "macro", description: "Create a sequence of commands",
    run: async ctx => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(ctx.args.raw || "");
      if (!match || !validName(match[1])) throw publicError("Use .macro NAME COMMAND; COMMAND.");
      if (engine.entries().some(entry => entry.name === match[1] || entry.aliases.includes(match[1]))) throw publicError("A built-in command already uses that name.");
      const commands = splitCommands(match[2]);
      if (commands.some(text => !engine.get(invocation(text, prefix).name, ctx))) throw publicError("Every macro step must be an existing command.");
      if (Object.hasOwn(storage.get(ctx.groupId).aliases, match[1]) || Object.hasOwn(storage.get(ctx.groupId).customCommands, match[1])) throw publicError("Another shortcut already uses that name.");
      storage.update(ctx.groupId, group => { group.macros[match[1]] = commands; });
      await ctx.reply(`✅ Macro ${prefix}${match[1]} saved. Each step checks permissions.`);
    }
  });
  register({ name: "addcmd", description: "Create a FAQ answer",
    run: async ctx => {
      const match = /^(\S+)\s+([\s\S]+)$/.exec(ctx.args.raw || "");
      if (!match || !validName(match[1]) || match[2].length > 2000) throw publicError("Use .addcmd TRIGGER RESPONSE (maximum 2,000 characters).");
      if (engine.entries().some(entry => entry.name === match[1] || entry.aliases.includes(match[1]))) throw publicError("A built-in command already uses that name.");
      if (Object.hasOwn(storage.get(ctx.groupId).aliases, match[1]) || Object.hasOwn(storage.get(ctx.groupId).macros, match[1])) throw publicError("Another shortcut already uses that name.");
      storage.update(ctx.groupId, group => { group.customCommands[match[1]] = match[2]; });
      await ctx.reply(`✅ FAQ '${match[1]}' saved.`);
    }
  });
  register({ name: "delcmd", description: "Remove a FAQ answer", run: async ctx => { storage.update(ctx.groupId, group => { delete group.customCommands[ctx.args.raw?.trim()]; }); await ctx.reply("✅ FAQ removed."); } });
  register({ name: "cmds", description: "List FAQ triggers", requiredRole: "member", minimumRole: "member", run: ctx => ctx.reply(Object.keys(storage.get(ctx.groupId).customCommands).join(", ") || "No FAQ commands saved.") });
  register({ name: "say", description: "Send a group message", requiredRole: "moderator", minimumRole: "member", control: false, effect: true, automationSafe: true,
    run: ctx => {
      const text = ctx.args.text || ctx.args.raw;
      if (!text || text.length > 4000) throw publicError("Use .say MESSAGE (maximum 4,000 characters).");
      const id = ctx.event?.target || ctx.target;
      return ctx.chat.sendMessage(text.replaceAll("@sender", id ? `@${id.split("@")[0]}` : "member"), id ? { mentions: [id] } : {});
    }
  });
  for (const name of ["yes", "no"]) register({ name, description: name === "yes" ? "Approve a proposal" : "Reject a proposal", run: ctx => engine.decide(ctx, name === "yes") });
  return { context, executeText, groups, selected };
}

module.exports = { installControlPanel, invocation, splitCommands, SETTINGS_KEYS, validName };
