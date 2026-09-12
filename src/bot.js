const express = require("express");
const qrcode = require("qrcode-terminal");
const { Client, LocalAuth } = require("whatsapp-web.js");

const PORT = Number(process.env.PORT || 8080);
const PREFIX = process.env.PREFIX || ".";

const app = express();
let ready = false;

app.get("/", (_req, res) => res.status(200).send("WhatsApp bot is running"));
app.get("/health", (_req, res) => res.json({ ok: true, ready }));

app.listen(PORT, "0.0.0.0", () => {
  console.log(`[HTTP] listening on ${PORT}`);
});

const client = new Client({
  authStrategy: new LocalAuth({ dataPath: "/app/data/session" }),
  puppeteer: {
    headless: true,
    executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage"
    ]
  }
});

const LINK_RE = /(?:https?:\/\/|www\.)[^\s]+|(?:^|\s)(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?/i;
const strikes = new Map();

function isGroup(message) {
  return typeof message?.from === "string" && message.from.endsWith("@g.us");
}

function senderId(message) {
  return message?.author || message?.from || "";
}

function participantById(chat, id) {
  if (!chat?.participants || !id) return null;
  const bare = id.split("@")[0];
  return chat.participants.find(p =>
    p?.id?._serialized === id || p?.id?.user === bare
  ) || null;
}

function isAdmin(chat, id) {
  const p = participantById(chat, id);
  return !!(p?.isAdmin || p?.isSuperAdmin);
}

async function getChatSafely(message) {
  try {
    const chat = await message.getChat();
    return chat?.isGroup ? chat : null;
  } catch (e) {
    console.warn("[CHAT] unable to resolve group:", e?.message || e);
    return null;
  }
}

async function botIsAdmin(chat) {
  const id = client.info?.wid?._serialized;
  return id ? isAdmin(chat, id) : false;
}

async function warn(message, chat) {
  const id = senderId(message);
  const key = `${message.from}:${id}`;
  const n = (strikes.get(key) || 0) + 1;
  strikes.set(key, n);

  try {
    await chat.sendMessage(
      `⚠️ Warning ${n}: links are not allowed in this group.`
    );
    console.log(`[ANTI-LINK] warning sent (${n})`);
  } catch (e) {
    console.error("[ANTI-LINK] warning failed:", e?.stack || e);
  }
}

async function antiLink(message) {
  if (!isGroup(message)) return false;
  if (!LINK_RE.test(String(message.body || ""))) return false;

  console.log("[ANTI-LINK] link detected");

  const chat = await getChatSafely(message);
  if (!chat) return true;

  const sender = senderId(message);
  if (isAdmin(chat, sender)) {
    console.log("[ANTI-LINK] sender is admin; allowed");
    return true;
  }

  if (!(await botIsAdmin(chat))) {
    console.warn("[ANTI-LINK] bot is not group admin; cannot delete");
    await warn(message, chat);
    return true;
  }

  try {
    await message.delete(true);
    console.log("[ANTI-LINK] message deleted");
  } catch (e) {
    console.error("[ANTI-LINK] deletion failed:", e?.stack || e);
  }

  await warn(message, chat);
  return true;
}

async function deleteQuoted(message) {
  if (!isGroup(message) || message.body.trim() !== `${PREFIX}d`) return false;

  const chat = await getChatSafely(message);
  if (!chat) return true;

  if (!isAdmin(chat, senderId(message))) {
    await message.reply("❌ Admins only.");
    return true;
  }

  if (!message.hasQuotedMsg) {
    await message.reply(`Reply to a message with ${PREFIX}d.`);
    return true;
  }

  try {
    const quoted = await message.getQuotedMessage();
    await quoted.delete(true);
    await message.delete(true);
  } catch (e) {
    console.error("[.d] failed:", e?.stack || e);
    await message.reply("❌ Could not delete that message.");
  }
  return true;
}

async function removeQuoted(message) {
  if (!isGroup(message) || message.body.trim() !== `${PREFIX}r`) return false;

  const chat = await getChatSafely(message);
  if (!chat) return true;

  if (!isAdmin(chat, senderId(message))) {
    await message.reply("❌ Admins only.");
    return true;
  }

  if (!message.hasQuotedMsg) {
    await message.reply(`Reply to a member's message with ${PREFIX}r.`);
    return true;
  }

  try {
    if (!(await botIsAdmin(chat))) {
      await message.reply("❌ The bot must be a group admin.");
      return true;
    }

    const quoted = await message.getQuotedMessage();
    const target = senderId(quoted);

    if (!target || !target.endsWith("@c.us")) {
      await message.reply("❌ That member could not be safely resolved.");
      return true;
    }

    await chat.removeParticipants([target]);
    await message.reply("✅ Removal requested.");
  } catch (e) {
    console.error("[.r] failed:", e?.stack || e);
    await message.reply("❌ Could not remove that member.");
  }
  return true;
}

client.on("qr", qr => {
  console.log("[WHATSAPP] QR received");
  qrcode.generate(qr, { small: true });
});

client.on("authenticated", () => console.log("[WHATSAPP] authenticated"));

client.on("ready", () => {
  ready = true;
  console.log("[WHATSAPP] Bot is ready and connected.");
});

client.on("auth_failure", msg => console.error("[WHATSAPP] auth failure:", msg));
client.on("disconnected", reason => {
  ready = false;
  console.warn("[WHATSAPP] disconnected:", reason);
});
client.on("loading_screen", (p, m) => console.log(`[WHATSAPP] loading ${p}% - ${m}`));

client.on("message", async message => {
  try {
    console.log(`[MESSAGE] ${message.from}: ${String(message.body || "").slice(0, 160)}`);

    // Anti-link is evaluated without a global getChatById/getChat prerequisite.
    if (await antiLink(message)) return;
    if (await deleteQuoted(message)) return;
    if (await removeQuoted(message)) return;

    if (message.body.trim() === `${PREFIX}ping`) {
      await message.reply("pong");
    }
  } catch (e) {
    console.error("========== MESSAGE ERROR ==========");
    console.error(e?.stack || e);
    console.error("==================================");
  }
});

client.initialize().catch(e => {
  console.error("========== INITIALIZATION ERROR ==========");
  console.error(e?.stack || e);
  console.error("==========================================");
});
