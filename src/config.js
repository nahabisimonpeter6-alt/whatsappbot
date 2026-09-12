// config.js
// Per-group settings: a domain whitelist (links that are allowed despite the
// link filter) and a configurable max-warnings threshold. Falls back to
// sensible defaults if a group has no custom config yet.

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'moderation.db'));

const DEFAULT_MAX_WARNINGS = 3;

db.exec(`
  CREATE TABLE IF NOT EXISTS group_settings (
    group_id      TEXT PRIMARY KEY,
    max_warnings  INTEGER NOT NULL DEFAULT ${DEFAULT_MAX_WARNINGS}
  );

  CREATE TABLE IF NOT EXISTS whitelist_domains (
    group_id TEXT NOT NULL,
    domain   TEXT NOT NULL,
    PRIMARY KEY (group_id, domain)
  );
`);

function getMaxWarnings(groupId) {
  const row = db.prepare('SELECT max_warnings FROM group_settings WHERE group_id = ?').get(groupId);
  return row ? row.max_warnings : DEFAULT_MAX_WARNINGS;
}

function setMaxWarnings(groupId, count) {
  db.prepare(
    `INSERT INTO group_settings (group_id, max_warnings) VALUES (?, ?)
     ON CONFLICT(group_id) DO UPDATE SET max_warnings = ?`
  ).run(groupId, count, count);
}

function getWhitelist(groupId) {
  return db
    .prepare('SELECT domain FROM whitelist_domains WHERE group_id = ?')
    .all(groupId)
    .map((r) => r.domain.toLowerCase());
}

function addToWhitelist(groupId, domain) {
  db.prepare('INSERT OR IGNORE INTO whitelist_domains (group_id, domain) VALUES (?, ?)').run(
    groupId,
    domain.toLowerCase()
  );
}

function removeFromWhitelist(groupId, domain) {
  db.prepare('DELETE FROM whitelist_domains WHERE group_id = ? AND domain = ?').run(
    groupId,
    domain.toLowerCase()
  );
}

module.exports = {
  DEFAULT_MAX_WARNINGS,
  getMaxWarnings,
  setMaxWarnings,
  getWhitelist,
  addToWhitelist,
  removeFromWhitelist,
};
