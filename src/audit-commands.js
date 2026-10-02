const { raw } = require("./core-commands");
const { publicError, validUser } = require("./permissions");
const { revokeForEveryone } = require("./revoke");

function installAuditCommands(engine, { client, storage, now = () => new Date(), revoke = revokeForEveryone }, { target }) {
  const register = entry => engine.register({ requiredRole: "admin", args: { raw: "string" }, parseArgs: raw, ...entry });
  async function storedTarget(ctx, permissions, field) {
    let id = ctx.args.target || ctx.args.raw?.trim().split(/\s+/)[0] || ctx.target;
    if (id === "@sender") id = ctx.event?.target || ctx.target;
    id = id?.replace(/^@/, ""); if (id && !id.includes("@")) id = `${id.replace(/^\+/, "")}@c.us`;
    if (!validUser(id)) throw publicError("Specify a member's phone ID or LID.");
    const aliases = await permissions.identities(id);
    const group = storage.get(ctx.groupId);
    const saved = (Array.isArray(group[field]) ? group[field] : Object.keys(group[field])).find(id => aliases.has(id));
    ctx.target = saved || id;
  }

  const unwarn = engine.get("unwarn");
  engine.register({ ...unwarn, resolveTarget: (ctx, permissions) => storedTarget(ctx, permissions, "warnings") });

  register({ name: "mute", description: "Locally mute a member by deleting future messages", requiredRole: "moderator", needsBotAdmin: true, automationSafe: true, effect: true, targetSafety: true, resolveTarget: target,
    run: async ctx => {
      const minutes = Number(ctx.args.minutes || ctx.args.raw?.trim().split(/\s+/)[1] || 60);
      if (!Number.isInteger(minutes) || minutes < 1 || minutes > 1440) throw publicError("Mute duration must be 1–1440 minutes.");
      const until = ctx.args.until || now().valueOf() + minutes * 60000;
      const previous = storage.get(ctx.groupId).muted[ctx.target];
      storage.update(ctx.groupId, group => { group.muted[ctx.target] = until; });
      await ctx.reply(`✅ @${ctx.target.split("@")[0]} is muted locally: the bot will delete their messages until ${new Date(until).toISOString()}. WhatsApp has no individual group-member mute permission.`);
      return { undo: previous ? { command: "mute", target: ctx.target, args: { until: previous } } : { command: "unmute", target: ctx.target, args: {} } };
    }
  });
  register({ name: "unmute", description: "Remove a local member mute", requiredRole: "moderator", automationSafe: true, effect: true, targetSafety: true, resolveTarget: (ctx, permissions) => storedTarget(ctx, permissions, "muted"),
    run: async ctx => {
      const previous = storage.get(ctx.groupId).muted[ctx.target];
      storage.update(ctx.groupId, group => { delete group.muted[ctx.target]; });
      await ctx.reply("✅ Local mute removed.");
      return { undo: previous > now().valueOf() ? { command: "mute", target: ctx.target, args: { until: previous } } : null };
    }
  });
  register({ name: "ban", description: "Remove a member and prevent rejoining while the bot is active", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, targetSafety: true, resolveTarget: target,
    run: async ctx => {
      const existed = storage.get(ctx.groupId).bans.includes(ctx.target);
      const result = await ctx.chat.removeParticipants([ctx.target]);
      if (result?.status !== 200) throw publicError("WhatsApp rejected the removal.");
      storage.update(ctx.groupId, group => { group.bans = [...new Set([...group.bans, ctx.target])]; });
      await ctx.reply("✅ Member removed and added to this group's local ban list. The bot can remove them again if they rejoin while it is active.");
      return { undo: existed ? null : { command: "unban", target: ctx.target, args: {} }, irreversible: "Unbanning does not re-add a removed member; an admin must invite them back." };
    }
  });
  register({ name: "unban", description: "Remove a local group ban", automationSafe: true, effect: true, targetSafety: true, resolveTarget: (ctx, permissions) => storedTarget(ctx, permissions, "bans"),
    run: async ctx => {
      const existed = storage.get(ctx.groupId).bans.includes(ctx.target);
      storage.update(ctx.groupId, group => { group.bans = group.bans.filter(id => id !== ctx.target); });
      await ctx.reply("✅ Local ban removed. A removed member still needs an invitation to rejoin.");
      return { undo: existed ? { command: "restoreban", target: ctx.target, args: {} } : null };
    }
  });
  register({ name: "restoreban", description: "Restore a local ban record without removing anyone", effect: true,
    resolveTarget: (ctx, permissions) => storedTarget(ctx, permissions, "bans"),
    run: async ctx => { storage.update(ctx.groupId, group => { group.bans = [...new Set([...group.bans, ctx.target])]; }); await ctx.reply("✅ Local ban record restored; no member was removed."); } });

  for (const name of ["lock", "unlock"]) register({ name, description: name === "lock" ? "Allow only admins to post" : "Allow members to post", needsBotAdmin: true, destructive: name === "lock", automationSafe: true, effect: true,
    run: async ctx => {
      const previous = ctx.chat.groupMetadata?.announce;
      const value = name === "lock";
      if (await ctx.chat.setMessagesAdminsOnly(value) !== true) throw publicError("WhatsApp rejected the group permission change.");
      await ctx.reply(`✅ ${value ? "Only admins" : "All members"} can post.`);
      return { undo: typeof previous === "boolean" && previous !== value ? { command: previous ? "lock" : "unlock", args: {} } : null, irreversible: typeof previous === "boolean" ? null : "Previous group posting permissions were unavailable; undo cannot safely infer them." };
    }
  });
  register({ name: "massdelete", description: "Delete up to 50 recent messages", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, destructiveUnits: ctx => ctx.messages.length,
    resolveTarget: async (ctx, permissions) => {
      const tokens = (ctx.args.raw || "").trim().split(/\s+/).filter(Boolean);
      const hasTarget = tokens[0]?.startsWith("@");
      if (hasTarget) { ctx.args.target = tokens[0]; await target(ctx, permissions); }
      const limit = Number(ctx.args.limit || tokens[hasTarget ? 1 : 0] || 10);
      if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw publicError("Use .massdelete [@USER] COUNT, with COUNT between 1 and 50.");
      ctx.messages = [];
      for (const message of await ctx.chat.fetchMessages({ limit })) {
        if (ctx.actor.type !== "user" && message.fromMe) continue;
        const id = message.author || message.from;
        if (ctx.target && !(await permissions.identities(id)).has(ctx.target)) continue;
        if (ctx.actor.type !== "user" && await permissions.protectedTarget(ctx.chat, ctx.groupId, id)) continue;
        ctx.messages.push(message);
      }
      // Persist concrete IDs in proposals so approval cannot select newer messages.
      if (ctx.args.messageIds) ctx.messages = ctx.messages.filter(message => ctx.args.messageIds.includes(message.id._serialized));
      else ctx.args.messageIds = ctx.messages.map(message => message.id._serialized);
    },
    run: async ctx => {
      let deleted = 0;
      for (const message of ctx.messages) { await revoke(client, message); deleted++; }
      await ctx.reply(`✅ Revocation requested for ${deleted} messages.`);
      return { irreversible: "Deleted messages cannot be restored." };
    }
  });
  register({ name: "whitelist", description: "Protect members from automated moderation", minimumRole: "admin", control: true,
    run: async ctx => {
      const [action, id] = (ctx.args.raw || "").trim().split(/\s+/);
      if (action === "list") return ctx.reply(storage.get(ctx.groupId).whitelist.join(", ") || "Whitelist is empty.");
      if (!["add", "remove"].includes(action)) throw publicError("Use .whitelist add|remove USER or .whitelist list.");
      ctx.args.target = id;
      if (action === "add") await target(ctx, engine.permissions); else await storedTarget(ctx, engine.permissions, "whitelist");
      storage.update(ctx.groupId, group => { group.whitelist = action === "add" ? [...new Set([...group.whitelist, ctx.target])] : group.whitelist.filter(id => id !== ctx.target); });
      await ctx.reply("✅ Whitelist updated.");
    }
  });
  register({ name: "audit", description: "Show recent moderation actions", minimumRole: "admin", control: true,
    run: ctx => {
      const tokens = (ctx.args.raw || "").trim().split(/\s+/).filter(Boolean);
      const count = /^\d+$/.test(tokens[0]) ? Number(tokens.shift()) : 10;
      if (count < 1 || count > 50) throw publicError("Audit count must be 1–50.");
      const actor = tokens.join(" ");
      const rows = storage.get(ctx.groupId).audit.filter(row => !actor || `${row.actor.type} ${row.actor.id}`.includes(actor)).slice(-count);
      return ctx.reply(rows.map(row => `${row.id} ${row.at} ${row.actor.type} ${row.actor.id}: ${row.command} ${JSON.stringify(row.args)} — ${row.result}${row.dryRun ? " [dry-run]" : ""}${row.approvedBy ? ` [approved by ${row.approvedBy}]` : ""}`).join("\n") || "No matching actions.");
    }
  });
  register({ name: "undo", description: "Reverse an action when supported", minimumRole: "admin", control: true,
    run: async ctx => {
      const id = ctx.args.raw?.trim(); const row = storage.get(ctx.groupId).audit.find(row => row.id === id);
      if (!row || row.result !== "success" || row.dryRun) throw publicError("That action is missing, failed, or was a dry run.");
      if (row.undoneBy) throw publicError("That action was already undone.");
      if (!row.undo) { await ctx.reply(row.irreversible || "This action has no safe automatic reversal."); return; }
      const result = await ctx.executeCommand(row.undo.command, { args: row.undo.args, target: row.undo.target });
      if (!result.ok) throw publicError("The reversal was denied or failed. Nothing else was reversed.");
      if (result.status === "success") storage.update(ctx.groupId, group => { const original = group.audit.find(row => row.id === id); if (original) original.undoneBy = ctx.actor.id; });
      await ctx.reply(`Undo ${id}: ${result.status}.${row.irreversible ? ` ${row.irreversible}` : ""}`);
      return result;
    }
  });
}

module.exports = { installAuditCommands };
