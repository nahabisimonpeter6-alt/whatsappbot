const express = require("express");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = Number(process.env.PORT || 8080);
const PREFIX = process.env.COMMAND_PREFIX || ".";

const app = express();
app.get("/", (_req, res) => {
  res.status(200).send("WhatsApp bot is running");
});
app.get("/health", (_req, res) => {
  res.status(200).json({ ok: true, ready: client.info ? true : false });
});
app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] Listening on 0.0.0.0:${PORT}`);
});

const client = new Client({
  authStrategy: new LocalAuth({
    dataPath: process.env.WWEBJS_AUTH_PATH || "./data/session"
  }),
  puppeteer: {
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  }
});

const warnings = new Map();
const links = /(?:https?:\/\/|www\.)[^\s]+|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i;

function isGroupMessage(message) {
  return typeof message?.from === "string" && message.from.endsWith("@g.us");
}

function isLinkMessage(message) {
  return links.test(String(message?.body || ""));
}

function getSenderId(message) {
  return message?.author || message?.from || null;
}

async function getGroupChat(message) {
  // Prefer the chat attached to the received message. Do not call
  // client.getChatById() as a prerequisite for every message.
  try {
    const chat = await message.getChat();
    if (chat && chat.isGroup) return chat;
  } catch (error) {
    console.warn("[CHAT] message.getChat() failed:", error?.message || String(error));
  }
  return null;
}

async function isGroupAdmin(chat, senderId) {
  if (!chat || !Array.isArray(chat.participants) || !senderId) return false;

  const participant = chat.participants.find(
    p => p?.id?._serialized === senderId || p?.id?.user === senderId.split("@")[0]
  );

  return Boolean(participant?.isAdmin || participant?.isSuperAdmin);
}

async function isBotAdmin(chat) {
  if (!chat || !client.info?.wid?._serialized) return false;

  return isGroupAdmin(chat, client.info.wid._serialized);
}

async function warnSender(message, chat, senderId) {
  const key = `${message.from}:${senderId || "unknown"}`;
  const count = (warnings.get(key) || 0) + 1;
  warnings.set(key, count);

  const warningText =
    `⚠️ *Warning ${count}*\n` +
    `Links are not allowed in this group.\n` +
    `Please do not send links again.`;

  try {
    await chat.sendMessage(warningText);
    console.log(`[WARN] Warning ${count} sent in ${message.from}`);
  } catch (error) {
    console.error("[WARN] Failed to send warning:", error?.stack || error);
  }
}

async function moderateLink(message) {
  if (!isGroupMessage(message)) return false;
  if (!isLinkMessage(message)) return false;

  console.log("[ANTI-LINK] Link detected:", message.body);

  const chat = await getGroupChat(message);

  if (!chat) {
    console.warn("[ANTI-LINK] Could not resolve group chat; cannot safely moderate.");
    return true;
  }

  const senderId = getSenderId(message);
  const senderAdmin = await isGroupAdmin(chat, senderId);

  if (senderAdmin) {
    console.log("[ANTI-LINK] Sender is an admin; link allowed.");
    return true;
  }

  const botAdmin = await isBotAdmin(chat);
  if (!botAdmin) {
    console.warn("[ANTI-LINK] Bot is not a group admin; cannot delete messages.");
    await warnSender(message, chat, senderId);
    return true;
  }

  let deleted = false;

  try {
    await message.delete(true);
    deleted = true;
    console.log("[ANTI-LINK] Link message deleted.");
  } catch (error) {
    console.error("[ANTI-LINK] Delete failed:", error?.stack || error);
  }

  // Warning is intentionally independent of deletion success.
  await warnSender(message, chat, senderId);

  return true;
}

async function commandDelete(message) {
  if (!isGroupMessage(message) || message.body.trim() !== `${PREFIX}d`) return false;

  try {
    const chat = await getGroupChat(message);
    if (!chat) return true;

    const senderId = getSenderId(message);
    if (!(await isGroupAdmin(chat, senderId))) {
      await message.reply("❌ Only group admins can use this command.");
      return true;
    }

    if (!message.hasQuotedMsg) {
      await message.reply("Reply to a message with .d to delete it.");
      return true;
    }

    const quoted = await message.getQuotedMessage();
    await quoted.delete(true);
    await message.delete(true);
  } catch (error) {
    console.error("[.d] Error:", error?.stack || error);
    try { await message.reply("❌ I could not delete that message."); } catch {}
  }

  return true;
}

async function commandRemove(message) {
  if (!isGroupMessage(message) || message.body.trim() !== `${PREFIX}r`) return false;

  try {
    const chat = await getGroupChat(message);
    if (!chat) return true;

    const senderId = getSenderId(message);
    if (!(await isGroupAdmin(chat, senderId))) {
      await message.reply("❌ Only group admins can use this command.");
      return true;
    }

    if (!message.hasQuotedMsg) {
      await message.reply("Reply to a member's message with .r to remove them.");
      return true;
    }

    const quoted = await message.getQuotedMessage();
    const targetId = getSenderId(quoted);

    if (!targetId || !targetId.endsWith("@c.us")) {
      await message.reply("❌ I could not safely resolve that member.");
      return true;
    }

    const botAdmin = await isBotAdmin(chat);
    if (!botAdmin) {
      await message.reply("❌ I need group-admin permission to remove members.");
      return true;
    }

    await chat.removeParticipants([targetId]);
    await message.reply("✅ Member removal requested.");
  } catch (error) {
    console.error("[.r] Error:", error?.stack || error);
    try { await message.reply("❌ I could not remove that member."); } catch {}
  }

  return true;
}

async function handleMessage(message) {
  // Moderation is deliberately first for normal messages.
  if (await moderateLink(message)) return;

  if (await commandDelete(message)) return;
  if (await commandRemove(message)) return;

  if (message.body.trim() === `${PREFIX}ping`) {
    await message.reply("pong");
  }
}

client.on("qr", qr => {
  console.log("[WHATSAPP] QR received");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => {
  console.log("[WHATSAPP] Authenticated");
});

client.on("ready", () => {
  console.log("[WHATSAPP] Bot is ready and connected.");
});

client.on("auth_failure", message => {
  console.error("[WHATSAPP] Authentication failure:", message);
});

client.on("disconnected", reason => {
  console.warn("[WHATSAPP] Disconnected:", reason);
});

client.on("change_state", state => {
  console.log("[WHATSAPP] State:", state);
});

client.on("loading_screen", (percent, message) => {
  console.log(`[WHATSAPP] Loading ${percent}% - ${message}`);
});

client.on("message", async message => {
  try {
    console.log(`[MESSAGE] type=${message.type} from=${message.from} body=${String(message.body || "").slice(0, 200)}`);
    await handleMessage(message);
  } catch (error) {
    console.error("========== MESSAGE HANDLER ERROR ==========");
    console.error("name:", error?.name);
    console.error("message:", error?.message);
    console.error("stack:", error?.stack);
    console.error("from:", message?.from);
    console.error("author:", message?.author);
    console.error("body:", message?.body);
    console.error("==========================================");
  }
});

client.initialize().catch(error => {
  console.error("========== INITIALIZATION ERROR ==========");
  console.error(error?.stack || error);
  console.error("==========================================");
});
