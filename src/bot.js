// bot.js
// Main entry point: sets up the WhatsApp client, handles login (QR code),
// auto-reconnects on disconnect, and routes incoming messages.

const fs = require('fs');
const path = require('path');
const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { handleCommand } = require('./commands');
const { handleMessage } = require('./moderation');
const logger = require('./logger');
const qrserver = require('./qrserver');

const RECONNECT_DELAY_MS = 10_000;
const SESSION_DATA_PATH = './data/session';

// Chromium leaves lock files (SingletonLock/SingletonSocket/SingletonCookie)
// in its profile folder while running, to stop two instances sharing one
// profile. On a persistent volume (Railway), a crash or forced restart can
// leave these behind, causing the next launch to fail with
// "profile appears to be in use by another Chromium process" (Code: 21).
// Safe to remove on startup since we know no other instance is running yet.
function clearStaleChromiumLocks(rootDir) {
  const lockNames = new Set(['SingletonLock', 'SingletonSocket', 'SingletonCookie']);
  if (!fs.existsSync(rootDir)) return;

  const stack = [rootDir];
  while (stack.length) {
    const dir = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(fullPath);
      } else if (lockNames.has(entry.name)) {
        try {
          fs.unlinkSync(fullPath);
          logger.info(`Removed stale Chromium lock file: ${fullPath}`);
        } catch (err) {
          logger.warn(`Could not remove lock file ${fullPath}:`, err.message);
        }
      }
    }
  }
}

