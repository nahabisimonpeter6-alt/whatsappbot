const path = require("node:path");
const express = require("express");
const qrcode = require("qrcode-terminal");
const { createController } = require("./controller");
const { createAutomationStore } = require("./automation-store");
const { createMessageArchive } = require("./message-archive");
const { recoverMissedAuthSync } = require("./whatsapp-compat");
const { downloadAvailableMedia } = require("./media");

function createRuntime({ client, port = 8080, prefix = ".", logger = console, onExit = code => process.exit(code), shutdownTimeoutMs = 5000, startupTimeoutMs = 300000, browserCheckIntervalMs = 1000, automationStore = createAutomationStore(), now = () => new Date(), ownerNumbers, revoke, archive, makeMedia }) {
  const app = express();
  const controller = createController({ client, storage: automationStore, prefix, logger, now, ownerNumbers, revoke, archive, makeMedia });
  let ready = false;
  let authenticated = false;
  let stopping = false;
  let stopPromise;
  let startupTimer;
  const watched = new WeakSet();

  function browserAvailable() {
    return client.pupBrowser?.connected !== false && !client.pupPage?.isClosed?.();
  }

  function monitorBrowser() {
    if (stopping) return;
    const browser = client.pupBrowser, page = client.pupPage;
    if (browser?.on && !watched.has(browser)) {
      watched.add(browser);
      browser.on("disconnected", () => fail("[WHATSAPP] browser disconnected:", new Error("Chromium connection was lost.")));
    }
    if (page?.on && !watched.has(page)) {
      watched.add(page);
      page.on("close", () => fail("[WHATSAPP] browser page closed:", new Error("WhatsApp Web page closed.")));
      page.on("error", error => fail("[WHATSAPP] browser page crashed:", error));
    }
    // Also catch a browser that died before its listeners could be attached.
    if (!browserAvailable()) fail("[WHATSAPP] browser unavailable:", new Error("WhatsApp Web browser is no longer running."));
  }
  const browserTimer = setInterval(monitorBrowser, browserCheckIntervalMs);
  browserTimer.unref();

  function armStartupWatchdog() {
    if (startupTimer || ready || stopping) return;
    startupTimer = setTimeout(() => {
      startupTimer = undefined;
      if (!ready && !stopping) fail("[WHATSAPP] startup timed out:", new Error(`WhatsApp did not become ready within ${startupTimeoutMs} ms. Restarting is required.`));
    }, startupTimeoutMs);
    startupTimer.unref();
  }

  function clearStartupWatchdog() { clearTimeout(startupTimer); startupTimer = undefined; }

  app.get("/", (_req, res) => res.status(200).send("WhatsApp bot service"));
  app.get("/live", (_req, res) => res.status(stopping ? 503 : 200).json({ ok: !stopping }));
  app.get("/health", (_req, res) => {
    const ok = ready && !stopping && browserAvailable();
    res.status(ok ? 200 : 503).json({ ok, ready: ok });
  });

  const server = app.listen(port, "0.0.0.0", () => logger.log(`[HTTP] listening on ${server.address().port}`));

  function stop(code = 0) {
    if (stopPromise) return stopPromise;
    stopping = true;
    ready = false;
    clearStartupWatchdog();
    clearInterval(browserTimer);
    controller.stop();
    stopPromise = (async () => {
      const watchdog = setTimeout(() => onExit(code), shutdownTimeoutMs);
      try {
        server.closeAllConnections();
        const closed = new Promise(resolve => server.close(resolve));
        await Promise.all([closed, client.destroy()]);
      } catch (error) {
        logger.error("[SHUTDOWN] cleanup failed:", error);
      } finally {
        clearTimeout(watchdog);
        onExit(code);
      }
    })();
    return stopPromise;
  }

  function fail(label, error) {
    if (stopping) return;
    logger.error(label, error);
    void stop(1);
  }

  server.on("error", error => fail("[HTTP] failed:", error));
  client.on("qr", qr => {
    monitorBrowser();
    if (stopping) return;
    // Initial pairing needs a human to scan the QR; allow them time to do so.
    clearStartupWatchdog();
    logger.log("[WHATSAPP] Scan this QR from WhatsApp > Linked devices.");
    qrcode.generate(qr, { small: true });
  });
  client.on("authenticated", () => {
    if (stopping) return;
    authenticated = true;
    armStartupWatchdog();
    logger.log("[WHATSAPP] authenticated");
  });
  client.on("ready", () => {
    monitorBrowser();
    if (stopping) return;
    ready = true;
    clearStartupWatchdog();
    controller.start();
    logger.log("[WHATSAPP] Bot is ready and connected.");
  });
  client.on("auth_failure", error => fail("[WHATSAPP] authentication failed:", error));
  client.on("disconnected", reason => fail("[WHATSAPP] disconnected:", reason));
  client.on("loading_screen", (percent, message) => logger.log(`[WHATSAPP] loading ${percent}% - ${message}`));
  client.on("message", message => {
    if (ready && !stopping) void controller.handleMessage(message);
  });
  // WhatsApp sends withheld view-once media through this event, never through
  // "message". Such a placeholder contains no downloadable file or key.
  client.on("message_ciphertext", message => {
    if (ready && !stopping) controller.handleUnavailableViewOnce(message);
  });
  client.on("message_revoke_everyone", (message, original) => {
    if (ready && !stopping) controller.handleRevocation(message, original);
  });

  client.on("group_join", notification => {
    if (ready && !stopping) void controller.notification("member_joined", notification);
  });

  client.on("group_leave", notification => {
    if (ready && !stopping) void controller.notification("member_left", notification);
  });
  client.on("group_admin_changed", notification => {
    if (ready && !stopping) void controller.notification("admin_changed", notification);
  });

  // Defer startup so synchronous initialization errors also reach fail().
  const initialization = Promise.resolve().then(async () => {
    if (stopping) return;
    armStartupWatchdog();
    await client.initialize();
    monitorBrowser();
    if (!stopping && !ready) await recoverMissedAuthSync(client, () => authenticated);
  }).catch(error => {
    fail("[WHATSAPP] initialization failed:", error);
    return stopPromise;
  });

  return { server, stop, initialization, controller };
}

