# WhatsApp Group Moderation Bot

Automatically detects and removes links posted in a WhatsApp group, warns the
sender, and removes them after 3 warnings. Also supports admin-only commands.

## Features

- **Link detection**: any message containing a URL is deleted for everyone,
  unless the domain is on that group's whitelist.
- **Domain whitelist**: allow specific domains per group (e.g. youtube.com)
  so legitimate links don't get caught.
- **Configurable strike limit**: default is 3 warnings before removal, but
  each group can set its own via `.setlimit`.
- **Flood/spam detection**: users sending more than 6 messages in 10 seconds
  are treated as a warning-worthy violation, same 3-strike flow.
- **Admin exemption**: group admins are never warned or removed by automatic
  moderation.
- **Auto-reconnect**: if the WhatsApp Web session drops, the bot retries
  connecting after a short delay instead of staying dead.
- **Graceful shutdown**: on SIGINT/SIGTERM (e.g. redeploys), the client
  disconnects cleanly instead of corrupting session/DB state.
- **File logging**: every action (deletions, warnings, removals, errors) is
  logged to console and to a daily rotating log file in `data/logs/`.
- **Admin commands**:
  - `.d` — reply to a message with this to delete it.
  - `.r @user` — remove a user immediately.
  - `.warn @user` — manually add one warning to a user (auto-removes at limit).
  - `.resetwarnings @user` — reset a user's warning count to 0.
  - `.setlimit N` — set how many warnings this group allows before removal.
  - `.whitelist add|remove|list [domain]` — manage allowed link domains.

## Requirements

- Node.js 18+
- A **spare WhatsApp number** to dedicate to the bot (do not use your main
  personal number — see risk note below).
- That number must be made an **admin** of the target group (the bot cannot
  promote itself).

## Setup

```bash
npm install
npm start
```

On first run, a QR code will print in your terminal. Open WhatsApp on the
bot's phone number → **Settings → Linked Devices → Link a Device** → scan it.

The session is saved to `./data/session`, so you won't need to re-scan on
future restarts unless that folder is deleted or the session expires.

## Making the bot an admin

This is a manual, one-time step you do inside WhatsApp itself:
1. Open the target group.
2. Tap the bot's contact in the member list.
3. Choose "Make group admin."

Without this, message deletion and member removal will silently fail (the
bot will log an error saying the action failed).

## Notes and limitations

- This uses `whatsapp-web.js`, an **unofficial** library that automates the
  WhatsApp Web client. This is against WhatsApp's Terms of Service, and the
  linked number carries some risk of being flagged or banned — hence the
  recommendation to use a spare number, not your primary one.
- The library can break temporarily when WhatsApp updates its web client,
  until the library maintainers patch it. Expect occasional downtime.
- Data (warnings, session) is stored locally in `./data/`. Back this up if
  you care about warning history persisting across server migrations.

## Project structure

```
src/
  bot.js         - Client setup, QR login, reconnect logic, graceful shutdown
  moderation.js  - Link detection, whitelist check, flood check, warn/remove flow
  commands.js    - Admin-only commands (.d, .r, .warn, .resetwarnings, .setlimit, .whitelist)
  config.js      - Per-group settings: max warnings, domain whitelist (SQLite)
  antiflood.js   - In-memory sliding-window spam/flood detection
  db.js          - SQLite storage for per-user warning counts
  logger.js      - Timestamped console + daily rotating file logging
data/            - Created automatically: session, database, logs (gitignored)
```
