// db.js
// Handles all persistent storage: warning counts per user, per group.
// Uses better-sqlite3 (synchronous, simple, no need for a separate DB server).

const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = path.join(__dirname, '..', 'data');
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'moderation.db'));

// Make sure the data directory exists and pragma is sane.
db.pragma('journal_mode = WAL');
db.pragma('busy_timeout = 5000'); // wait up to 5s instead of throwing SQLITE_BUSY on write contention

// Table: one row per (group, user) pair, tracking how many warnings they have.
db.exec(`
  CREATE TABLE IF NOT EXISTS warnings (
    group_id      TEXT NOT NULL,
    user_id       TEXT NOT NULL,
    warning_count INTEGER NOT NULL DEFAULT 0,
    last_warned_at TEXT,
    PRIMARY KEY (group_id, user_id)
  )
`);

/**
 * Get the current warning count for a user in a group.
 * Returns 0 if they have no record yet.
 */
function getWarningCount(groupId, userId) {
  const row = db
    .prepare('SELECT warning_count FROM warnings WHERE group_id = ? AND user_id = ?')
    .get(groupId, userId);
  return row ? row.warning_count : 0;
}

/**
 * Increment a user's warning count by 1 and return the new count.
 */
function addWarning(groupId, userId) {
  const now = new Date().toISOString();
  db.prepare(
    `INSERT INTO warnings (group_id, user_id, warning_count, last_warned_at)
     VALUES (?, ?, 1, ?)
     ON CONFLICT(group_id, user_id)
     DO UPDATE SET warning_count = warning_count + 1, last_warned_at = ?`
  ).run(groupId, userId, now, now);

  return getWarningCount(groupId, userId);
}

/**
 * Reset a user's warning count back to 0 (used by admin command).
 */
function resetWarnings(groupId, userId) {
  db.prepare(
    `INSERT INTO warnings (group_id, user_id, warning_count, last_warned_at)
     VALUES (?, ?, 0, NULL)
     ON CONFLICT(group_id, user_id)
     DO UPDATE SET warning_count = 0, last_warned_at = NULL`
  ).run(groupId, userId);
}

module.exports = {
  getWarningCount,
  addWarning,
  resetWarnings,
};
