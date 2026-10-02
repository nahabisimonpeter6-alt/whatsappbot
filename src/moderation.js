const { containsLink } = require("./links");
const { revokeForEveryone } = require("./revoke");
const { createCommandRegistry } = require("./command-registry");

function createModeration({ client, prefix = ".", logger = console, revoke = revokeForEveryone, handleCommand = async () => false, registry, onMessageAutomation }) {
  const commands = registry || createCommandRegistry({ onError: error => logger.error("[COMMAND] failed:", error) });
  const strikes = new Map();
  const body = message => String(message?.body || "").trim();
  const senderId = message => message?.author || message?.from || "";
  const isGroup = message => typeof message?.from === "string" && message.from.endsWith("@g.us");
  const userId = id => /^\d+@(c\.us|lid)$/.test(id || "");

  async function participantById(chat, id) {
    if (!userId(id)) return null;
    const participants = chat?.participants || [];
    const exact = participants.find(p => p?.id?._serialized === id);
    if (exact) return exact;

    // A LID and a phone number can have unrelated digits. Never compare only
    // their numeric portions, which could grant privileges to the wrong user.
    const identities = await client.getContactLidAndPhone([id]);
    const aliases = new Set([id]);
    for (const identity of identities || []) {
      if (identity.lid) aliases.add(identity.lid);
      if (identity.pn) aliases.add(identity.pn);
    }
    return participants.find(p => aliases.has(p?.id?._serialized)) || null;
  }

  async function isAdmin(chat, id) {
    const participant = await participantById(chat, id);
    if (!participant) throw new Error("That group member's identity could not be verified.");
    return !!(participant.isAdmin || participant.isSuperAdmin);
  }

  async function botIsAdmin(chat) {
    return isAdmin(chat, client.info?.wid?._serialized);
  }

  async function getChat(message) {
    const chat = await message.getChat();
    if (!chat?.isGroup) throw new Error("The group could not be resolved.");
    return chat;
  }

  async function warn(message, chat, participant) {
    const key = `${message.from}:${participant.id._serialized}`;
    const count = (strikes.get(key) || 0) + 1;
    strikes.set(key, count);
    const id = participant.id._serialized;
    await chat.sendMessage(`⚠️ @${id.split("@")[0]}, warning ${count}: links are not allowed for non-admins in this group.`, { mentions: [id] });
  }

  async function antiLink(message) {
    if (!isGroup(message) || !containsLink(message.body)) return false;
    try {
      const chat = await getChat(message);
      const participant = await participantById(chat, senderId(message));
      if (!participant) throw new Error("Link sender's identity could not be verified.");
      if (participant.isAdmin || participant.isSuperAdmin) return false;
      if (await botIsAdmin(chat)) {
        try {
          const outcome = await commands.executeCommand("delete", { groupId: message.from, actor: { type: "system", id: "anti-link" }, args: { link: true }, targetMessage: message, message, chat, client, reply: () => {} });
          if (outcome.ok && outcome.status === "success") logger.log("[ANTI-LINK] message revoked for everyone");
        } catch (error) {
          logger.error("[ANTI-LINK] revocation failed:", error);
        }
      } else {
        logger.warn("[ANTI-LINK] bot must be an admin to delete links");
      }
      await commands.executeCommand("warn", { groupId: message.from, actor: { type: "system", id: "anti-link" }, message, chat, target: participant.id._serialized, participant, args: {}, client, reply: text => chat.sendMessage(text) });
    } catch (error) {
      // Failed identity resolution must not cause an administrator's message
      // to be deleted. A later message will retry resolution.
      logger.error("[ANTI-LINK] moderation failed:", error);
    }
    return true;
  }

  async function authorize(message) {
    const chat = await getChat(message);
    if (!(await isAdmin(chat, senderId(message)))) {
      await message.reply("❌ Admins only.");
      return null;
    }
    if (!(await botIsAdmin(chat))) {
      await message.reply("❌ The bot must be a group admin.");
      return null;
    }
    return chat;
  }

  async function runDelete(message) {
    try {
      if (!(await authorize(message))) return true;
      if (!message.hasQuotedMsg) {
        await message.reply(`Reply to a message with ${prefix}d.`);
        return true;
      }
      const quoted = await message.getQuotedMessage();
      await revoke(client, quoted);
      // Cleanup failure must not report the already-revoked target as a failure.
      try {
        await revoke(client, message);
      } catch (error) {
        logger.warn("[DELETE] command cleanup failed:", error);
      }
    } catch (error) {
      logger.error("[DELETE] failed:", error);
      await message.reply("❌ Could not delete that message for everyone. Check permissions and message age.");
    }
    return true;
  }

  async function runRemove(message) {
    try {
      const chat = await authorize(message);
      if (!chat) return true;
      if (!message.hasQuotedMsg) {
        await message.reply(`Reply to a member's message with ${prefix}r.`);
        return true;
      }
      const quoted = await message.getQuotedMessage();
      const participant = await participantById(chat, senderId(quoted));
      if (!participant) {
        await message.reply("❌ That member is no longer in the group or could not be resolved.");
        return true;
      }
      const result = await chat.removeParticipants([participant.id._serialized]);
      if (result?.status !== 200) throw new Error(`Removal failed with status ${result?.status}.`);
      await message.reply("✅ Removal requested.");
    } catch (error) {
      logger.error("[REMOVE] failed:", error);
      await message.reply("❌ Could not remove that member.");
    }
    return true;
  }

  commands.register({ name: "delete", aliases: ["d"], description: "Delete a quoted message for everyone", requiredRole: "admin", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, args: { link: "boolean" },
    run: ctx => ctx.args.link ? revoke(client, ctx.targetMessage) : runDelete(ctx.message) });
  commands.register({ name: "remove", aliases: ["r"], description: "Remove a quoted group member", requiredRole: "admin", needsBotAdmin: true, destructive: true, automationSafe: true, effect: true, args: {}, run: ctx => runRemove(ctx.message) });
  commands.register({ name: "warn", description: "Warn a member about links", requiredRole: "admin", automationSafe: true, effect: true, args: {}, run: ctx => warn(ctx.message, ctx.chat, ctx.participant) });
  commands.register({ name: "ping", description: "Check the bot", automationSafe: true, args: {}, run: ctx => ctx.reply("pong") });

  async function deleteQuoted(message) {
    if (!isGroup(message) || body(message) !== `${prefix}d`) return false;
    await commands.executeCommand("delete", { groupId: message.from, actor: { type: "user", id: senderId(message) }, args: {}, message, client, reply: text => message.reply(text) });
    return true;
  }
  async function removeQuoted(message) {
    if (!isGroup(message) || body(message) !== `${prefix}r`) return false;
    await commands.executeCommand("remove", { groupId: message.from, actor: { type: "user", id: senderId(message) }, args: {}, message, client, reply: text => message.reply(text) });
    return true;
  }

  async function handleMessage(message) {
    if (message?.fromMe) return;
    try {
      if (onMessageAutomation) { if (await onMessageAutomation(message)) return; }
      else if (await antiLink(message)) return;
      if (await deleteQuoted(message)) return;
      if (await removeQuoted(message)) return;
      if (await handleCommand(message)) return;
      if (body(message) === `${prefix}ping`) await commands.executeCommand("ping", { groupId: isGroup(message) ? message.from : null, actor: { type: "user", id: senderId(message) }, message, client, reply: text => message.reply(text) });
    } catch (error) {
      logger.error("[MESSAGE] failed:", error);
    }
  }

  return { handleMessage, isAdmin, registry: commands };
}

module.exports = { createModeration };
