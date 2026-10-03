const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

function systemctl(...args) {
  const result = spawnSync("systemctl", ["--user", ...args], { stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`systemctl ${args.join(" ")} failed. Run this from your Linux desktop login with systemd available.`);
}

// These are systemd unit values, never shell commands. Escape specifiers too.
function quote(value) {
  if (/[\r\n\0]/.test(value)) throw new Error("Service settings cannot contain line breaks or null bytes.");
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/%/g, "%%")}"`;
}

try {
  if (process.platform !== "linux") throw new Error("Local background service installation requires Linux and systemd.");
  const manager = spawnSync("systemctl", ["--user", "show-environment"], { stdio: "ignore" });
  if (manager.error || manager.status !== 0) throw new Error("No systemd user manager is available. Run this from your Linux desktop login.");
  const root = path.resolve(__dirname, "..");
  const directory = path.join(os.homedir(), ".config", "systemd", "user");
  const settings = ["PORT", "PREFIX", "SESSION_PATH", "AUTOMATION_STATE_PATH", "MESSAGE_ARCHIVE_PATH", "PUPPETEER_EXECUTABLE_PATH", "WHATSAPP_STARTUP_TIMEOUT_MS", "OWNER_NUMBERS", "OPENAI_API_KEY", "CONTENT_MODERATION_MODEL", "CONTENT_MODERATION_TIMEOUT_MS"]
    .filter(name => process.env[name] !== undefined)
    .map(name => `Environment=${quote(`${name}=${process.env[name]}`)}`);
  const unit = ["[Unit]", "Description=WhatsApp moderation bot", "StartLimitIntervalSec=0", "", "[Service]", "Type=simple",
    `WorkingDirectory=${root.replace(/\\/g, "\\\\").replace(/%/g, "%%")}`, `ExecStart=${quote(process.execPath)} ${quote(path.join(root, "src", "bot.js"))}`,
    ...settings, "Restart=on-failure", "RestartSec=10", "TimeoutStopSec=10", "UMask=0077", "", "[Install]", "WantedBy=default.target", ""].join("\n");
  fs.mkdirSync(directory, { recursive: true });
  const destination = path.join(directory, "whatsapp-bot.service");
  fs.writeFileSync(destination, unit, { mode: 0o600 });
  fs.chmodSync(destination, 0o600);
  systemctl("daemon-reload");
  systemctl("enable", "whatsapp-bot.service");
  systemctl("restart", "whatsapp-bot.service");
  console.log("Local bot service started. Logs: journalctl --user -u whatsapp-bot.service -f");
  console.log("Keep the PC on and awake. Stop this service before using npm start or pairing a cloud instance.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
