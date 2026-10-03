# WhatsApp moderation bot

A WhatsApp Web bot with welcomes, link moderation, daily activity announcements, private admin control, and event/schedule rules. Commands from people, rules, and schedules use one command engine.

## Local setup

Use Node.js 20 or newer and install Chromium. The default browser path is `/usr/bin/chromium`; set `PUPPETEER_EXECUTABLE_PATH` if your installation is elsewhere.

```sh
PUPPETEER_SKIP_DOWNLOAD=true npm ci
npm test
npm start
```

Scan the terminal QR code using WhatsApp **Linked devices**. Add the bot to your group and make it an administrator. The account must stay paired for moderation to work. Sessions are stored in `data/session` locally and excluded from Git.

On a Linux desktop with systemd, stop any foreground bot first and run `npm run start:local` to install and start a background user service. It starts at login and restarts after failures, including a stopped Chromium browser. Follow logs or scan a pairing QR with `journalctl --user -u whatsapp-bot.service -f`. Use `systemctl --user restart whatsapp-bot`, `systemctl --user stop whatsapp-bot`, or `systemctl --user status whatsapp-bot` to manage it. Closing the terminal leaves the service running; keep the PC powered on and awake. The installer copies any explicitly set bot environment variables into a private service file; supply your custom variables again when reinstalling. Stop this service before running `npm start` or moving the account to cloud hosting.

| Environment variable | Default | Purpose |
| --- | --- | --- |
| `PORT` | `8080` | HTTP listening port |
| `PREFIX` | `.` | Command prefix |
| `SESSION_PATH` | Railway's attached volume mount, otherwise the project's `data/session` folder | Persistent WhatsApp session storage; overrides must stay inside the Railway volume |
| `AUTOMATION_STATE_PATH` | `automations.json` inside `SESSION_PATH` | Saved settings, schedules, warnings, rules, approvals, and audit records |
| `MESSAGE_ARCHIVE_PATH` | `message-archive.json` inside `SESSION_PATH` | Local 24-hour archive for admin message/media recovery |
| `PUPPETEER_EXECUTABLE_PATH` | `/usr/bin/chromium` | Installed browser executable |
| `WHATSAPP_STARTUP_TIMEOUT_MS` | `300000` (5 minutes) | Exit a stalled WhatsApp startup so the server can restart it; suspended while waiting for QR pairing |
| `OWNER_NUMBERS` | Empty | Comma-separated international owner phone numbers, e.g. `256700123456,256700654321` |
| `OPENAI_API_KEY` | Empty | Enables full language-aware content filtering; without a key, enabled filters use conservative built-in English checks |
| `CONTENT_MODERATION_MODEL` | `gpt-4.1-mini` | OpenAI Responses API model used by the content classifier |
| `CONTENT_MODERATION_TIMEOUT_MS` | `4000` | Classifier timeout in milliseconds, integer 10–30000; timed-out messages are kept |

For example, use `PREFIX='!' npm start` to change commands to `!d`, `!r`, and `!ping`.

## Current behavior

- Group members' web links are deleted for everyone when WhatsApp permits revocation and the bot is a group admin.
- Group admins can post links. Owners, delegated moderators, whitelisted members, and the bot are also protected from automated moderation. Identity checks resolve phone-number IDs and WhatsApp LIDs.
- New members receive a welcome message that mentions them, states the group rules, shows up to five of today's activities and five upcoming activities, and explains how to view the full schedule.
- After detecting a member's link, the bot mentions that member and posts an incrementing warning. Warnings still work if the bot lacks deletion permission. If identity lookup fails, moderation is skipped and the error is logged rather than risking deletion of an admin's message.
- Explicit HTTP/HTTPS URLs, `www` domains, and bare domains with recognized public suffixes count as links, including domains enclosed in parentheses. Ordinary filenames such as `report.pdf` and email addresses do not. Text that is also a real domain, such as `notes.md`, is treated as a link.
- Reply to a message with `.d` to revoke it for everyone. The sender must be an owner, admin, or delegated moderator; the bot must be an admin. Missing permissions or an expired revocation window produce an error; deletion never falls back to the bot's local copy.
- Reply to a member's message with `.r` to request removal. Both the sender and bot must be admins. Phone and LID targets are supported; members who have already left are rejected.
- `.ping` replies `pong` in groups or direct chats.
- Commands must come from another account. Messages sent by the linked bot account are ignored.

Warnings and link-offence counts persist across restarts. By default, the first three link-containing messages are deleted and receive targeted warnings; the **fourth link offence removes the member** when the bot is a group admin. A successful repeated-link removal clears that link-warning cycle. Adding the member back starts again with three warnings before removal on the fourth link. Join events also clear old link offences for both phone and LID aliases, while retaining unrelated manual warnings. Duplicate join events do not clear a new warning. Old pending link-removal proposals and old link-warning undo records cannot affect the new membership. Each message counts as one offence even if it contains several links. Unrelated manual warnings do not count as link offences. Existing installations recover previous link offences from retained successful link-warning audit records, up to the saved warning total; older records outside the retained audit cannot be recovered. Previously completed link removals found in retained audit records clear their old offence counts during upgrade. Recovery does not remove anyone at startup: an active offence count at or above the threshold triggers removal on the next link.

