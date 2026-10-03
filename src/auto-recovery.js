const { makeMessageMedia } = require("./media");
const { containsLink } = require("./links");
const { messageId } = require("./message-archive");
const { recoveryAttribution } = require("./recovery-attribution");

function installAutoRecovery(engine, { client, storage, archive, logger = console, isActive, makeMedia = makeMessageMedia, allowsContentRepost = async () => true }) {
  const jobs = new Set();
  const pending = new Set();
  const reschedule = new Set();
  const moderated = new Set();
  const suppressed = row => row.moderated || moderated.has(`${row.groupId}:${row.sourceId}`);
  const complete = (row, kind) => row.reposts?.[kind]?.status === "sent" && !(row.media && !row.reposts[kind].mediaSent);
  engine.register({ name: "repost", description: "Automatically repost a saved deletion or view-once message", requiredRole: "admin", minimumRole: "admin", automationSafe: true, effect: true,
    run: async ctx => {
      const { archiveId, kind } = ctx.args;
      if (!["deleted", "viewonce"].includes(kind)) throw new Error("Invalid repost reason.");
      const row = archive.get(ctx.groupId, archiveId);
      const group = storage.get(ctx.groupId);
      if (!row || suppressed(row) || !group[kind === "deleted" ? "repostDeleted" : "repostViewOnce"]) return { skipped: true };
      if (kind === "deleted" && !row.deleted || kind === "viewonce" && !row.viewOnce) return { skipped: true };
      if (complete(row, kind) || row.reposts?.[kind]?.status === "sending") return { alreadySent: true };
      if (row.reposts?.[kind]?.status === "unavailable" && !row.media) return { alreadyReported: true };
      if (!(await allowsContentRepost(row, ctx.chat))) return { skipped: true };
      if (containsLink(row.body) && group.rules.some(rule => rule.id === "builtin-links" && rule.enabled) &&
        !(await engine.permissions.protectedTarget(ctx.chat, ctx.groupId, row.sender))) return { skipped: true };
      const previous = row.reposts?.[kind] || {};
      archive.patch(ctx.groupId, row.id, current => {
        current.reposts ||= {}; current.reposts[kind] = { ...previous, status: "sending" };
      });
      const title = kind === "deleted" ? row.body || row.media ? "📥 Deleted message recovered" : "📥 Deleted message unavailable" : row.media ? "📷 View-once media redisplayed" : "📷 View-once media unavailable";
      const content = row.body || (row.media ? `[${row.type}]` : row.mediaUnavailableReason || "The original media was not made available to the bot and could not be recovered.");
      try {
        if (!previous.textSent) {
          const attribution = await recoveryAttribution(client, row, kind);
          archive.patch(ctx.groupId, row.id, current => {
            current.senderName = attribution.senderName;
            if (attribution.deletedByName) current.deletedByName = attribution.deletedByName;
          });
          await ctx.chat.sendMessage(`${title}\n${attribution.text}\n${content}${row.hasMedia && !row.media && row.body ? "\nMedia unavailable." : ""}`);
          archive.patch(ctx.groupId, row.id, current => { current.reposts[kind].textSent = true; });
        }
        if (row.media && !previous.mediaSent) {
          await ctx.chat.sendMessage(makeMedia(row.media), { isViewOnce: false });
          archive.patch(ctx.groupId, row.id, current => { current.reposts[kind].mediaSent = true; });
        }
        archive.patch(ctx.groupId, row.id, current => { current.reposts[kind].status = row.hasMedia && !row.media ? "unavailable" : "sent"; });
        return { archivedId: row.id };
      } catch (error) {
        archive.patch(ctx.groupId, row.id, current => { current.reposts[kind].status = "failed"; });
        throw error;
      }
    }
  });

  function schedule(groupId, id, kind) {
    if (!id || !isActive()) return;
    if (kind === "viewonce" && !archive.get(groupId, id)?.viewOnce) return;
    const key = `${groupId}:${id}:${kind}`;
    if (pending.has(key)) { reschedule.add(key); return; }
    pending.add(key);
    const job = (async () => {
      await archive.waitFor(id);
      if (!isActive()) return;
      const row = archive.get(groupId, id), group = storage.get(groupId);
      if (!row || suppressed(row) || kind === "viewonce" && !row.viewOnce || !group.autopilot || group.paused ||
        !group[kind === "deleted" ? "repostDeleted" : "repostViewOnce"] || complete(row, kind)) return;
      if (row.reposts?.[kind]?.status === "unavailable" && !row.media) return;
      if (!(await allowsContentRepost(row))) return;
      await engine.executeCommand("repost", { groupId, actor: { type: "system", id: "automatic-recovery" },
        args: { archiveId: id, kind }, reply: text => client.sendMessage(groupId, text) });
    })().catch(error => logger.error("[RECOVERY] automatic repost failed:", error));
    jobs.add(job);
    void job.finally(() => {
      jobs.delete(job); pending.delete(key);
      if (reschedule.delete(key)) schedule(groupId, id, kind);
    });
  }
  function suppress(message) {
    moderated.add(`${message.from}:${messageId(message)}`);
    if (moderated.size > 2000) moderated.delete(moderated.values().next().value);
    try { archive.suppress(message); } catch (error) { logger.error("[ARCHIVE] moderation marker failed:", error); }
  }
  return { schedule, suppress, drain: async () => { while (jobs.size) await Promise.all([...jobs]); } };
}

module.exports = { installAutoRecovery };