function startBot() {
  require("./whatsapp-compat").installWhatsAppCompatibility();
  const { Client, LocalAuth } = require("whatsapp-web.js");
  const port = Number(process.env.PORT || 8080);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("PORT must be between 1 and 65535.");
  const startupTimeoutMs = Number(process.env.WHATSAPP_STARTUP_TIMEOUT_MS || 300000);
  if (!Number.isInteger(startupTimeoutMs) || startupTimeoutMs < 1000 || startupTimeoutMs > 3600000) throw new Error("WHATSAPP_STARTUP_TIMEOUT_MS must be between 1000 and 3600000.");
  const sessionPath = process.env.SESSION_PATH || path.join(__dirname, "..", "data", "session");
  const automationStore = createAutomationStore(process.env.AUTOMATION_STATE_PATH || path.join(sessionPath, "automations.json"));
  const client = new Client({
    authStrategy: new LocalAuth({
      dataPath: sessionPath
    }),
    puppeteer: {
      headless: true,
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage"]
    }
  });
  const archive = createMessageArchive(process.env.MESSAGE_ARCHIVE_PATH || path.join(sessionPath, "message-archive.json"), {
    downloadMedia: (message, limit) => downloadAvailableMedia(client, message, limit)
  });
  const runtime = createRuntime({ client, port, prefix: process.env.PREFIX || ".", startupTimeoutMs, automationStore, archive });
  process.once("SIGTERM", () => void runtime.stop(0));
  process.once("SIGINT", () => void runtime.stop(0));
  return runtime;
}

if (require.main === module) {
  try {
    startBot();
  } catch (error) {
    console.error("[STARTUP] failed:", error);
    process.exitCode = 1;
  }
}

module.exports = { createRuntime, startBot };