function createClient() {
  // Optional: pin a specific WhatsApp Web version via webVersionCache, as a
  // lever against the known intermittent whatsapp-web.js "stuck at 99-100%,
  // ready never fires" bug (wwebjs/whatsapp-web.js #5758, #5768, #127084).
  // Off by default — only activates if WWEB_VERSION is set, so it's easy to
  // try and easy to revert without another code change. Note: one report in
  // that same GitHub thread said this specific fix did NOT resolve their
  // case, so treat this as a lever to test, not a guaranteed fix.
  const pinnedVersion = process.env.WWEB_VERSION;
  const webVersionCache = pinnedVersion
    ? {
        type: 'remote',
        remotePath: `https://raw.githubusercontent.com/wppconnect-team/wa-version/main/html/${pinnedVersion}.html`,
      }
    : undefined;

  if (pinnedVersion) {
    logger.info(`Pinning WhatsApp Web version to ${pinnedVersion} (WWEB_VERSION env var set).`);
  }

  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DATA_PATH }),
    ...(webVersionCache ? { webVersionCache } : {}),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // avoid /dev/shm size limits crashing Chromium in containers
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        // NOTE: --single-process and --no-zygote were tried for memory savings
        // but caused the QR handshake with WhatsApp's servers to fail after
        // scanning (page loaded enough to show a QR, but the linking
        // round-trip broke). Removed — stability over memory here.
      ],
    },
  });

  client.on('loading_screen', (percent, message) => {
    logger.info(`[loading_screen] ${percent}% - ${message}`);
  });

  client.on('change_state', (state) => {
    logger.info(`[change_state] ${state}`);
  });

  client.on('qr', (qr) => {
    logger.info('QR code generated — visit the app URL in a browser, or scan the terminal QR below.');
    qrcode.generate(qr, { small: true });
    QRCode.toDataURL(qr, (err, dataUrl) => {
      if (err) {
        logger.error('Failed to generate QR image for status page:', err.message);
        return;
      }
      qrserver.setQr(dataUrl);
    });
  });

  client.on('ready', () => {
    logger.info('Bot is ready and connected.');
    qrserver.setStatus('ready');
  });

  client.on('disconnected', (reason) => {
    logger.warn('Client disconnected:', reason, `— reconnecting in ${RECONNECT_DELAY_MS / 1000}s.`);
    qrserver.setStatus('disconnected');
    setTimeout(() => {
      client.initialize().catch((err) => logger.error('Reconnect attempt failed:', err.message));
    }, RECONNECT_DELAY_MS);
  });

  client.on('auth_failure', (msg) => {
    logger.error('Authentication failure:', msg);
  });

  client.on('message', async (message) => {
    // Do not resolve the chat globally before routing the message.
    // WhatsApp Web can throw while resolving chats/participants for newer
    // @lid sender identities. The moderation handler intentionally uses
    // message.from directly for group detection and must still get a chance
    // to process links even when chat resolution is unavailable.
    try {
      const isGroup = typeof message.from === 'string' && message.from.endsWith('@g.us');

      logger.info(
        `[msg] from=${message.from || '(unknown)'} author=${message.author || '(none)'} isGroup=${isGroup} body="${(message.body || '').slice(0, 50)}"`
      );

      const wasCommand = await handleCommand(client, message);
      if (wasCommand) return;

      await handleMessage(client, message);
    } catch (err) {
      const isLidSender = (message?.author || '').includes('@lid');

      if (isLidSender) {
        // Known, currently-unresolved whatsapp-web.js limitation: messages
        // from participants on WhatsApp's newer @lid privacy identifiers
        // can fail chat/participant resolution deep inside the library
        // (see wwebjs/whatsapp-web.js #3631, #3582, #5733). Not fixable
        // from our side — log concisely instead of a full stack dump on
        // every single message from this sender.
        logger.warn(
          `Skipped message from @lid-addressed sender ${message.author} — ` +
          `known whatsapp-web.js limitation, not an application error (err: ${err?.message || err}).`
        );
        return;
      }

      logger.error(
        '\n========== MESSAGE HANDLER ERROR ==========\n' +
        `Command: ${(message?.body || '').split(/\s+/)[0] || '(none)'}\n` +
        `Message body: ${(message?.body || '').slice(0, 100)}\n` +
        `Message type: ${message?.type || '(unknown)'}\n` +
        `From: ${message?.from || '(unknown)'}\n` +
        `Author: ${message?.author || '(none — not a group msg)'}\n` +
        `Is group: ${typeof message?.from === 'string' && message.from.endsWith('@g.us')}\n` +
        `From me: ${message?.fromMe ?? '(unknown)'}\n` +
        `Error name: ${err?.name || '(no name)'}\n` +
        `Error message: ${err?.message || String(err)}\n` +
        `Stack: ${err?.stack || '(no stack)'}\n` +
        '============================================'
      );
    }
  });

  return client;
}

clearStaleChromiumLocks(SESSION_DATA_PATH);

const client = createClient();
qrserver.startServer();

// Watchdog: if nothing has happened within 90s of boot (no qr, no ready,
// no error), Puppeteer/WhatsApp Web is likely stuck silently — log it
// loudly instead of leaving the page frozen on "starting" with no clue why.
let clientProgressed = false;
['qr', 'ready', 'auth_failure'].forEach((evt) => {
  client.once(evt, () => { clientProgressed = true; });
});
setTimeout(() => {
  if (!clientProgressed) {
    logger.warn(
      'No qr/ready/auth_failure event 90s after startup — client.initialize() appears to be ' +
      'hanging silently (likely stuck launching Chromium or loading WhatsApp Web).'
    );
  }
}, 90_000);

client.initialize().catch((err) => {
  logger.error('Failed to initialize WhatsApp client:', err.message);
  qrserver.setStatus('starting'); // still starting so page keeps showing the real status
});

// Graceful shutdown so the SQLite connection and session files aren't left
// in a bad state if the process is stopped (e.g. by the host platform).
function shutdown(signal) {
  logger.info(`Received ${signal}, shutting down gracefully...`);
  client
    .destroy()
    .catch((err) => logger.error('Error during client shutdown:', err.message))
    .finally(() => process.exit(0));
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('unhandledRejection', (reason) => logger.error('Unhandled rejection:', reason));