The enabled default rules welcome members, moderate links, remove repeat link offenders, enforce local mutes, and remove locally banned members who rejoin. Raid locking is disabled by default. `.set autopilot off` or `.panic` pauses these rules and scheduled announcements; manual commands remain available. Approval, dry-run, disabled commands, protected-member checks, and the hourly destructive-action cap also apply to repeated-link removal.

## Roles and admin commands

| Role | Default access |
| --- | --- |
| Owner (`OWNER_NUMBERS`) | Admin controls in any group the bot can access; `.panic all` / `.resume all` |
| Group admin | Admin controls and moderation in their own group |
| Delegated moderator | Warn/unwarn, delete, local mute/unmute, and send a message |
| Member | Ping, today's activities, and group FAQ answers |

Use a full international phone number, `NUMBER@c.us`, or `NUMBER@lid` as a target. Phone and LID numbers can differ; the bot resolves their identities rather than comparing digits. Targets can also come from a quoted message. `@sender` is available inside rules. Commands and permission overrides belong to the current group.

| Command | Purpose |
| --- | --- |
| `.help` | List member, moderation, activity, and admin commands |
| `.antilink on`, `.antilink off`, `.antilink status` | Restore/enable default link deletion, warnings and fourth-offence removal, disable these rules, or show moderation blockers |
| `.filter on`, `.filter off`, `.filter status` | Admins enable, disable or inspect language-aware content filtering in their group |
| `.filter test MESSAGE` | Admins test text and receive exactly `FLAG` or `OK`; does not delete anything or enable filtering |
| `.warn USER [reason]` / `.unwarn USER` | Add/remove a warning |
| `.deleted` / `.retrieve [ID]` | Admins list saved deletions or repost a saved copy; omitting ID retrieves the latest deletion |
| `.v list` / `.v [ID]` (also `.viewonce`) | Admins list or retrieve available saved view-once media as normal media; reply with `.v` or use `.v` alone for the latest file |
| `.d` / `.delete MESSAGE_ID` | Delete a quoted message or specified message for everyone |
| `.r` / `.remove USER` | Remove the quoted member or specified member |
| `.mute USER MINUTES` / `.unmute USER` | Locally delete that member's future messages; duration 1–1440 minutes |
| `.ban USER` / `.unban USER` | Remove and store a local rejoin ban; unban removes the local record |
| `.lock` / `.unlock` | Allow only admins / all members to post |
| `.massdelete [@USER] COUNT` | Revoke up to 50 recent messages; automated use excludes protected members |
| `.mod add USER`, `.mod remove USER`, `.mod list` | Delegate/revoke limited moderation access |
| `.whitelist add USER`, `.whitelist remove USER`, `.whitelist list` | Protect a member from automatic moderation |
| `.perm COMMAND member\|moderator\|admin\|owner` | Change a command's minimum role |
| `.cmd enable COMMAND` / `.cmd disable COMMAND` | Enable/disable a command |
| `.status` | Automation settings, bot admin status, timers, warnings, removals this hour, pending approvals, and recent failures |
| `.config export` / `.config import JSON` | Back up/restore group configuration, without replacing audit, warnings, proposals, or delivery history |
| `.panic` / `.resume` | Pause/resume all automation in this group |
| `.audit [1–50] [actor]` | Recent action IDs and results; e.g. `.audit 20 rule` or `.audit 10 300@lid` |
| `.undo ACTION_ID` | Reverse a supported action recorded in the audit |
| `.say MESSAGE` | Send a group message |

Admin controls have an admin role floor and cannot be disabled, so a permission change cannot hand configuration control to members or disable recovery. Operational commands can have their minimum roles changed. The bot still needs the relevant WhatsApp permissions for deletions, removals, and group locking.

### Language-aware content filtering

With an API key, the classifier uses the policy in [src/content-policy.txt](src/content-policy.txt). The policy flags profanity and disguised vulgar insults, targeted hate speech, harassment or personal threats, sexually explicit content, and incitement to violence. It permits normal conversation and friendly banter, mild expressions such as "damn" and "crap", discussion or news reporting about offensive topics, and questions or quotes about words. It instructs the model to judge English, Luganda, Swahili, Sheng and mixed-language messages in their original language, treat instructions inside messages as content, and choose `OK` when unsure.

**An API key is no longer required to enable the filter.** Without one, built-in conservative checks catch a small set of clear English profanity, disguised spellings such as `f*ck`, `sh1t` and `fuuuck`, spaced letters, and explicit direct threats. Quoted words, meaning questions, reported speech, friendly banter indicators and uncertain cases are kept. These checks do not implement the full policy or understand regional languages; use the API classifier for those. Local mode sends no text to OpenAI. `.filter status` reports which classifier is running.

