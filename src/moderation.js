// moderation.js
// Automatic moderation: detects links in messages, deletes them, issues
// warnings, removes users after N strikes (configurable per group), and
// flags flooding/spam behavior.
//
// IMPORTANT: the core delete+warn path is built to work WITHOUT needing
// message.getChat() or chat.participants at all — message.from already IS
// the group id for group messages, and message.delete()/client.sendMessage()
// operate on raw ids. This matters because whatsapp-web.js has a known,
// currently-unresolved bug where getChat()/chat.participants throws for
// participants using WhatsApp's newer @lid privacy identifiers (GitHub
// #3631, #3582, #5733). Only two things still need a real chat object:
// the admin-exemption check, and chat.removeParticipants() at strike limit.
// Both fail gracefully (skip the check / skip removal, but link deletion
// and warning-tracking still happen) rather than blocking moderation.

const { addWarning } = require('./db');
const { getMaxWarnings, getWhitelist } = require('./config');
const { checkFlood } = require('./antiflood');
const logger = require('./logger');

// Matches http(s) links and bare www./domain-style links.
const LINK_REGEX = /(?:https?:\/\/|www\.)[^\s]+|(?<![@\w])(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:\/[^\s]*)?/gi;

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
 * Extract the numeric/user portion of a WhatsApp ID, ignoring the server
 * suffix (@c.us, @s.whatsapp.net, @lid, etc).
 */
function idUserPart(serializedId) {
  return (serializedId || '').split('@')[0];
}

/**
 * Check whether the message sender is currently a group admin.
 * Returns false (not throws) if chat/participants can't be resolved —
 * callers decide what "unknown" should mean for their situation.
 */
async function isSenderAdmin(chat, senderId) {
  if (!senderId || !chat) return false;

  let participants = chat.participants;

  if (!Array.isArray(participants)) {
    try {
      const fresh = await chat.client.getChatById(chat.id._serialized);
      participants = fresh.participants;
    } catch (err) {
      logger.warn(`isSenderAdmin: couldn't resolve participants for "${chat?.name}" (${err?.message || err}).`);
      return false;
    }
  }

  if (!Array.isArray(participants)) return false;

  let participant = participants.find((p) => p.id && p.id._serialized === senderId);
  if (!participant) {
    const senderUser = idUserPart(senderId);
    participant = participants.find((p) => p.id && idUserPart(p.id._serialized) === senderUser);
  }

  return !!(participant && (participant.isAdmin || participant.isSuperAdmin));
}

/**
 * Records a warning and either sends a warning message or removes the user
 * at the strike limit. Works from raw ids (client + groupId) so it never
 * depends on a resolved chat object for the warn path. `chat` is optional —
 * pass it when available for the removal step; pass null to skip removal
 * gracefully (still records the warning and still messages the group).
 */
async function warnAndMaybeRemove(client, chat, groupId, senderId, reason) {
  const maxWarnings = getMaxWarnings(groupId);
  const count = addWarning(groupId, senderId);

  logger.info(`${reason} by ${senderId} in ${groupId}. Warning ${count}/${maxWarnings}.`);

  if (count < maxWarnings) {
    await client.sendMessage(
      groupId,
      `⚠️ @${senderId.split('@')[0]} Warning ${count}/${maxWarnings}: ${reason}.`,
      { mentions: [senderId] }
    );
    return;
  }

  if (!chat) {
    // Can't remove without a resolved chat object (known @lid limitation).
    // Still tell the group what happened instead of silently doing nothing.
    await client.sendMessage(
      groupId,
      `⚠️ @${senderId.split('@')[0]} reached ${maxWarnings} warnings (${reason}), but removal ` +
      `couldn't be completed automatically. An admin may need to remove them manually.`,
      { mentions: [senderId] }
    );
    logger.warn(`Could not auto-remove ${senderId} from ${groupId} — no resolved chat object available.`);
    return;
  }

  try {
    await chat.removeParticipants([senderId]);
    await client.sendMessage(
      groupId,
      `🚫 @${senderId.split('@')[0]} was removed after reaching ${maxWarnings} warnings (${reason}).`,
      { mentions: [senderId] }
    );
    logger.info(`Removed ${senderId} from ${groupId} after ${maxWarnings} warnings.`);
  } catch (err) {
    logger.error(`Failed to remove ${senderId} from ${groupId}:`, err.message);
  }
}

/**
 * Main entry point called from bot.js for every incoming group message.
 * Deliberately avoids requiring message.getChat() to succeed for the core
 * delete+warn path — only the admin check and strike-3 removal use it, and
 * both degrade gracefully if it's unavailable.
 */
async function handleMessage(client, message) {
  const senderId = message.author || message.from;
  if (!senderId) return;

  const groupId = message.from; // for group messages, `from` IS the group's own id
  if (!groupId.endsWith('@g.us')) return; // not a group message

  // Best-effort chat resolution — used for admin exemption and removal
  // only. If this fails (known @lid limitation), we deliberately continue
  // moderating rather than skipping the sender entirely.
  let chat = null;
  try {
    chat = await message.getChat();
  } catch (err) {
    logger.warn(`Chat resolution failed for ${senderId} in ${groupId} — continuing without it (${err?.message || err}).`);
  }

  if (chat && (await isSenderAdmin(chat, senderId))) return; // admins exempt when we can verify it

  // --- Flood check (runs on every message, not just links) ---
  if (checkFlood(groupId, senderId)) {
    await warnAndMaybeRemove(client, chat, groupId, senderId, 'sending messages too quickly (flooding)');
    return;
  }

  // --- Link check --- (message.body is always available, no chat needed)
  const whitelist = getWhitelist(groupId);
  if (!hasNonWhitelistedLink(message.body, whitelist)) return;

  let deleted = false;
  try {
    await message.delete(true); // operates on the message itself — no chat object required
    deleted = true;
  } catch (err) {
    logger.error(
      '\n========== LINK DELETE FAILED ==========\n' +
      `Group: ${groupId}\nSender: ${senderId}\nBody: ${(message.body || '').slice(0, 100)}\n` +
      `Error name: ${err?.name || '(unknown)'}\nError message: ${err?.message || String(err)}\nStack: ${err?.stack || '(no stack)'}\n` +
      '========================================='
    );
  }

  // Warning/tracking should not depend on successful deletion. If deletion
  // fails because the bot lacks permission, the user should still receive
  // the configured warning when sending is possible.
  try {
    await warnAndMaybeRemove(
      client,
      chat,
      groupId,
      senderId,
      deleted ? "links aren't allowed in this group" : "links aren't allowed in this group (message could not be deleted)"
    );
  } catch (err) {
    logger.error(`Failed to warn after link violation in ${groupId}: ${err?.stack || err?.message || err}`);
  }
}

module.exports = {
  handleMessage,
  hasNonWhitelistedLink,
  extractLinks,
  isSenderAdmin,
  warnAndMaybeRemove,
};
