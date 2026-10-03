const { createCommandEngine } = require("./command-engine");
const { installCoreCommands, raw } = require("./core-commands");
const { installControlPanel, invocation } = require("./control-panel");
const { installAuditCommands } = require("./audit-commands");
const { createModeration } = require("./moderation");
const { createAutomations, agenda, selectedAgenda, localClock } = require("./automations");
const { createRulesEngine } = require("./rules");
const { publicError } = require("./permissions");
const { createMessageArchive, unavailableViewOnce } = require("./message-archive");
const { installRecoveryCommands } = require("./recovery-commands");
const { revokeForEveryone } = require("./revoke");
const { installAutoRecovery } = require("./auto-recovery");
const { resetLinkCycle } = require("./warning-cycle");
const { createContentClassifier } = require("./content-classifier");
const { installContentFilter } = require("./content-filter");

function createController({ client, storage, prefix = ".", logger = console, now = () => new Date(), ownerNumbers, revoke,
  archive = createMessageArchive(undefined, { now, logger }), makeMedia, contentClassifier = createContentClassifier({ logger }) }) {
  function capture(message) {
    try { return archive.observe(message, { retryMedia: true }); } catch (error) { logger.error("[ARCHIVE] capture failed:", error); }
  }
  function handleRevocation(message, original) {
    try {
      const id = archive.revoked(message, original), groupId = original?.from || message?.from;
      if (id) recovery.schedule(groupId, id, "deleted");
    } catch (error) { logger.error("[ARCHIVE] deletion capture failed:", error); }
  }
  const options = { client, storage, prefix, logger, now, ownerNumbers, archive, makeMedia,
    revoke: async (sender, message) => {
      capture(message);
      // Mark before revocation: WhatsApp can emit its deletion event before
      // the revoke call returns. Recovery must not undo moderation.
      recovery.suppress(message);
      await (revoke || revokeForEveryone)(sender, message);
      handleRevocation({ ...message, _data: { ...message._data, revokeSender: sender.info?.wid } }, message);
    }
  };
  const engine = createCommandEngine(options);
  let panel, rules;
  let active = false, timer, ruleTicking = false;
  const delivered = new Map();
  const messages = new Map();
  const seenJoins = new Set();

  async function route(message) {
    const text = String(message.body || "").trim();
    const ctx = await panel.context(message);
    const parsed = invocation(text, prefix);
    if (!parsed || !engine.get(parsed.name, ctx)) return false;
    if (!text.startsWith(prefix) && !engine.get(parsed.name, ctx)?.name.startsWith("custom:")) return false;
    await panel.executeText(text, ctx); return true;
  }

  const moderation = createModeration({ ...options, registry: engine, handleCommand: route,
    onMessageAutomation: async message => {
      // Keep the last ordinary message available for .rule test.
      if (String(message.body || "").trim().startsWith(`${prefix}rule test `)) return false;
      const chat = await message.getChat();
      const person = await engine.permissions.participant(chat, message.author || message.from);
      if (!person) throw publicError("Message sender identity could not be verified.");
      const event = { groupId: message.from, trigger: "message", target: person.id._serialized, message, chat };
      const results = await rules.emit(event);
      return results.some(result => ["delete", "warn", "remove", "ban", "massdelete"].includes(result.command) && result.ok);
    }
  });
  const automations = createAutomations({ client, store: storage, prefix, logger, now, registry: engine, isAdmin: async () => true });
  const activity = engine.get("activity");
  engine.register({ ...activity, minimumRole: "admin", control: true, parseArgs: raw,
    run: ctx => activity.run({ ...ctx, message: {
      from: ctx.groupId, author: ctx.actor.id, body: `${prefix}activity ${ctx.args.raw || ""}`, fromMe: false,
      getChat: async () => ctx.chat, reply: ctx.reply, commandContext: { throwErrors: true }
    } })
  });
  const showAgenda = engine.get("agenda");
  engine.register({ ...showAgenda,
    run: async ctx => {
      const group = storage.get(ctx.groupId), clock = localClock(now(), group.timezone);
      const scheduled = ctx.actor.type !== "user" && ctx.args.date;
      if (scheduled && ctx.args.date !== clock.date) throw publicError("That agenda date has passed. The old proposal will not send a different day's agenda.");
      if (scheduled && (group.lastAnnouncementDate === clock.date || delivered.get(ctx.groupId) === clock.date)) return { alreadySent: true };
      await ctx.reply(scheduled ? agenda(group, clock) : selectedAgenda(group, clock, ctx.args.raw, prefix));
      if (scheduled) {
        delivered.set(ctx.groupId, clock.date);
        storage.update(ctx.groupId, current => { current.lastAnnouncementDate = clock.date; });
      }
    }
  });
  const core = installCoreCommands(engine, options);
  const contentFilter = installContentFilter(engine, { ...options, classifier: contentClassifier, isActive: () => active });
  panel = installControlPanel(engine, options);
  installAuditCommands(engine, options, core);
  installRecoveryCommands(engine, options);
  const recovery = installAutoRecovery(engine, { ...options, isActive: () => active, allowsContentRepost: contentFilter.allowsRepost });
  rules = createRulesEngine(engine, options);
  for (const [, group] of storage.entries()) rules.validateRules(group.rules);
  engine.afterRun = async (_entry, ctx, outcome) => {
    if (outcome.result?.event) await rules.emit({ groupId: ctx.groupId, chat: ctx.chat, target: ctx.target, trigger: outcome.result.event, count: outcome.result.count }, ctx);
    if (Number.isInteger(outcome.result?.linkCount)) await rules.emit({ groupId: ctx.groupId, chat: ctx.chat, target: ctx.target, trigger: "link_warning_count_reached", count: outcome.result.linkCount }, ctx);
  };

  async function processMessage(message) {
    if (message?.fromMe) return;
    try {
      if (message.from?.endsWith("@g.us")) await moderation.handleMessage(message);
      else if (!(await route(message)) && String(message.body || "").trim().startsWith(prefix)) await message.reply(`Use ${prefix}groups, then ${prefix}use GROUP_ID for private control.`);
    } catch (error) { logger.error("[CONTROL] message failed:", error); }
  }

  function handleMessage(message) {
    if (message?.fromMe) return Promise.resolve();
    const archivedId = capture(message);
    const groupId = message?.from;
    const command = invocation(String(message?.body || ""), prefix)?.name;
    if (!groupId?.endsWith("@g.us") || engine.get(command)?.urgent) return processMessage(message);
    // Keep rapid posts in order: a removal finishes before resolving the next
    // message's membership, while panic/resume can still interrupt the queue.
    const previous = messages.get(groupId) || Promise.resolve();
    const running = previous.catch(() => {}).then(() => processMessage(message)).then(() => {
      // Classify in the background so a slow provider cannot block link
      // moderation or commands. Avoid redisplaying captions that were flagged.
      void contentFilter.schedule(message).then(verdict => {
        if (active && verdict !== "FLAG") recovery.schedule(groupId, archivedId, "viewonce");
      });
    });
    messages.set(groupId, running);
    void running.finally(() => { if (messages.get(groupId) === running) messages.delete(groupId); }).catch(() => {});
    return running;
  }

  function handleUnavailableViewOnce(message) {
    if (message?.fromMe || !message?.from?.endsWith("@g.us") || !unavailableViewOnce(message)) return;
    const id = capture(message);
    if (!id) return;
    logger.warn("[RECOVERY] WhatsApp withheld a view-once file from this linked Web device (view_once_unavailable_fanout).");
    recovery.schedule(message.from, id, "viewonce");
  }

  async function processNotification(trigger, notification) {
    try {
      if (!active || !notification.chatId?.endsWith("@g.us")) return;
      const chat = await notification.getChat();
      if (!active || !chat?.isGroup) return;
      const recipients = [...new Set(notification.recipientIds || [])];
      for (const recipient of recipients) {
        let target = recipient;
        const person = await engine.permissions.participant(chat, recipient);
        if (person) target = person.id._serialized;
        const botId = client.info?.wid?._serialized;
        if (trigger === "member_joined" && botId && (await engine.permissions.identities(botId)).has(target)) continue;
        const key = notification.id?._serialized;
        if (trigger === "member_joined") {
          const joinKey = `${notification.chatId}:${key || notification.id?.$1 || Math.floor(now().valueOf() / 60000)}:${target}`;
          if (seenJoins.has(joinKey)) continue;
          seenJoins.add(joinKey); if (seenJoins.size > 1000) seenJoins.delete(seenJoins.values().next().value);
          const identities = await engine.permissions.identities(target); identities.add(target);
          storage.update(notification.chatId, group => resetLinkCycle(group, identities));
        }
        const single = { chatId: notification.chatId, id: key ? { _serialized: `${key}:${target}` } : {}, recipientIds: [target], getChat: async () => chat };
        const event = { groupId: notification.chatId, chat, target, notification: single, trigger };
        if (trigger === "member_joined") await rules.memberJoined(event); else await rules.emit(event);
        if (trigger === "admin_changed" && notification.type === "promote") {
          const botId = client.info?.wid?._serialized;
          if (botId && (await engine.permissions.identities(botId)).has(target)) await rules.emit({ ...event, trigger: "bot_became_admin" });
        }
      }
    } catch (error) { logger.error(`[CONTROL] ${trigger} failed:`, error); }
  }

  function notification(trigger, event) {
    const groupId = event.chatId;
    const previous = messages.get(groupId) || Promise.resolve();
    const running = previous.catch(() => {}).then(() => processNotification(trigger, event));
    messages.set(groupId, running);
    void running.finally(() => { if (messages.get(groupId) === running) messages.delete(groupId); }).catch(() => {});
    return running;
  }

  async function ruleTick() {
    if (!active || ruleTicking) return;
    ruleTicking = true;
    try {
      try { archive.sweep(); } catch (error) { logger.error("[ARCHIVE] cleanup failed:", error); }
      await rules.tick();
    } catch (error) { logger.error("[RULE] scheduler failed:", error); } finally { ruleTicking = false; }
  }
  function start() {
    if (active) return;
    active = true; automations.start();
    timer = setInterval(() => void ruleTick(), 60000); timer.unref();
    void ruleTick();
  }
  function stop() { active = false; automations.stop(); clearInterval(timer); }
  async function tick() { if (!active) return; await automations.tick(); await ruleTick(); }
  return { engine, panel, rules, archive, recovery, contentFilter, handleMessage, handleUnavailableViewOnce, handleRevocation, notification, start, stop, tick };
}

module.exports = { createController };
