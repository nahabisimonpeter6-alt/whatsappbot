// commands.js
// Admin-only text commands, prefixed with "."
//   .d                    (reply to a message)  -> delete that message
//   .r @user                                     -> remove user immediately
//   .warn @user                                  -> manually add one warning
//   .resetwarnings @user                         -> reset a user's warning count to 0
//   .setlimit N                                  -> set max warnings before removal (this group)
//   .whitelist add example.com                   -> allow links to this domain
//   .whitelist remove example.com                -> revoke a whitelisted domain
//   .whitelist list                              -> show current whitelist

const { addWarning, resetWarnings } = require('./db');
const { isSenderAdmin, warnAndMaybeRemove } = require('./moderation');
const {
  getMaxWarnings,
  setMaxWarnings,
  getWhitelist,
  addToWhitelist,
  removeFromWhitelist,
} = require('./config');
const logger = require('./logger');

async function getMentionedUserId(message) {
  const mentions = await message.getMentions();
  return mentions.length > 0 ? mentions[0].id._serialized : null;
}

/**
 * Main entry point called from bot.js for every incoming group message.
 * Returns true if the message was handled as a command.
 */
async function handleCommand(client, message) {
  const body = (message.body || '').trim();
  if (!body.startsWith('.')) return false;

  try {
    const chat = await message.getChat();
    if (!chat.isGroup) return false;

    const senderId = message.author || message.from;
    if (!(await isSenderAdmin(chat, senderId))) return false; // ignore silently for non-admins

    const parts = body.split(/\s+/);
    const command = parts[0].toLowerCase();
    const groupId = chat.id._serialized;

    return await runCommand(command, parts, chat, senderId, groupId, message);
  } catch (err) {
    logger.error(
      '\n========== COMMAND HANDLER ERROR ==========\n' +
      `Command: ${body.split(/\s+/)[0]}\n` +
      `Message: ${body.slice(0, 100)}\n` +
      `Error name: ${err?.name || '(no name)'}\n` +
      `Error message: ${err?.message || String(err)}\n` +
      `Stack: ${err?.stack || '(no stack)'}\n` +
      '============================================'
    );
    return true; // we recognized it as a command attempt even though it failed — don't fall through to link moderation
  }
}

async function runCommand(command, parts, chat, senderId, groupId, message) {

  switch (command) {
    case '.d': {
      if (!message.hasQuotedMsg) {
        await chat.sendMessage('Reply to the message you want deleted with .d');
        return true;
      }
      const quoted = await message.getQuotedMessage();
      try {
        await quoted.delete(true);
        await message.delete(true).catch(() => {});
        logger.info(`${senderId} deleted a message via .d in "${chat.name}".`);
      } catch (err) {
        logger.error(
          '\n========== .d FAILED ==========\n' +
          `Chat: ${chat?.name}\nSender: ${senderId}\n` +
          `Error name: ${err?.name}\nError message: ${err?.message}\nStack: ${err?.stack}\n` +
          '================================'
        );
      }
      return true;
    }

    case '.r': {
      const targetId = await getMentionedUserId(message);
      if (!targetId) {
        await chat.sendMessage('Tag the user you want to remove: .r @user');
        return true;
      }
      try {
        await chat.removeParticipants([targetId]);
        await chat.sendMessage(`🚫 @${targetId.split('@')[0]} was removed by an admin.`, {
          mentions: [targetId],
        });
        logger.info(`${senderId} removed ${targetId} via .r in "${chat.name}".`);
      } catch (err) {
        logger.error(
          '\n========== .r FAILED ==========\n' +
          `Chat: ${chat?.name}\nSender: ${senderId}\nTarget: ${targetId}\n` +
          `Error name: ${err?.name}\nError message: ${err?.message}\nStack: ${err?.stack}\n` +
          '================================'
        );
      }
      return true;
    }

    case '.warn': {
      const targetId = await getMentionedUserId(message);
      if (!targetId) {
        await chat.sendMessage('Tag the user you want to warn: .warn @user');
        return true;
      }
      await warnAndMaybeRemove(chat, targetId, 'issued a manual warning by an admin');
      return true;
    }

    case '.resetwarnings': {
      const targetId = await getMentionedUserId(message);
      if (!targetId) {
        await chat.sendMessage('Tag the user to reset: .resetwarnings @user');
        return true;
      }
      resetWarnings(groupId, targetId);
      await chat.sendMessage(`✅ Warnings reset for @${targetId.split('@')[0]}.`, { mentions: [targetId] });
      logger.info(`${senderId} reset warnings for ${targetId} in "${chat.name}".`);
      return true;
    }

    case '.setlimit': {
      const n = parseInt(parts[1], 10);
      if (!n || n < 1) {
        await chat.sendMessage(`Usage: .setlimit N (current: ${getMaxWarnings(groupId)})`);
        return true;
      }
      setMaxWarnings(groupId, n);
      await chat.sendMessage(`✅ Max warnings before removal set to ${n} for this group.`);
      logger.info(`${senderId} set max warnings to ${n} in "${chat.name}".`);
      return true;
    }

    case '.whitelist': {
      const sub = (parts[1] || '').toLowerCase();
      const domain = parts[2];

      if (sub === 'add' && domain) {
        addToWhitelist(groupId, domain);
        await chat.sendMessage(`✅ ${domain} added to the link whitelist.`);
      } else if (sub === 'remove' && domain) {
        removeFromWhitelist(groupId, domain);
        await chat.sendMessage(`✅ ${domain} removed from the link whitelist.`);
      } else if (sub === 'list') {
        const list = getWhitelist(groupId);
        await chat.sendMessage(list.length ? `Whitelisted domains:\n${list.join('\n')}` : 'No domains whitelisted.');
      } else {
        await chat.sendMessage('Usage: .whitelist add|remove|list [domain]');
      }
      return true;
    }

    default:
      return false;
  }
}

module.exports = { handleCommand };
