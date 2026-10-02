const fs = require("node:fs");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

const messageId = message => message?.id?._serialized || message?.id?.$1;
const keyId = key => key?._serialized || key?.$1;
const viewOnce = message => !!(message?.isViewOnce || message?._data?.isViewOnce);

function createMessageArchive(filePath, { now = () => new Date(), logger = console,
  retentionMs = 86400000, perGroup = 200, maxBytes = 100 * 1024 * 1024,
  maxMediaBytes = 5 * 1024 * 1024, downloadTimeoutMs = 10000, downloadMedia = message => message.downloadMedia?.() } = {}) {
  let state = { version: 1, messages: [] };
  const pending = new Map();
  const downloading = new Set();
  if (filePath && fs.existsSync(filePath)) {
    state = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (state?.version !== 1 || !Array.isArray(state.messages) || state.messages.some(row =>
      !row || typeof row.id !== "string" || typeof row.sourceId !== "string" ||
      typeof row.groupId !== "string" || !row.groupId.endsWith("@g.us") ||
      !Number.isFinite(row.at) || typeof row.body !== "string" || typeof row.deleted !== "boolean")) {
      throw new Error("Invalid message archive. Restore or move it before starting the bot.");
    }
  }

  function prune(messages) {
    const counts = new Map(); let bytes = Buffer.byteLength('{"version":1,"messages":[]}');
    return messages.filter(row => now().valueOf() - row.at < retentionMs)
      .sort((a, b) => a.at - b.at).reverse().filter(row => {
        const count = counts.get(row.groupId) || 0;
        const size = Buffer.byteLength(JSON.stringify(row)) + 1;
        if (count >= perGroup || bytes + size > maxBytes) return false;
        counts.set(row.groupId, count + 1); bytes += size; return true;
      }).reverse();
  }

  function update(edit) {
    const next = structuredClone(state);
    edit(next.messages);
    next.messages = prune(next.messages);
    if (filePath) {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const temporary = `${filePath}.${randomUUID()}.tmp`;
      try {
        fs.writeFileSync(temporary, JSON.stringify(next), { mode: 0o600 });
        fs.renameSync(temporary, filePath);
      } finally { fs.rmSync(temporary, { force: true }); }
    }
    state = next;
  }

  function sweep() { if (prune(state.messages).length !== state.messages.length) update(() => {}); }
  function list(groupId, filter = () => true) { sweep(); return structuredClone(state.messages.filter(row => row.groupId === groupId && filter(row)).reverse()); }
  function get(groupId, id) {
    sweep();
    const row = state.messages.find(row => row.groupId === groupId && (row.id === id || row.sourceId === id));
    return row ? structuredClone(row) : undefined;
  }

  function download(message, id) {
    if (pending.has(id)) return pending.get(id);
    if (downloading.has(id)) return Promise.resolve();
    // A timeout ends the caller's wait, but the browser download can still be
    // running. Keep its slot occupied until the underlying request settles.
    downloading.add(id);
    const request = Promise.resolve().then(() => downloadMedia(message, maxMediaBytes));
    void request.then(() => downloading.delete(id), () => downloading.delete(id));
    const job = (async () => {
      let timer;
      try {
        const media = await Promise.race([
          request,
          new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("Media download timed out")), downloadTimeoutMs); })
        ]);
        const valid = media && typeof media.data === "string" && typeof media.mimetype === "string" && media.data.length;
        const tooLarge = valid && Buffer.byteLength(media.data, "base64") > maxMediaBytes;
        update(rows => {
          const row = rows.find(row => row.id === id); if (!row) return;
          row.mediaStatus = !valid ? "unavailable" : tooLarge ? "too large (limit 5 MB)" : "saved";
          if (valid && !tooLarge) row.media = { data: media.data, mimetype: media.mimetype, filename: media.filename || null };
        });
      } catch (error) {
        try { update(rows => { const row = rows.find(row => row.id === id); if (row) row.mediaStatus = "unavailable"; }); }
        catch (saveError) { logger.error("[ARCHIVE] media save failed:", saveError); }
        logger.warn("[ARCHIVE] media download failed:", error.message);
      } finally { clearTimeout(timer); pending.delete(id); }
    })();
    pending.set(id, job);
    return job;
  }

  function observe(message, { retryMedia = false } = {}) {
    const sourceId = messageId(message), groupId = message?.from;
    if (!sourceId || !groupId?.endsWith("@g.us") || message.fromMe || message.type === "revoked") return;
    const existing = get(groupId, sourceId);
    if (existing && !retryMedia) return existing.id;
    const isViewOnce = viewOnce(message);
    const hasMedia = !!(message.hasMedia || isViewOnce);
    const size = message._data?.size || message._data?.filesize || 0;
    const downloadable = hasMedia && size <= maxMediaBytes && downloading.size < 4;
    if (existing) {
      if (existing.media || pending.has(existing.id) || downloading.has(existing.id)) return existing.id;
      update(rows => {
        const row = rows.find(row => row.id === existing.id); if (!row) return;
        row.viewOnce ||= isViewOnce; row.hasMedia ||= hasMedia;
        if (row.type === "unknown" && message.type) row.type = message.type;
        // Keep the originally saved body, but enrich an empty deletion record.
        if (!row.body && message.body) row.body = String(message.body).slice(0, 65536);
        if (downloadable) row.mediaStatus = "downloading";
      });
      if (downloadable) void download(message, existing.id);
      return existing.id;
    }
    const id = randomUUID().slice(0, 8);
    update(rows => rows.push({ id, sourceId, groupId, sender: message.author || "unknown", at: now().valueOf(),
      sentAt: Number.isFinite(message.timestamp) ? message.timestamp * 1000 : now().valueOf(),
      body: String(message.body || "").slice(0, 65536), type: message.type || "chat", viewOnce: isViewOnce,
      deleted: false, hasMedia, mediaStatus: !hasMedia ? "none" : downloadable ? "downloading" : size > maxMediaBytes ? "too large (limit 5 MB)" : "unavailable", media: null }));
    if (downloadable) void download(message, id);
    return id;
  }

  function revoked(message, original) {
    const groupId = original?.from || message?.from;
    if (!groupId?.endsWith("@g.us") || original?.fromMe || message?.fromMe) return;
    const sourceId = keyId(message?.protocolMessageKey) || messageId(original) || messageId(message);
    if (!sourceId) return;
    if (original) observe(original, { retryMedia: true });
    update(rows => {
      let row = rows.find(row => row.groupId === groupId && row.sourceId === sourceId);
      if (!row) {
        row = { id: randomUUID().slice(0, 8), sourceId, groupId, sender: original?.author || message?.author || "unknown",
          at: now().valueOf(), sentAt: now().valueOf(), body: "", type: "unknown", viewOnce: false,
          hasMedia: false, media: null, mediaStatus: "unavailable", deleted: true };
        rows.push(row);
      }
      row.deleted = true;
    });
    return get(groupId, sourceId)?.id;
  }

  function patch(groupId, id, edit) {
    update(rows => { const row = rows.find(row => row.groupId === groupId && (row.id === id || row.sourceId === id)); if (row) edit(row); });
  }
  function suppress(message) {
    patch(message.from, messageId(message), row => { row.moderated = true; });
  }

  // Expired data is also removed on startup and during quiet periods.
  if (state.messages.some(row => row.mediaStatus === "downloading")) update(rows => {
    for (const row of rows) if (row.mediaStatus === "downloading") row.mediaStatus = "unavailable";
  });
  sweep();
  return { observe, revoked, list, get, sweep, patch, suppress, waitFor: id => pending.get(id) || Promise.resolve() };
}

module.exports = { createMessageArchive, messageId, viewOnce };
