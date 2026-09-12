// moderation.js
// Automatic moderation: detects links in messages, deletes them, issues
// warnings, removes users after N strikes (configurable per group), and
// flags flooding/spam behavior.

const { addWarning } = require('./db');
const { getMaxWarnings, getWhitelist } = require('./config');
const { checkFlood } = require('./antiflood');
const logger = require('./logger');

// Matches http(s) links and bare www./domain-style links.
const LINK_REGEX = /(https?:\/\/|www\.)[^\s]+/gi;

function extractLinks(text) {
  if (!text) return [];
  return text.match(LINK_REGEX) || [];
}

/**
 * A link only counts as a violation if its domain isn't on the group's
 * whitelist. Lets admins allow e.g. youtube.com or their own website.
 */
function hasNonWhitelistedLink(text, whitelist) {
  const links = extractLinks(text);
  if (links.length === 0) return false;
  if (whitelist.length === 0) return true; // no whitelist = every link is blocked

  return links.some((link) => {
    const domainMatch = link.replace(/^https?:\/\//i, '').replace(/^www\./i, '');
    const domain = domainMatch.split('/')[0].toLowerCase();
    return !whitelist.some((allowed) => domain === allowed || domain.endsWith(`.${allowed}`));
  });
}

/**
 * Check whether the message sender is currently a group admin.
 */
async function isSenderAdmin(chat, senderId) {
  const participant = chat.participants.find((p) => p.id._serialized === senderId);
  const result = !!(participant && (participant.isAdmin || participant.isSuperAdmin));
  logger.info(
    `[admin-check] senderId=${senderId} matchedParticipant=${!!participant} isAdmin=${result} ` +
    `participantIds=${chat.participants.map((p) => p.id._serialized).join(',')}`
  );
  return result;
}

async function warnAndMaybeRemove(chat, senderId, reason) {
  const groupId = chat.id._serialized;
  const maxWarnings = getMaxWarnings(groupId);
  const count = addWarning(groupId, senderId);

  logger.info(`${reason} by ${senderId} in "${chat.name}". Warning ${count}/${maxWarnings}.`);

  if (count < maxWarnings) {
    await chat.sendMessage(
      `⚠️ @${senderId.split('@')[0]} Warning ${count}/${maxWarnings}: ${reason}.`,
      { mentions: [senderId] }
    );
    return;
  }

  try {
    await chat.removeParticipants([senderId]);
    await chat.sendMessage(
      `🚫 @${senderId.split('@')[0]} was removed after reaching ${maxWarnings} warnings (${reason}).`,
      { mentions: [senderId] }
    );
    logger.info(`Removed ${senderId} from "${chat.name}" after ${maxWarnings} warnings.`);
  } catch (err) {
    logger.error(`Failed to remove ${senderId} from "${chat.name}":`, err.message);
  }
}

/**
 * Main entry point called from bot.js for every incoming group message.
 */
async function handleMessage(client, message) {
  const chat = await message.getChat();
  if (!chat.isGroup) return;

  const senderId = message.author || message.from;
  const groupId = chat.id._serialized;

  // Admins are exempt from all automatic moderation.
  if (await isSenderAdmin(chat, senderId)) return;

  // --- Flood check (runs on every message, not just links) ---
  if (checkFlood(groupId, senderId)) {
    await warnAndMaybeRemove(chat, senderId, 'sending messages too quickly (flooding)');
    return; // Don't also run link check on the same message — avoid double warning.
  }

  // --- Link check ---
  const whitelist = getWhitelist(groupId);
  if (!hasNonWhitelistedLink(message.body, whitelist)) return;

  try {
    await message.delete(true); // delete for everyone (requires bot to be admin)
  } catch (err) {
    logger.error('Failed to delete message with link:', err.message);
    return; // Bot likely isn't admin — don't proceed to warn/remove.
  }

  await warnAndMaybeRemove(chat, senderId, "links aren't allowed in this group");
}

module.exports = {
  handleMessage,
  hasNonWhitelistedLink,
  extractLinks,
  isSenderAdmin,
  warnAndMaybeRemove,
};
