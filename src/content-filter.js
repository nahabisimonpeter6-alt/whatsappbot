const { createHash } = require("node:crypto");
const { publicError } = require("./permissions");
const { raw } = require("./core-commands");

function installContentFilter(engine, { client, storage, archive, classifier, logger = console, prefix = ".", isActive }) {
  const jobs = new Set(), seen = new Map();
  function enabled(groupId) {
    const group = storage.get(groupId);
    return isActive() && group.contentModeration && group.autopilot && !group.paused && !engine.auditPaused.has(groupId) && classifier.status().configured;
  }
  async function review(groupId, text, sender, chat) {
    if (!enabled(groupId) || !String(text || "").trim()) return "OK";
    if (await engine.permissions.protectedTarget(chat, groupId, sender)) return "OK";
    return await classifier.classify(text) === "FLAG" ? "FLAG" : "OK";
  }
  function schedule(message) {
    if (!message?.from?.endsWith("@g.us") || message.fromMe || !enabled(message.from)) return Promise.resolve("OK");
    const sourceId = message.id?._serialized || message.id?.$1;
    const text = String(message.body || "");
    if (!sourceId || !text.trim() || archive.get(message.from, sourceId)?.moderated) return Promise.resolve("OK");
    const digest = createHash("sha256").update(text).digest("hex");
    const key = `${message.from}:${sourceId}:${digest}`;
    const previous = seen.get(key);
    if (previous && previous.until > Date.now()) return previous.job;
    const job = (async () => {
      const chat = await message.getChat();
      const verdict = await review(message.from, text, message.author || message.from, chat);
      if (verdict !== "FLAG") return "OK";
      if (enabled(message.from) && !archive.get(message.from, sourceId)?.deleted) {
        await engine.executeCommand("delete", { groupId: message.from, actor: { type: "system", id: "content-filter" },
          args: { contentFilter: true, expectedBodyHash: digest }, targetMessage: message, message, chat, reply: () => {} });
      }
      return "FLAG";
    })().catch(() => { logger.warn("[CONTENT] Moderation could not be verified; keeping the message."); return "OK"; });
    jobs.add(job); seen.set(key, { job, until: Date.now() + 120000 });
    if (seen.size > 1000) seen.delete(seen.keys().next().value);
    void job.finally(() => jobs.delete(job));
    return job;
  }
  async function allowsRepost(row, chat) {
    if (!enabled(row.groupId)) return true;
    try {
      return await review(row.groupId, row.body, row.sender, chat || await client.getChatById(row.groupId)) !== "FLAG";
    } catch { return true; }
  }

  engine.register({ name: "filter", description: "Configure or test FLAG/OK content moderation", requiredRole: "admin", minimumRole: "admin", control: true, parseArgs: raw,
    run: async ctx => {
      const value = ctx.args.raw?.trim() || "status";
      const test = /^test\s+([\s\S]+)$/.exec(value);
      if (test) {
        if (!classifier.status().configured) throw publicError("Set OPENAI_API_KEY in the bot's environment and restart before testing the content filter.");
        return ctx.reply(await classifier.classify(test[1]) === "FLAG" ? "FLAG" : "OK");
      }
      if (!["on", "off", "status"].includes(value)) throw publicError(`Use ${prefix}filter on|off|status or ${prefix}filter test MESSAGE.`);
      if (value === "on" && !classifier.status().configured) throw publicError(`Set OPENAI_API_KEY in Railway Variables (or the local bot environment), restart, then use ${prefix}filter on.`);
      if (value !== "status") storage.update(ctx.groupId, group => { group.contentModeration = value === "on"; });
      const group = storage.get(ctx.groupId), status = classifier.status();
      await ctx.reply(`Content filter: ${group.contentModeration ? "on" : "off"}\nClassifier: ${status.configured ? status.model : "not configured; set OPENAI_API_KEY and restart"}\nLast classifier error: ${status.lastError || "none"}\nOnly FLAG requests deletion; uncertain or failed checks keep the message.\nAdmins, owners, moderators and whitelisted members are protected. Panic, approval, dry-run and deletion limits apply. Enabled groups send message text and media captions to OpenAI; files and chat history are excluded.`);
    }
  });
  return { schedule, allowsRepost, drain: async () => { while (jobs.size) await Promise.all([...jobs]); } };
}

module.exports = { installContentFilter };
