// logger.js
// Minimal logger: timestamps every line, writes to console AND to a daily
// log file under data/logs/. No external dependencies needed.

const fs = require('fs');
const path = require('path');

const LOG_DIR = path.join(__dirname, '..', 'data', 'logs');
if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

function currentLogFile() {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return path.join(LOG_DIR, `${date}.log`);
}

function writeLine(level, args) {
  const timestamp = new Date().toISOString();
  const message = args
    .map((a) => (typeof a === 'string' ? a : JSON.stringify(a)))
    .join(' ');
  const line = `[${timestamp}] [${level}] ${message}`;

  // Console output (color-free, keeps it simple across platforms).
  if (level === 'ERROR') console.error(line);
  else console.log(line);

  // Append to file, best-effort — if this fails, don't crash the bot over logging.
  fs.appendFile(currentLogFile(), line + '\n', (err) => {
    if (err) console.error('Failed to write log file:', err.message);
  });
}

module.exports = {
  info: (...args) => writeLine('INFO', args),
  warn: (...args) => writeLine('WARN', args),
  error: (...args) => writeLine('ERROR', args),
};
