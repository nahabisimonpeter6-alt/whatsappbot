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
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: SESSION_DATA_PATH }),
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
    try {
      const chat = await message.getChat();
      logger.info(
        `[msg] from=${message.from} author=${message.author || '(none)'} isGroup=${chat.isGroup} body="${(message.body || '').slice(0, 50)}"`
      );

      const wasCommand = await handleCommand(client, message);
      if (wasCommand) return;

      await handleMessage(client, message);
    } catch (err) {
      logger.error('Error handling message:', err.message);
    }
  });

  return client;
}

clearStaleChromiumLocks(SESSION_DATA_PATH);

const client = createClient();
qrserver.startServer();
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
