// antiflood.js
// Detects users sending messages too quickly (spam/flood) using an in-memory
// sliding window per (group, user). Doesn't need persistence — flood state
// resetting on bot restart is fine, it's a short-term signal.

const WINDOW_MS = 10_000; // 10 second window
const MAX_MESSAGES_IN_WINDOW = 6; // more than 6 messages in 10s = flooding

// Map key: `${groupId}:${userId}` -> array of timestamps (ms)
const messageTimestamps = new Map();

/**
 * Record a message from a user and return true if they're currently flooding.
 */
function checkFlood(groupId, userId) {
  const key = `${groupId}:${userId}`;
  const now = Date.now();

  const timestamps = (messageTimestamps.get(key) || []).filter((t) => now - t < WINDOW_MS);
  timestamps.push(now);
  messageTimestamps.set(key, timestamps);

  return timestamps.length > MAX_MESSAGES_IN_WINDOW;
}

// Periodically clear old entries so the map doesn't grow forever.
setInterval(() => {
  const now = Date.now();
  for (const [key, timestamps] of messageTimestamps.entries()) {
    const fresh = timestamps.filter((t) => now - t < WINDOW_MS);
    if (fresh.length === 0) messageTimestamps.delete(key);
    else messageTimestamps.set(key, fresh);
  }
}, 60_000).unref();

module.exports = { checkFlood };
