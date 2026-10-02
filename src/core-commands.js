const { revokeForEveryone } = require("./revoke");
const { publicError, validUser } = require("./permissions");
const { containsLink } = require("./links");
const { resetLinkCycle, checkLinkCycle } = require("./warning-cycle");
const raw = args => typeof args === "string" ? { raw: args } : args || {};
const senderId = message => message?.author || message?.from;

function installCoreCommands(engine, { client, storage, prefix = ".", revoke = revokeForEveryone, now = () => new Date(), logger = console }) {
  async function target(ctx, permissions) {
    const token = ctx.args.raw?.trim().split(/\s+/)[0];
    let id = ctx.args.target || (token && /^(?:@?\+?\d+(?:@(?:c\.us|lid))?|@sender)$/.test(token) ? token : ctx.target);
    if (typeof id === "object") id = id.id?._serialized;
    if (id === "@sender") id = ctx.event?.target || ctx.target || senderId(ctx.message);
    if (id?.startsWith("@")) id = id.slice(1);
    if (id && !id.includes("@")) id = `${id.replace(/^\+/, "")}@c.us`;
    if (!id && ctx.message?.hasQuotedMsg) {
      ctx.targetMessage = await ctx.message.getQuotedMessage(); id = senderId(ctx.targetMessage);
    }
    const person = await permissions.participant(ctx.chat, id);
    if (!person) throw publicError("That member is no longer in the group or could not be resolved.");
    ctx.target = person.id._serialized; ctx.participant = person;
  }

  async function deleteTarget(ctx, permissions) {
    if (!ctx.targetMessage) {
      if (ctx.args.messageId) ctx.targetMessage = await client.getMessageById(ctx.args.messageId);
      else if (ctx.actor.type !== "user" && ctx.message) ctx.targetMessage = ctx.message;
      else if (ctx.message?.hasQuotedMsg) ctx.targetMessage = await ctx.message.getQuotedMessage();
      else if (ctx.args.raw?.trim()) ctx.targetMessage = await client.getMessageById(ctx.args.raw.trim());
      else throw publicError(`Reply to a message with ${prefix}d.`);
    }
    const remote = ctx.targetMessage?.id?.remote?._serialized || ctx.targetMessage?.id?.remote ||
      (ctx.targetMessage?.fromMe ? ctx.targetMessage?.to : ctx.targetMessage?.from);
    if (remote && remote !== ctx.groupId) throw publicError("That message belongs to another group.");
    ctx.target = senderId(ctx.targetMessage);
    if (ctx.actor.type !== "user") await target(ctx, permissions);
  }

  const register = definition => engine.register({ args: { raw: "string", target: "user ID" }, parseArgs: raw, ...definition });
  register({ name: "ping", description: "Check the bot", groupOptional: true, automationSafe: true, effect: true, run: ctx => ctx.reply("pong") });
  register({ name: "delete", aliases: ["d"], description: "Revoke a quoted message or message ID", requiredRole: "moderator", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, targetSafety: true, resolveTarget: deleteTarget,
    failureMessage: "Could not delete that message for everyone. Check permissions and message age.",
    run: async ctx => {
      await revoke(client, ctx.targetMessage);
      if (ctx.actor.type === "user" && ctx.message?.from === ctx.groupId && ctx.targetMessage !== ctx.message) {
        try { await revoke(client, ctx.message); } catch (error) { logger.warn("[DELETE] command cleanup failed:", error); }
      }
      return { irreversible: "Deleted messages cannot be restored." };
    }
  });
  register({ name: "remove", aliases: ["r"], description: "Remove a member", requiredRole: "admin", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, targetSafety: true,
    resolveTarget: async (ctx, permissions) => {
      if (!ctx.args.raw && !ctx.args.target && !ctx.target && !ctx.message?.hasQuotedMsg) throw publicError(`Reply to a member's message with ${prefix}r.`);
      await target(ctx, permissions);
      if (ctx.actor.id === "builtin-link-removal") checkLinkCycle(ctx, storage);
    }, failureMessage: "Could not remove that member.",
    run: async ctx => {
      const result = await ctx.chat.removeParticipants([ctx.target]);
      if (result?.status !== 200) throw new Error(`Removal failed: ${result?.status}`);
      if (ctx.actor.id === "builtin-link-removal") {
        const identities = await engine.permissions.identities(ctx.target);
        identities.add(ctx.target);
        storage.update(ctx.groupId, group => resetLinkCycle(group, identities));
      }
      if (ctx.actor.type === "rule" && ctx.actor.id === "builtin-link-removal") {
        try {
          await ctx.chat.sendMessage(`🚫 @${ctx.target.split("@")[0]} was removed for repeatedly posting links.`, { mentions: [ctx.target] });
        } catch (error) { logger.warn("[REMOVE] removal succeeded but announcement failed:", error); }
      } else await ctx.reply("✅ Removal requested.");
      return { irreversible: "A completed removal cannot be undone automatically; an admin can invite the member back." };
    }
  });
  register({ name: "warn", description: "Warn a member", requiredRole: "moderator", automationSafe: true, effect: true, targetSafety: true,
    resolveTarget: async (ctx, permissions) => {
      await target(ctx, permissions);
      if (ctx.actor.type !== "user" && ctx.ruleTrigger === "link_detected" && ctx.target === ctx.event?.target && containsLink(ctx.message?.body)) ctx.args.linkWarning = true;
      if (ctx.args.linkWarning) checkLinkCycle(ctx, storage);
    },
    run: async ctx => {
      const linkWarning = ctx.args.linkWarning === true;
      const group = storage.update(ctx.groupId, group => {
        group.warnings[ctx.target] = (group.warnings[ctx.target] || 0) + 1;
        if (linkWarning) group.linkWarnings[ctx.target] = (group.linkWarnings[ctx.target] || 0) + 1;
      });
      const count = group.warnings[ctx.target];
      const linkCount = linkWarning ? group.linkWarnings[ctx.target] : null;
      const reason = ctx.args.reason || ctx.args.raw?.trim().split(/\s+/).slice(1).join(" ") || "links are not allowed for non-admins in this group.";
      await ctx.chat.sendMessage(`⚠️ @${ctx.target.split("@")[0]}, warning ${linkWarning ? linkCount : count}: ${reason}${linkWarning ? `\nLink offences: ${linkCount}.` : ""}`, { mentions: [ctx.target] });
      return { count, linkCount, event: "warn_count_reached", undo: { command: "unwarn", target: ctx.target, args: { amount: 1, linkWarning, ...(linkWarning ? { warningCycle: ctx.args.warningCycle } : {}) } } };
    }
  });
  register({ name: "unwarn", description: "Remove a warning", requiredRole: "moderator", automationSafe: true, effect: true, targetSafety: true, resolveTarget: target,
    run: async ctx => {
      if (ctx.args.linkWarning && ctx.args.warningCycle !== undefined) checkLinkCycle(ctx, storage);
      storage.update(ctx.groupId, group => {
        group.warnings[ctx.target] = Math.max(0, (group.warnings[ctx.target] || 0) - (ctx.args.amount || 1));
        if (ctx.args.linkWarning !== false) group.linkWarnings[ctx.target] = Math.max(0, (group.linkWarnings[ctx.target] || 0) - (ctx.args.amount || 1));
      });
      await ctx.reply("✅ Warning removed.");
    }
  });
  register({ name: "mod", description: "Delegate moderation commands", requiredRole: "admin", minimumRole: "admin", control: true,
    run: async ctx => {
      const [action, id] = (ctx.args.raw || "").trim().split(/\s+/);
      if (action === "list") return ctx.reply(`Moderators: ${storage.get(ctx.groupId).moderators.join(", ") || "none"}`);
      if (!["add", "remove"].includes(action)) throw publicError("Use .mod add|remove USER_ID or .mod list.");
      ctx.args.target = id;
      if (action === "remove") {
        let input = id?.replace(/^@/, ""); if (input && !input.includes("@")) input = `${input.replace(/^\+/, "")}@c.us`;
        const aliases = await engine.permissions.identities(input);
        ctx.target = storage.get(ctx.groupId).moderators.find(id => aliases.has(id));
        if (!ctx.target) throw publicError("That moderator is not delegated in this group.");
      } else await target(ctx, engine.permissions);
      storage.update(ctx.groupId, group => { group.moderators = action === "add" ? [...new Set([...group.moderators, ctx.target])] : group.moderators.filter(id => id !== ctx.target); });
      await ctx.reply(`✅ Moderator ${action === "add" ? "added" : "removed"}.`);
    }
  });
  register({ name: "perm", description: "Change a command's minimum role", requiredRole: "admin", minimumRole: "admin", control: true,
    run: async ctx => {
      const [name, role] = (ctx.args.raw || "").trim().split(/\s+/);
      const command = engine.get(name, ctx);
      if (!command || !["owner", "admin", "moderator", "member"].includes(role)) throw publicError("Use .perm COMMAND owner|admin|moderator|member.");
      if (command.minimumRole && ["moderator", "member"].includes(role)) throw publicError("Administrative controls must remain admin-only.");
      storage.update(ctx.groupId, group => { group.permissions[command.name] = role; });
      await ctx.reply(`✅ ${command.name} now requires ${role}.`);
    }
  });
  register({ name: "cmd", description: "Enable or disable a command", requiredRole: "admin", minimumRole: "admin", control: true,
    run: async ctx => {
      const [action, name] = (ctx.args.raw || "").trim().split(/\s+/); const command = engine.get(name, ctx);
      if (!["enable", "disable"].includes(action) || !command) throw publicError("Use .cmd enable|disable COMMAND.");
      if (command.control) throw publicError("Administrative recovery controls cannot be disabled.");
      storage.update(ctx.groupId, group => { group.disabledCommands = action === "disable" ? [...new Set([...group.disabledCommands, command.name])] : group.disabledCommands.filter(name => name !== command.name); });
      await ctx.reply(`✅ ${command.name} ${action}d.`);
    }
  });
  return { target, deleteTarget, register };
}

module.exports = { installCoreCommands, raw };
