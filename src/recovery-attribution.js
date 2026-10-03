function cleanName(value) {
  return typeof value === "string" ? value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").replace(/\s+/g, " ").trim().slice(0, 128) : "";
}

function userId(value) {
  const candidate = typeof value === "string" ? value : value?._serialized || (value?.user && value?.server ? `${value.user}@${value.server}` : "");
  return /^\d+@(c\.us|lid)$/.test(candidate) ? candidate : undefined;
}

async function personName(client, id, savedName) {
  const fallback = cleanName(savedName) || (userId(id) ? `@${id.split("@")[0]}` : "Unknown member");
  if (!userId(id) || !client?.getContactById) return fallback;
  let timer;
  const lookup = (async () => {
    async function nameFor(identity) {
      try {
        const contact = await client.getContactById(identity);
        return cleanName(contact?.name) || cleanName(contact?.pushname) || cleanName(contact?.shortName);
      } catch { return ""; }
    }
    const exact = await nameFor(id);
    if (exact) return exact;
    try {
      for (const pair of await client.getContactLidAndPhone?.([id]) || []) {
        for (const alias of [pair.pn, pair.lid]) {
          if (alias === id || !userId(alias)) continue;
          const name = await nameFor(alias);
          if (name) return name;
        }
      }
    } catch { /* Saved names and mentions remain usable when lookup fails. */ }
    return fallback;
  })();
  try {
    return await Promise.race([lookup, new Promise(resolve => { timer = setTimeout(() => resolve(fallback), 2000); })]);
  } finally { clearTimeout(timer); }
}

async function recoveryAttribution(client, row, kind) {
  const senderName = await personName(client, row.sender, row.senderName);
  if (kind !== "deleted") return { text: `From: ${senderName}`, senderName };
  // Message.author identifies the original sender, even for admin deletion.
  // Only the native revokeSender identifies who actually deleted the message.
  const deletedByName = row.deletedBy ? await personName(client, row.deletedBy, row.deletedByName) : "Unknown (WhatsApp did not identify the person who deleted it)";
  return { text: `From: ${deletedByName}\nOriginal sender: ${senderName}`, senderName,
    ...(row.deletedBy ? { deletedByName } : {}) };
}

module.exports = { cleanName, userId, recoveryAttribution };
