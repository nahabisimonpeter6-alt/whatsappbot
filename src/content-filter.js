const { createHash } = require("node:crypto");
const { publicError } = require("./permissions");
const { raw } = require("./core-commands");

function installContentFilter(engine, { client, storage, archive, classifier, logger = console, prefix = ".", isActive, now = () => new Date() }) {
  const jobs = new Set(), seen = new Map();
  const recent = new Map();
  function record(groupId, decision) { recent.set(groupId, { ...decision, at: new Date().toISOString() }); }
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
        const outcome = await engine.executeCommand("delete", { groupId: message.from, actor: { type: "system", id: "content-filter" },
          args: { contentFilter: true, expectedBodyHash: digest }, targetMessage: message, message, chat, reply: () => {} });
        record(message.from, { verdict, action: outcome.status, error: outcome.error || null });
        if (outcome.status !== "success") logger.warn(`[CONTENT] FLAG deletion ${outcome.status}: ${outcome.error || "review filter status"}`);
      } else {
        record(message.from, { verdict, action: "skipped", error: "Filtering was stopped or the message was already deleted." });
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
        if (!classifier.status().configured) throw publicError("The content classifier is unavailable. Check the bot's configuration and restart.");
        return ctx.reply(await classifier.classify(test[1]) === "FLAG" ? "FLAG" : "OK");
      }
      if (!["on", "off", "status"].includes(value)) throw publicError(`Use ${prefix}filter on|off|status or ${prefix}filter test MESSAGE.`);
      if (value === "on" && !classifier.status().configured) throw publicError("The content classifier is unavailable. Check the bot's configuration and restart.");
      if (value !== "status") storage.update(ctx.groupId, group => { group.contentModeration = value === "on"; });
      const group = storage.get(ctx.groupId), status = classifier.status();
      const blockers = [];
      if (!group.contentModeration) blockers.push(`Filtering is off: use ${prefix}filter on.`);
      if (!group.autopilot) blockers.push(`Autopilot is off: use ${prefix}set autopilot on.`);
      if (group.paused || engine.auditPaused.has(ctx.groupId)) blockers.push(`Automation is paused: review ${prefix}audit, then ${prefix}resume.`);
      if (group.dryRun) blockers.push(`Dry-run is on: use ${prefix}set dryrun off for real deletion.`);
      if (group.approval !== "off") blockers.push(`Automatic deletions need approval: use ${prefix}yes ID, or ${prefix}set approval off for immediate deletion.`);
      if (group.disabledCommands.includes("delete")) blockers.push(`Deletion is disabled: use ${prefix}cmd enable delete.`);
      try { if (!(await engine.permissions.botAdmin(ctx.chat))) blockers.push("Make the linked bot account a group admin."); }
      catch { blockers.push("Could not verify the bot's admin permission."); }
      const used = group.destructiveActions.filter(row => now().valueOf() - row.at < 3600000).reduce((sum, row) => sum + row.units, 0);
      if (used >= group.destructiveCap) blockers.push("The hourly deletion/removal limit has been reached.");
      if (!status.configured) blockers.push("The content classifier is unavailable.");
      const last = recent.get(ctx.groupId);
      const mode = status.mode === "local" ? "Local checks: clear English profanity/insults and direct threats; ambiguous cases stay. Configure OPENAI_API_KEY and restart for the full language-aware policy. Local checks send no text to OpenAI." : "Enabled groups send message text and media captions to OpenAI; files and chat history are excluded.";
      await ctx.reply(`Content filter: ${group.contentModeration ? "on" : "off"}\nClassifier: ${status.configured ? status.model : "unavailable"}\nLast classifier error: ${status.lastError || "none"}\nLast flagged action: ${last ? `${last.action}${last.error ? `: ${last.error}` : ""}` : "none since restart"}\n${blockers.length ? `Deletion blockers:\n${blockers.join("\n")}` : "Ready to delete flagged non-admin messages."}\nOnly FLAG requests deletion; uncertain or failed checks keep the message.\nAdmins, owners, moderators and whitelisted members are protected. Test from another non-admin account.\n${mode}`);
    }
  });
  return { schedule, allowsRepost, drain: async () => { while (jobs.size) await Promise.all([...jobs]); } };
}

module.exports = { installContentFilter };
