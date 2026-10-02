function makeMessageMedia(media) {
  const { MessageMedia } = require("whatsapp-web.js");
  return new MessageMedia(media.mimetype, media.data, media.filename);
}

async function downloadInBrowser(id, snapshot, limit) {
  const current = window.require("WAWebCollections").Msg.get(id);
  const source = current || snapshot;
  const fields = {};
  for (const key of ["directPath", "encFilehash", "filehash", "mediaKey", "mediaKeyTimestamp", "type", "mimetype", "filename", "size"]) fields[key] = source[key] ?? snapshot[key];
  if (fields.type === "revoked") fields.type = snapshot.type;
  if (!fields.directPath || !fields.mediaKey || !fields.encFilehash || !fields.filehash || !fields.mimetype || fields.size > limit) return;
  const abort = new AbortController();
  const timer = setTimeout(() => abort.abort(), 10000);
  try {
    // Use only download metadata already delivered to this linked account.
    // Forward mimetype too; recent Web versions require it for uncached media.
    const bytes = await window.require("WAWebDownloadManager").downloadManager.downloadAndMaybeDecrypt({
      ...fields, signal: abort.signal,
      downloadQpl: { addAnnotations() { return this; }, addPoint() { return this; } }
    });
    if (bytes.byteLength > limit) return;
    return { mimetype: fields.mimetype, data: await window.WWebJS.arrayBufferToBase64Async(bytes), filename: fields.filename, filesize: bytes.byteLength };
  } catch (error) { if (error.status === 404) return; throw error; }
  finally { clearTimeout(timer); }
}

async function downloadAvailableMedia(client, message, limit) {
  if (!client?.pupPage) return message.downloadMedia?.();
  const snapshot = {};
  for (const key of ["directPath", "encFilehash", "filehash", "mediaKey", "mediaKeyTimestamp", "type", "mimetype", "filename", "size"]) {
    const value = message._data?.[key];
    if (value !== undefined) snapshot[key] = value;
  }
  const id = message.id?._serialized || message.id?.$1;
  if (!id) return;
  return client.pupPage.evaluate(downloadInBrowser, id, snapshot, limit);
}

module.exports = { makeMessageMedia, downloadAvailableMedia, downloadInBrowser };
