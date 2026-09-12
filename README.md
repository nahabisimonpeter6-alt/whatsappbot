# Clean WhatsApp Bot for Railway

This project is independently built and does not use the previous bot's source files.

## Railway deployment

Deploy this repository/project with Dockerfile detection enabled.

The Dockerfile installs Chromium and its Linux dependencies, including `libglib2.0-0`.

Use a persistent Railway volume mounted at:

`/app/data/session`

No old WhatsApp session should be copied into the project for the first test.

## Features

- WhatsApp Web authentication
- Persistent LocalAuth session
- Railway health endpoint
- Group anti-link detection
- Link deletion when the bot is a group administrator
- Warning after detection
- `.d` for deleting a quoted message
- `.r` for removing a quoted member
- `.ping` health test

## First test

Make the bot a group administrator, then send:

`hello`

`https://example.com`

Reply to a message with:

`.d`

Reply to a member message with:

`.r`

The bot deliberately avoids calling `client.getChatById()` globally before message processing.
