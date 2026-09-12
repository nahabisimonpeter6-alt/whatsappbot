// bot.js
// Main entry point: sets up the WhatsApp client, handles login (QR code),
// auto-reconnects on disconnect, and routes incoming messages.

const { Client, LocalAuth } = require('whatsapp-web.js');
const qrcode = require('qrcode-terminal');
const QRCode = require('qrcode');
const { handleCommand } = require('./commands');
const { handleMessage } = require('./moderation');
const logger = require('./logger');
const qrserver = require('./qrserver');

const RECONNECT_DELAY_MS = 10_000;

function createClient() {
  const client = new Client({
    authStrategy: new LocalAuth({ dataPath: './data/session' }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || undefined,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage', // avoid /dev/shm size limits crashing Chromium in containers
        '--disable-accelerated-2d-canvas',
        '--disable-gpu',
        '--no-zygote',
        '--single-process', // reduces memory footprint at some cost to stability — worth it on small containers
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
      const wasCommand = await handleCommand(client, message);
      if (wasCommand) return;

      await handleMessage(client, message);
    } catch (err) {
      logger.error('Error handling message:', err.message);
    }
  });

  return client;
}

const client = createClient();
qrserver.startServer();
client.initialize();

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
