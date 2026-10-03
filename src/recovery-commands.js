const { publicError } = require("./permissions");
const { raw } = require("./core-commands");
const { messageId } = require("./message-archive");
const { recoveryAttribution } = require("./recovery-attribution");

function installRecoveryCommands(engine, { archive, prefix = ".", makeMedia = media => {
  const { MessageMedia } = require("whatsapp-web.js");
  return new MessageMedia(media.mimetype, media.data, media.filename);
} }) {
  const register = definition => engine.register({ requiredRole: "admin", minimumRole: "admin", parseArgs: raw, ...definition });
  const describe = row => `${row.id} | ${new Date(row.sentAt).toISOString()} | ${row.sender} | ${row.viewOnce ? "view once" : row.type}${row.hasMedia ? ` | media: ${row.mediaStatus}` : ""}`;
  async function showList(ctx, filter) {
    const rows = archive.list(ctx.groupId, filter).slice(0, 10);
    await ctx.reply(rows.length ? `${rows.map(describe).join("\n")}\nRetrieve: ${prefix}retrieve ID. Archive expires after 24 hours.` : "No matching messages saved in this group's 24-hour archive.");
  }
  register({ name: "deleted", description: "List recently deleted messages saved for this group", run: ctx => showList(ctx, row => row.deleted) });
  for (const name of ["retrieve", "viewonce"]) register({ name, aliases: name === "retrieve" ? ["restore"] : [],
    description: name === "retrieve" ? "Repost a saved deleted message" : "Retrieve available saved view-once media", effect: true,
    run: async ctx => {
      const token = ctx.args.raw?.trim();
      if (name === "viewonce" && token === "list") return showList(ctx, row => row.viewOnce);
      let row;
      if (token && token !== "last") row = archive.get(ctx.groupId, token);
      else if (ctx.message?.hasQuotedMsg) {
        const quoted = await ctx.message.getQuotedMessage();
        row = archive.get(ctx.groupId, messageId(quoted));
        const remote = quoted.fromMe ? quoted.to : quoted.from;
        if (remote === ctx.groupId && !quoted.fromMe && quoted.type !== "revoked") {
          const id = archive.observe(quoted, { retryMedia: true }); if (id) row = archive.get(ctx.groupId, id);
        }
      } else row = archive.list(ctx.groupId, record => name === "viewonce" ? record.viewOnce : record.deleted)[0];
      if (!row) throw publicError(`No saved message found. Use ${prefix}deleted or ${prefix}viewonce list for IDs. Messages deleted before the bot saved them cannot be recovered.`);
      if (row.hasMedia && !row.media && row.mediaStatus !== "downloading" && ctx.client?.getMessageById) {
        try {
          const original = await ctx.client.getMessageById(row.sourceId);
          if (original?.from === ctx.groupId && !original.fromMe && original.type !== "revoked") {
            archive.observe(original, { retryMedia: true });
            row = archive.get(ctx.groupId, row.id) || row;
          }
        } catch { /* The archived copy remains usable if WhatsApp no longer has the message. */ }
      }
      if (name === "viewonce" && !row.viewOnce) throw publicError(`That is not a view-once message. Use ${prefix}retrieve ${row.id}.`);
      await archive.waitFor(row.id);
      row = archive.get(ctx.groupId, row.id);
      if (!row) throw publicError("That saved message has expired or was evicted from the archive.");
      if (!row.body && !row.media) throw publicError(row.viewOnce
        ? "WhatsApp did not make this view-once media available to the bot, so it cannot be retrieved. Ask the sender to resend it as normal media."
        : "The original content was not saved or its media was unavailable, so this deleted message cannot be recovered.");
      const attribution = await recoveryAttribution(ctx.client, row, name === "viewonce" || !row.deleted ? "viewonce" : "deleted");
      await ctx.reply(`📥 Saved copy\n${attribution.text}\n${row.body || `[${row.type}]`}${row.hasMedia && !row.media ? `\nMedia unavailable: ${row.mediaStatus}.` : ""}`);
      if (row.media) await ctx.reply(makeMedia(row.media));
      return { archivedId: row.id };
    }
  });
}

module.exports = { installRecoveryCommands };
