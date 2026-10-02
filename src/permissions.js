const ROLES = { member: 0, moderator: 1, admin: 2, owner: 3 };
const validUser = id => /^\d+@(c\.us|lid)$/.test(id || "");
function publicError(message) { const error = new Error(message); error.publicMessage = message; return error; }

function createPermissions({ client, storage, ownerNumbers = process.env.OWNER_NUMBERS || "" }) {
  const owners = new Set((Array.isArray(ownerNumbers) ? ownerNumbers : ownerNumbers.split(/[,;\s]+/)).filter(Boolean).map(value => {
    const digits = String(value).replace(/^\+/, "").replace(/@c\.us$/, "");
    if (!/^\d+$/.test(digits)) throw new Error("OWNER_NUMBERS must contain international phone numbers.");
    return `${digits}@c.us`;
  }));

  async function identities(id) {
    if (!validUser(id)) throw publicError("That user's identity could not be verified.");
    const aliases = new Set([id]);
    if (client.getContactLidAndPhone) {
      for (const identity of await client.getContactLidAndPhone([id]) || []) {
        if (validUser(identity.pn)) aliases.add(identity.pn);
        if (validUser(identity.lid)) aliases.add(identity.lid);
      }
    }
    return aliases;
  }

  async function participant(chat, id) {
    if (!validUser(id)) return null;
    const exact = chat?.participants?.find(p => p?.id?._serialized === id);
    if (exact) return exact;
    const aliases = await identities(id);
    return chat?.participants?.find(p => aliases.has(p?.id?._serialized)) || null;
  }

  async function isOwner(id) {
    if (!owners.size) return false;
    if (owners.has(id)) return true;
    return [...await identities(id)].some(alias => owners.has(alias));
  }

  async function role(chat, groupId, id) {
    if (await isOwner(id)) return "owner";
    const person = await participant(chat, id);
    if (!person) throw publicError("That group member's identity could not be verified.");
    if (person.isAdmin || person.isSuperAdmin) return "admin";
    const moderators = storage.get(groupId).moderators || [];
    if (moderators.includes(person.id._serialized) || moderators.includes(id)) return "moderator";
    if (moderators.length && [...await identities(id)].some(alias => moderators.includes(alias))) return "moderator";
    return "member";
  }

  async function protectedTarget(chat, groupId, id) {
    const rank = await role(chat, groupId, id);
    if (rank !== "member") return true;
    const botId = client.info?.wid?._serialized;
    if (!validUser(botId)) throw publicError("The bot's identity could not be verified.");
    const aliases = await identities(id);
    const botAliases = await identities(botId);
    if ([...aliases].some(alias => botAliases.has(alias))) return true;
    return storage.get(groupId).whitelist.some(alias => aliases.has(alias));
  }

  async function botAdmin(chat) {
    const person = await participant(chat, client.info?.wid?._serialized);
    if (!person) throw publicError("The bot's identity could not be verified.");
    return !!(person.isAdmin || person.isSuperAdmin);
  }

  return { identities, participant, role, isOwner, protectedTarget, botAdmin };
}

module.exports = { createPermissions, ROLES, validUser, publicError };
