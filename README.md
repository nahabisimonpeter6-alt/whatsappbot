# Fresh WhatsApp Bot

This is a clean project created independently of the previous bot code.

## Features

- whatsapp-web.js + LocalAuth
- Railway-friendly HTTP health endpoint
- QR authentication
- Group detection using `@g.us`
- Anti-link detection
- Link deletion when the bot is a group admin
- Warning system independent of deletion success
- `.d` command for deleting a quoted message
- `.r` command for removing a quoted member
- `.ping` test command
- Detailed message/error logging

## Important design

The message event does NOT call `client.getChatById()` before processing every message.

The anti-link system first checks whether the message is a group message from `message.from`. It only attempts to resolve the group chat when moderation actually needs group metadata.

## Railway

Use:

    npm install
    npm start

Set the start command to:

    npm start

A persistent volume is recommended for:

    /app/data/session

The bot must be a group administrator for automatic deletion and member-removal operations.

## First tests

1. Deploy.
2. Authenticate the WhatsApp account.
3. Add the bot as group administrator.
4. Send `hello`.
5. Send `https://example.com`.
6. Reply to a message with `.d`.
7. Reply to a member message with `.r`.

Do not copy old session files into this project. Authenticate this fresh installation separately.