To enable the full policy, set `OPENAI_API_KEY` privately in Railway Variables and redeploy. For a local foreground process, export the key in its environment before `npm start`. For the background Linux service, export it before rerunning `npm run start:local`; restarting an existing service alone does not copy new shell variables. Keep keys out of messages, Git and screenshots. Use an OpenAI API account with available billing or credit; API calls incur usage charges.

Filtering starts **off in every group**, including groups saved before this feature. From another current admin account, send:

```text
.filter test damn, that was close
.filter test what does this word mean?
.filter on
.filter status
.filter off
```

With an API key and `.filter on`, the bot sends incoming member message text and media captions to the [OpenAI Responses API](https://developers.openai.com/api/docs/guides/migrate-to-responses), using the policy as separate instructions and `store: false`. Files, phone numbers, group identifiers and chat history are not supplied as metadata; any such information written into the message text is part of the input. Only a completed response containing `FLAG` requests deletion; `OK`, timeouts, invalid replies and provider failures keep the message. An API failure does not fall back to the word checks and risk a different decision. Model decisions can still be wrong, especially for local slang; test representative messages before enabling it in a group.

Admins, owners, delegated moderators, whitelisted members, bot messages and direct chats are exempt. The bot must be a group admin, and autopilot, panic, approval, dry-run, disabled deletion commands and the shared hourly destructive cap still apply. Content filtering does not add link warnings or remove members. Before deletion, the bot fetches the current message and checks that its text has not changed. Flagged messages and captions are excluded from automatic recovery; deliberate admin recovery commands remain available.

Checks run in the background so API delays do not block link moderation. The API classifier allows up to four concurrent requests and 60 requests per minute and caches valid decisions for two minutes. Both modes keep messages longer than 20,000 characters; API checks beyond request limits also keep messages. `.filter status` shows deletion blockers such as missing bot admin permission, filtering off, disabled deletion, dry-run, approval, panic or caps, and the last flagged deletion result. `.status` shows the group's filter setting. Settings persist across restarts and are included in configuration exports. API tests use mocked responses; they do not establish live multilingual accuracy. Local tests exercise actual text decisions and deletion through the controller.

### If links are not being removed

Run `.antilink status` from another admin account in the group. Make the **linked bot account** a group admin. `.antilink on` restores default link deletion, warnings and fourth-offence removal, and enables the `delete`, `warn` and `remove` commands. It preserves offence counts, approval, dry-run, panic, and autopilot settings; status shows which settings still prevent immediate moderation. `.antilink off` disables both default link rules; custom rules remain independently configurable.

Use `.rule disable builtin-link-removal` to keep deleting links and warning without removing members. To change only the removal threshold, edit the existing rule, for example `.rule edit builtin-link-removal WHEN link_warning_count_reached(5) IF sender_role=member THEN remove @sender`. This removes from the fifth offence. `.unwarn USER` subtracts one general warning and one link offence, down to zero. Undoing a manual warning leaves the link count unchanged; undoing a link warning reverses that offence as well. `.status` shows both counts. Calling `.antilink on` restores the default threshold of four.

For immediate moderation, an admin can use:

```text
.antilink on
.set autopilot on
.set dryrun off
.set approval off
.resume
```

Test a fresh link using a **different, non-admin account**. The linked account's messages are ignored, and admins/protected members are exempt. When deletion is refused, the default rule still attempts a warning that mentions the sender. Check `.audit 10` for revocation or sending failures and `.antilink status` for the hourly cap.

The opaque `r: r` / `getChatById` failure can occur when WhatsApp Web renames message keys from `_serialized` to `$1`, causing the pinned library to issue an invalid IndexedDB lookup. The startup compatibility adapter in `src/whatsapp-compat.js` adapts the library's injected group lookup, incoming message serialization, send, and edit functions in memory before initialization. It follows the [upstream message-key fix](https://github.com/wwebjs/whatsapp-web.js/pull/201848), works on both field names, and remains active after reinstalling dependencies. Restart with `npm start` to load it. Sessions do not need to be deleted. Review the adapter alongside revocation when upgrading the pinned library.

To control a group privately, DM the bot from another account:

```text
.groups
.use GROUP_ID
.status
.activity list
.panic
.resume
```

`.use` also accepts a unique exact group name. The bot checks your current role in the selected group on **every command**. Only owners and current admins can use private control, even if a command is normally available to members. Selection resets when the process restarts. An owner can use `.panic all` or `.resume all` without selecting a group.

Admin shortcuts and FAQs:

```text
.alias today activities
.macro check status; activity list
.addcmd rules Be respectful. Group members must not post links.
.addcmd price Tickets cost 5,000 UGX.
.cmds
.delcmd price
```

Choose an unused name and run `.today` or `.check`; every underlying step checks permissions, rate limits, disabled commands, and dry-run state. A macro stops after a denied/failed step and does not roll back completed steps. FAQ replies match the first word of a message, with or without the prefix (`rules` or `.rules`). Alias/macro chains are bounded and cycles are rejected. To remove shortcuts, export configuration, remove the relevant mapping, and import it.

## Automation settings and approvals

```text
.set autopilot on
.set dryrun on
.set approval destructive
.set approvalttl 10
.set cap 20
.set rate 30
.set raidcount 5
.set raidwindow 60
```

Defaults: autopilot on, dry-run off, approvals off, 10-minute proposal expiry, 20 automated destructive attempts per rolling hour, 30 operational commands per person per minute, and raid detection at 5 joins within 60 seconds. Automatic actors have a separate 120-command/minute limit. `approvalttl` uses minutes and `raidwindow` uses seconds.

Approval modes are `off`, `destructive`, and `all`. Destructive mode proposes automatic deletions, removals, bans, mass deletions, and locking before acting. All mode also proposes automatic messages, warnings, welcomes, and other operational effects. Admin configuration changes and manual moderation do not require proposals. Proposals appear in the group and survive normal restarts:

```text
.yes PROPOSAL_ID
.no PROPOSAL_ID
```

Only current admins/owners can decide. Approval rechecks target identity/protection, bot privileges, panic, enabled commands, and the hourly cap. A proposal can execute once and cannot be approved after expiry. Mass deletion proposals retain concrete message IDs rather than selecting newer messages. Agenda proposals retain their date; an old proposal cannot send a different day's agenda. A crash while executing an approved action leaves the proposal claimed; inspect the audit and actual group state rather than retrying automatically.

Dry-run suppresses operational effects, including warning-count changes, revocation, removal, and normal outgoing responses. It posts a simulation diagnostic and writes a dry-run audit record. Admin controls remain usable to turn dry-run off. The automated destructive cap counts attempts, reserving capacity before acting; mass deletion reserves one unit per selected message. Exceeding the cap pauses automation and alerts admins. Failed attempts still consume their reservation. Review `.audit` and `.status` before `.resume`.

## Rules syntax

```text
WHEN trigger(argument) [IF condition AND condition] THEN command; command
```

Admins manage rules with `.rule add SOURCE`, `.rule edit ID SOURCE`, `.rule list`, `.rule remove ID`, `.rule enable ID`, `.rule disable ID`, `.rule cooldown ID SECONDS`, and `.rule test ID`. New rules start enabled with a 60-second cooldown; valid cooldowns are 0–86400 seconds. Editing preserves the ID, enabled state, and cooldown. Up to 50 rules can belong to one group.

```text
.rule add WHEN message_matches("hello") IF sender_role=member THEN say Hello @sender
.rule edit builtin-link-removal WHEN link_warning_count_reached(4) IF sender_role=member THEN remove @sender
.rule add WHEN schedule("08:00") THEN say Today's meeting starts at 14:00.
.rule add WHEN schedule("0 8 * * 1-5") THEN activities
.rule add WHEN keyword_in_media_caption("sale") IF message_type=image THEN warn @sender Please ask an admin before advertising.
.rule add WHEN member_left THEN say A member has left the group.
.rule add WHEN admin_changed THEN say Group admin permissions have changed.
.rule add WHEN bot_became_admin THEN say Moderation is ready.
.rule enable builtin-raid
.rule edit builtin-welcome WHEN member_joined THEN welcome; say Please read the group description.
```

Available triggers: `message_matches("REGEX")`, `member_joined`, `member_left`, `warn_count_reached(N)` (all warnings at or above N), `link_warning_count_reached(N)` (only link offences at or above N), `raid_detected`, `schedule("HH:MM")`, `schedule("FIVE-FIELD CRON")`, `admin_changed`, `bot_became_admin`, and `keyword_in_media_caption("REGEX")`. Internal editable defaults also use `link_detected`, `member_muted`, and `member_banned`. Regexes are case-insensitive Unicode patterns, at most 256 characters, screened by `safe-regex2`; only the first 4,000 message characters are matched. This screening is a heuristic.

Conditions: `sender_role=owner|admin|moderator|member`, `message_type=chat|image|...`, `time_window=07:00-18:00` (inclusive; midnight-crossing windows work), `setting.autopilot=true|false`, `setting.dryRun=true|false`, `setting.approval=off|destructive|all`, and `account_age_days>=N` / `<=N` / `=N` when supplied by an event. WhatsApp Web does not supply account creation age here: age-conditioned rules skip safely and log the missing information.

Scheduled rules use the group's activity timezone. The scheduler checks each minute after pairing and suppresses repeat execution within the same matching minute, including normal restarts. Scheduled rules do not catch up missed times; the daily agenda has its separate catch-up behavior described below. Raid detection counts joins observed by this process and resets after restart. A rule cannot trigger itself through a command outcome, and chained execution stops at depth three.

`.rule test ID` simulates against the last ordinary message observed in the group, without changing warnings or applying actions; it writes diagnostic audit records and bypasses cooldown for the simulation. Join/leave/admin triggers can use that message's sender as a simulated event target. Schedule rules still require a matching current time. Results can therefore differ from a real notification. Disabled rules can be simulated.

Rules use only commands marked `automationSafe`. Administrative configuration, permissions, approvals, undo, and audit commands cannot run automatically. Alias/macro children are checked independently. Automated moderation protects owners, admins, delegated moderators, whitelist members, and the bot; welcomes and informational group messages can mention them. Unresolved identity/permission lookups cause a skip and log entry.

## Audit and reversal

Each group retains its latest 200 audit records, including actor type/ID, command arguments, target, result, dry-run flag, and approver. A side-effect intent is saved before acting; if it cannot be saved, the operation stops. Audit-write failures pause automation in memory until recovery and `.resume`.

`.undo ID` removes an added warning, restores local mute/ban state, or restores group posting permissions when the previous value was known. An action can be undone once. Disabled commands, current permissions, bot privileges, and dry-run still apply to the reversal. Deleted messages cannot be restored to their original place; `.retrieve` can repost an available archived copy. Undoing a ban clears the local ban but does not re-add the removed member; an admin must invite them. A completed standalone removal has no automatic reversal. State after a crash between an external action and its final audit update can remain recorded as `running`; exactly-once external delivery is not guaranteed.

## Adding a command

Register production commands during `createController` setup, after legacy command registration, using the shared engine:

```js
engine.register({
  name: "notice",
  aliases: ["announce"],
  description: "Post an informational group notice",
  requiredRole: "moderator",
  needsBotAdmin: false,
  destructive: false,
  automationSafe: true,
  effect: true,
  args: { raw: "string" },
  parseArgs: args => typeof args === "string" ? { raw: args } : args,
  async run(ctx) {
    if (!ctx.args.raw) throw new Error("A notice is required");
    await ctx.chat.sendMessage(ctx.args.raw);
  }
});
```

Context contains `groupId`, `actor` (`user`, `system`, or `rule` plus ID), `target`, parsed `args`, `reply`, `client`, `storage`, `dryRun`, and resolved `chat`. `effect: true` is required for operational side effects so dry-run and approvals intercept them. Mark destructive operations appropriately. Targeted automatic moderation must set `targetSafety: true` and a `resolveTarget(ctx, permissions)` resolver; use the shared target helpers. A `minimumRole` floor protects admin controls from permission overrides. Return `{ undo: { command, target, args }, irreversible }` when applicable.

All entry points call `engine.executeCommand(name, ctx)`. Nested commands call `ctx.executeCommand(name, overrides)` to preserve actor, target group, and chain restrictions. Do not call another command's `run` directly or send a command message from the linked account. The central engine handles authorization, enabled state, rate limits, dry-run, approvals, destructive capacity, bounded execution, audit, and error reporting. Keep argument validation in the parser/run and target/identity resolution in the resolver. Add fake-client tests for permissions and actual side effects when adding an operational command.

## Retrieving deleted messages and view-once media

Reply to recoverable view-once media with `.v` to repost a new ordinary attachment. Manual recovery and automatic reposting explicitly send photos and videos with `isViewOnce: false`; the new copy can be opened repeatedly. The original message remains view-once, and reposting requires the bot to have received the file.

Recovered deletions show `From: NAME` for the person who deleted the message, using WhatsApp's native `revokeSender` identity and their saved contact name or public profile name. `Original sender: NAME` identifies the author separately, including when an admin deletes another member's message. If WhatsApp omits the deletion identity, `From:` explicitly says it is unknown. Saved names and user mentions provide fallbacks when contact lookup fails; the bot never assumes the original sender performed the deletion. View-once copies show their sender's display name in `From:`.

WhatsApp currently delivers some incoming view-once images as `ciphertext` placeholders with subtype `view_once_unavailable_fanout`. These contain no file, media key, or download path and do not trigger the library's ordinary `message` event. The bot listens to `message_ciphertext` as well, records these as unavailable view-once messages, and explains the missing file once. `.viewonce list` shows their records. Changing outgoing media options cannot retrieve an image that the linked device never received. If downloadable media later arrives for the same message, the bot can save and repost it without repeating the earlier notice; older saved unavailable notices also permit this retry. Personal chats remain excluded.

**Automatic recovery is enabled by default in groups.** When another account deletes a message for everyone, the bot reposts the saved text and available media. For view-once messages, the bot can redisplay an ordinary copy only when WhatsApp delivers downloadable media to the linked Web account. This cannot recover view-once files withheld by WhatsApp. Successful copies are explicitly sent with `isViewOnce: false`, without requiring a command, and include the original sender. Media downloads and reposts run in the background so link moderation continues immediately. Messages deleted by the bot for moderation, including links, local mute enforcement and admin deletion commands, are excluded. The bot also checks the current link rule before automatically restoring link text.

Admins can send `.set repostdeleted on|off` and `.set repostviewonce on|off` to control each behavior. Automatic reposts use the shared `repost` command, so panic, autopilot, dry-run, disabled commands, rate limits and approval mode apply. Approval `all` proposes reposting before sending. Per-message delivery records suppress duplicate notifications and survive normal restarts; partial sends retain progress so retrying does not repeat a saved header. A crash between an outgoing message and saving its progress cannot guarantee exactly-once delivery. Archived copies remain available through the admin commands below.

Current group admins and configured owners can explicitly restore bot-deleted links to the group chat with `.restorelink ID`. `.restorelink list` lists matching archived links and their IDs; `.restorelink` or `.restorelink last` restores the latest one. This also posts into the selected group when invoked through private admin control; the private chat receives a confirmation. The command supports a quoted archived message, rejects records from other groups and records that are not bot-deleted links, and obeys dry-run and command permissions. Restoring a link keeps its original warning count. Automatic recovery continues to exclude moderated links. The saved copy must still exist in the 24-hour archive. The new command is included in `.help`.

From another group admin account, send `.help` for the recovery commands:

```text
.deleted
.retrieve ID
.retrieve
.restorelink list
.restorelink ID
.restorelink
.v
.v list
.v ID
.viewonce list
.viewonce ID
```

`.deleted` lists up to ten recently deleted messages, with IDs and original senders. `.retrieve ID` (also `.restore ID`) reposts the bot's saved copy. With no ID, it retrieves the most recent saved deletion. An admin can also reply to a message with `.retrieve` or `.v`. `.v list` lists saved view-once records; `.v ID` retrieves one and `.v` without an ID selects the latest one. Available files are reposted as ordinary media. `.viewonce` remains an alias for the same behavior. For private recovery, DM the bot `.groups`, then `.use GROUP_ID`, then these commands; copies are delivered to that admin's chat. Current admin/owner authorization is checked each time, and moderators and ordinary members cannot retrieve saved content.

The bot records incoming group messages while connected and saves available media in the background. It marks deletions from both its own moderation and WhatsApp's `message_revoke_everyone` event. When that event includes the original text, it can save it even if the earlier incoming event was missed. This is a **reposted copy**, not restoration of the original WhatsApp message. Content deleted before it was saved, missing media, and expired archive records cannot be reconstructed. WhatsApp can omit the original deletion snapshot; see the library's [deletion event documentation](https://docs.wwebjs.dev/Client.html#event:message_revoke_everyone).

View-once recovery is **best effort**: capture preserves the native view-once flag and uses only download metadata WhatsApp already delivered to the linked account, including the media MIME type. It can download exposed media even when the library's `hasMedia` flag is false and can use the originally received metadata after deletion. It does not change view-once flags or invent missing media keys. Admin retrieval retries an unsuccessful download if the original message remains available in the same group, including when replying to the media. It can repost a copy only if WhatsApp exposed downloadable media to the linked account and the download succeeded. WhatsApp often withholds view-once media from web clients; the library has documented [unavailable view-once downloads](https://github.com/wwebjs/whatsapp-web.js/issues/3349). The bot reports this limitation and asks for the content to be resent as normal media. It does not guarantee retrieval of already viewed or unavailable media.

The local archive expires after **24 hours**, retains at most **200 messages per group**, and has a **100 MB total serialized size limit**. Older records are evicted when capacity is reached. Each media download is limited to **5 MB**, four concurrent downloads, and a ten-second wait; larger/unavailable media can still retain its caption. Archiving and downloads operate independently of rule autopilot/panic; they do not block moderation on media downloads. Personal chats and messages sent by the linked bot account are excluded. The archive is stored with owner-only file permissions in the session volume, alongside the other persistent bot data. Expiry runs on access, startup, and the minute scheduler while connected.

## Activity announcements

Admins add activities inside each group. The bot posts that day's agenda automatically at **07:00 Uganda time (Africa/Kampala)** by default. Groups receive announcements only when they have activities scheduled for that day. No activities are preloaded; add your real schedule before expecting announcements.

Every group member can send `.activities` for today's agenda, `.activities tomorrow`, `.activities week` for the next seven days including today, or `.activities YYYY-MM-DD` for a particular date. Week previews show up to 20 occurrences; use a date to see that day's full list.

**Any current group admin can add and edit activities**, including events added by another admin. Enter the commands in the group from another account, or select that group through private admin control. Any activity name works: Truth or Dare, sticker battles, quizzes, music nights, birthday celebrations, meetings, and more. These entries supply the welcome previews and daily announcements; members host and play the games at their scheduled times. Examples only:

```text
.activity add 2026-10-03 14:00 | Community meeting at the hall
.activity add friday 16:00 | Weekly group discussion
.activity add daily 09:00 | Morning check-in
.activity add today 20:00 | Truth or Dare
.activity add tomorrow 19:00 | Sticker battle
.activity add saturday 21:00 | Weekly quiz — hosted by the admins
.activity edit ID friday 20:30 | Truth or Dare — updated starting time
.activity time 07:30
.activity timezone Africa/Kampala
.activity list
.activity remove ID
.activity help
```

Use 24-hour times and dates in `YYYY-MM-DD` format. `today` and `tomorrow` are saved as actual dates using the group's timezone. Recurring activities accept a full weekday name or `daily`. The time after the date/weekday is the activity's starting time; `.activity time` sets when the daily agenda is posted. Each saved activity gets an ID shown in the confirmation and list commands. Replace `ID` with that saved ID to edit or remove an activity. Edits preserve the ID. Activities and announcement times belong to the group where the admin enters them. The bot does not need admin privileges to manage the activity schedule, but it must be permitted to send messages to that group.

Schedules and daily delivery records are saved in the session volume. The scheduler checks every minute once WhatsApp is ready. If the bot starts after the configured announcement time, it sends today's agenda when activities exist; it does not send agendas for missed previous days. Normal restarts preserve the daily delivery record and avoid resending the same agenda. A crash between sending and saving the record can cause a duplicate on restart. A new activity added after that day's agenda has already been posted appears in `.activities`; it does not trigger a second automatic agenda.

Removing all activities for a day stops that day's announcement. An admin can change each group's announcement time or timezone independently. Keep the session volume persistent to retain the schedule.

## WhatsApp limitations

- Local mutes rely on revoking each future message while the bot is active and permitted to delete. They do not prevent the member from sending, and panic, approvals, the cap, or dry-run can delay/prevent enforcement.
- Local bans rely on receiving a rejoin notification and removing the member again. They do not invalidate invite links or block joining at the WhatsApp server.
- Account creation age is unavailable. The bot does not invent it.
- Revocation windows, removal restrictions, group posting permissions, identity mapping, and notification delivery are controlled by WhatsApp. Mass deletion uses recently fetched messages rather than complete history.
- Restarts preserve stored configuration and approvals, but events missed while offline are not replayed. No automatic re-add is implemented. Deleted-message recovery uses locally saved content; missing content cannot be reconstructed.

## Railway deployment

To keep the bot running when your PC is shut down or asleep, deploy it to an always-on server. Closing the local terminal, losing internet or powering off the PC stops a locally hosted bot. A process manager on that PC still requires the PC to stay powered on.

Follow the [24/7 hosting guide](docs/24-7-hosting.md) to deploy this GitHub repository to Railway, attach persistent storage, pair WhatsApp and move your activity settings. Cloud deployment requires your own Railway account and a phone for the initial QR scan; committing these files does not deploy or pair a cloud bot.

Deploy using the included Dockerfile. It installs Chromium and uses `npm ci` with the checked-in lockfile. Mount a persistent Railway volume at `/app/data/session`; startup automatically uses Railway's volume mount as the session directory unless you explicitly set `SESSION_PATH`. Keep the same volume and session path used when pairing. Use a single running instance for each paired WhatsApp account.

The included `railway.json` configures Docker deployment, one replica, Serverless sleeping disabled, `/live` as the deployment healthcheck and `ON_FAILURE` with up to 10 restarts. This avoids the `ALWAYS` policy rejection on Free/Trial. For paid hosting, select `/railway.always.json` as the service's Railway Config File to use unlimited `ALWAYS` restarts. Railway Hobby currently starts at $5/month including $5 of resource usage; usage above that adds to the bill. See Railway's [restart policy](https://docs.railway.com/deployments/restart-policy), [pricing](https://docs.railway.com/pricing/plans) and [configuration reference](https://docs.railway.com/config-as-code/reference).

Railway currently supports these legacy JSON configuration files only for services already using Config as Code, until December 1, 2026. For a service without that support, set the equivalent Dockerfile, `/live`, one-instance, awake and restart settings in its dashboard. See [Railway's current configuration guidance](https://docs.railway.com/config-as-code).

Startup reuses an existing profile inside the Railway volume, including the older Docker session location and legacy `.wwebjs_auth` folders, without moving pairing files. It logs the session directory and whether a saved browser profile exists. It warns if Railway has no persistent volume, checks write access, and rejects session paths outside the mounted volume. On a single Railway volume, stale Chromium lock symlinks from a previous container are removed without deleting pairing or group data. A live browser on the same host blocks a second instance. These checks address storage and browser startup failures; they cannot restore pairing files lost with an old container. See the [already-paired Railway troubleshooting steps](docs/24-7-hosting.md#already-scanned-a-qr-on-railway).

| Endpoint | Meaning |
| --- | --- |
| `/live` | HTTP 200 while the service runs; permits the initial QR pairing step |
| `/health` | HTTP 200 with `ok: true, ready: true` only when WhatsApp is connected; otherwise HTTP 503 |
| `/` | Basic service response; does not indicate WhatsApp readiness |

Initialization failures, authentication failures, WhatsApp disconnects, Chromium disconnections, and browser-page crashes or closures exit with status 1 so Railway can restart the process. A startup watchdog also exits if WhatsApp has not become ready within five minutes. It pauses while a QR needs scanning and resumes after authentication; readiness cancels it. Set `WHATSAPP_STARTUP_TIMEOUT_MS` to an integer between 1000 and 3600000 to change the wait. Startup also checks whether a restored session finished syncing before the library registered its listener and recovers the missing readiness callback. SIGINT/SIGTERM close the browser and HTTP server. Cleanup is limited to five seconds before exit. Running `npm start` locally does not automatically restart the process; start it again after an error, or use a process supervisor.

## Verification

`npm test` uses fake clients to exercise the shared command pipeline from chat, DM, schedule and rule; roles and phone/LID identities; moderation; welcomes; activities; approvals and restart recovery; conditions and rule chains; panic; dry-run; caps; macros; FAQ; reversible actions; browser revocation; HTTP readiness; and failure shutdown without contacting WhatsApp. Content-filter tests cover instruction/input separation, strict FLAG/OK parsing, timeouts, provider failures, request limits, caching, admin controls, persistence, protected members, approvals, changed-message checks and automatic recovery suppression without contacting OpenAI.

For a live test after pairing, use another account:

1. Send `.ping` and confirm `pong`.
2. Use a test non-admin member: send four link-containing messages, including `https://example.com` and `(example.com)`. Confirm deletion and targeted warnings for the first three, then removal on the fourth. Add the removed test member back; confirm their next three links warn from one again and the fourth removes them. Duplicate join events must not reset a newer warning.
3. Have an admin send a link; confirm it remains.
4. Send `Please read report.pdf`; confirm it remains.
5. Reply to a recent message with `.d`; confirm it disappears for other members too.
6. Reply to a test member's message with `.r`; confirm removal.
7. Remove the bot's admin role, try `.d`, and confirm the command reports missing permissions without local deletion.
8. Add a test member and confirm the bot welcomes and mentions them.
9. Add a real activity for today, set the announcement time to the next minute, and confirm the agenda is sent once. Use `.activities` to verify its contents.
10. Restart the bot with the same persistent volume and confirm activities remain saved and the same day's delivered agenda is not resent.
11. DM `.groups` / `.use GROUP_ID` as an admin, then run `.status`. Demote that admin and confirm further DM commands are denied. Try a group they do not administer.
12. Delegate a test moderator with `.mod add USER`: confirm warn/delete/mute work and configuration/removal are denied by default. Confirm protected members' links are exempt from automatic moderation.
13. Use `.set dryrun on`, test a warning/removal rule, and confirm no warning-count or membership changes. Check `.audit`, then turn dry-run off.
14. Enable destructive approval, generate a proposal, restart with the same volume, and approve it once. Test rejection, expiry, and a target promoted to admin before approval.
15. In a disposable group, test joins, departures, admin changes, bot promotion, media captions, scheduled rules, and warning escalation. Use `.rule test ID` to confirm simulation. Ensure `.panic` stops all automated paths and `.resume` restores them.
16. Set a small cap in the test group and confirm excess automated deletion/removal pauses automation and alerts admins. Restore the cap and resume.
17. Test local mute/unmute, local ban/unban on rejoining, and lock/unlock. Use `.audit` IDs with `.undo` and confirm reversible state changes and clear replies for irreversible operations.
18. Export/import settings, use a macro from accounts with different permissions, and confirm FAQ replies. Verify warnings, delegation, rules, and proposals remain after restart.
19. Send a normal text and small photo from another account, delete them for everyone, confirm automatic reposting, then use `.deleted` and `.retrieve ID` as an admin. Confirm saved text/media return, and ordinary members and delegated moderators cannot access them. Send view-once media and confirm an available copy is redisplayed automatically; unavailable media must produce an honest explanation. `.viewonce` remains available for manual recovery. Confirm that links deleted by moderation stay deleted. Test duplicate deletion events, partial-send retries, recovery switches, panic, dry-run, and approval mode. Restart with the same session volume and verify the saved archive remains available until expiry.

The revocation adapter intentionally avoids the library's local-delete fallback and uses WhatsApp Web's internal revocation action. The WhatsApp library is pinned; recheck this adapter against the official [Message source](https://docs.wwebjs.dev/structures_Message.js.html) before upgrading. Live pairing and moderation must still be verified against WhatsApp.

## Dependency audit

The current lockfile reports nine high-severity audit findings in the browser dependency chain, including `basic-ftp` and `extract-zip`. The installed WhatsApp library pins its Puppeteer version. The automatic audit fix proposes downgrading WhatsApp Web and other packages, so it has not been applied. Review a supported browser dependency update separately and recheck the revocation adapter before changing the pinned library. Browser downloads are disabled during installation; Chromium is supplied by the operating system.
