const { randomUUID } = require("node:crypto");
const { createCommandRegistry } = require("./command-registry");
const { validTime, validDate, validTimezone, validWhen } = require("./automation-store");

class ActivityInputError extends Error {}

function localClock(now, timezone) {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit",
    weekday: "long", hour: "2-digit", minute: "2-digit", hourCycle: "h23"
  }).formatToParts(now).map(part => [part.type, part.value]));
  return {
    date: `${parts.year}-${parts.month}-${parts.day}`,
    time: `${parts.hour}:${parts.minute}`,
    weekday: parts.weekday.toLowerCase()
  };
}

function todaysActivities(group, clock) {
  return group.activities.filter(activity =>
    activity.when === "daily" || activity.when === clock.date || activity.when === clock.weekday
  ).sort((a, b) => a.time.localeCompare(b.time));
}

function agenda(group, clock) {
  const activities = todaysActivities(group, clock);
  const heading = `📅 Activities for ${clock.date} (${group.timezone})`;
  return `${heading}\n\n${activities.length ? activities.map(a => `• ${a.time} — ${a.text}`).join("\n") : "No activities are scheduled for today."}`;
}

function createAutomations({ client, store, isAdmin, prefix = ".", logger = console, now = () => new Date(), intervalMs = 60000, registry }) {
  const commands = registry || createCommandRegistry({ onError: error => logger.error("[COMMAND] failed:", error) });
  let timer;
  let active = false;
  let ticking = false;
  const sentThisSession = new Map();
  const welcomed = new Set();

  async function runWelcome(notification, throwErrors = false) {
    try {
      const key = notification?.id?._serialized;
      if (key && welcomed.has(key)) return;
      if (!notification?.chatId?.endsWith("@g.us")) return;
      const recipients = [...new Set(notification.recipientIds || [])].filter(id =>
        /^\d+@(c\.us|lid)$/.test(id) && id !== client.info?.wid?._serialized
      );
      if (!recipients.length) return;
      if (key) {
        welcomed.add(key);
        // Bound the replay cache; it is only intended for duplicate live events.
        if (welcomed.size > 500) welcomed.delete(welcomed.values().next().value);
      }
      const chat = await notification.getChat();
      if (!chat?.isGroup) return;
      const names = recipients.map(id => `@${id.split("@")[0]}`).join(", ");
      await chat.sendMessage(
        `👋 Welcome ${names} to ${chat.name || "the group"}!\n\nPlease be respectful. Links from non-admins are removed and receive warnings.\nSend ${prefix}activities to see today's activities.`,
        { mentions: recipients }
      );
    } catch (error) {
      const key = notification?.id?._serialized;
      if (key) welcomed.delete(key);
      logger.error("[WELCOME] failed:", error);
      if (throwErrors) throw error;
    }
  }

  function help() {
    return [
      "📅 Activity commands (admins manage the schedule):",
      `${prefix}activities — today's agenda`,
      `${prefix}activity add YYYY-MM-DD HH:MM | Activity description`,
      `${prefix}activity add monday HH:MM | Weekly activity (use any weekday)`,
      `${prefix}activity add daily HH:MM | Daily activity`,
      `${prefix}activity list`,
      `${prefix}activity remove ID`,
      `${prefix}activity time HH:MM — daily announcement time`,
      `${prefix}activity timezone Africa/Kampala`,
      "Default announcements: 07:00, Uganda time. Only groups with scheduled activities receive them."
    ].join("\n");
  }

  async function runActivityCommand(message) {
    if (message?.fromMe || !message?.from?.endsWith("@g.us")) return false;
    const text = String(message.body || "").trim();
    if (text === `${prefix}activities`) {
      const group = store.get(message.from);
      await message.reply(agenda(group, localClock(now(), group.timezone)));
      return true;
    }
    const command = `${prefix}activity`;
    if (text !== command && !text.startsWith(`${command} `)) return false;
    try {
      const chat = await message.getChat();
      if (!chat?.isGroup || !(await isAdmin(chat, message.author || message.from))) {
        await message.reply("❌ Only group admins can manage activities.");
        return true;
      }
      const args = text.slice(command.length).trim();
      if (!args || args === "help") {
        await message.reply(help());
      } else if (args === "list") {
        const group = store.get(message.from);
        const rows = group.activities.map(a => `${a.id}: ${a.when} ${a.time} — ${a.text}`);
        await message.reply(`📅 Saved activities\nAnnouncement: ${group.announceAt} (${group.timezone})\n\n${rows.join("\n") || "No activities saved."}`);
      } else if (args.startsWith("add ")) {
        const match = /^add\s+(\S+)\s+(\S+)\s*\|\s*([\s\S]+)$/.exec(args);
        if (!match) throw new ActivityInputError(`Use ${prefix}activity add YYYY-MM-DD HH:MM | Activity description.`);
        const when = match[1].toLowerCase(), time = match[2], description = match[3].trim();
        if (!validWhen(when)) throw new ActivityInputError("Use a real date (YYYY-MM-DD), a full weekday name, or daily.");
        if (!validTime(time)) throw new ActivityInputError("Use a 24-hour time, for example 14:30.");
        if (!description || description.length > 500) throw new ActivityInputError("Activity descriptions must contain 1–500 characters.");
        const group = store.get(message.from);
        if (validDate(when) && when < localClock(now(), group.timezone).date) throw new ActivityInputError("That date has already passed.");
        const id = randomUUID().slice(0, 8);
        store.update(message.from, group => {
          if (group.activities.length >= 50) throw new ActivityInputError("Remove an old activity before adding more (maximum 50).");
          group.activities.push({ id, when, time, text: description });
        });
        await message.reply(`✅ Activity saved (${id}): ${when} ${time} — ${description}\nDaily announcement: ${group.announceAt} (${group.timezone}).`);
      } else if (args.startsWith("remove ")) {
        const id = args.slice(7).trim();
        store.update(message.from, group => {
          if (!group.activities.some(a => a.id === id)) throw new ActivityInputError("That activity ID was not found. Use the activity list command.");
          group.activities = group.activities.filter(a => a.id !== id);
        });
        await message.reply(`✅ Activity ${id} removed.`);
      } else if (args.startsWith("time ")) {
        const time = args.slice(5).trim();
        if (!validTime(time)) throw new ActivityInputError("Use a 24-hour time, for example 07:00.");
        const group = store.update(message.from, group => { group.announceAt = time; });
        await message.reply(`✅ Daily activity announcements will be sent at ${time} (${group.timezone}).`);
      } else if (args.startsWith("timezone ")) {
        const timezone = args.slice(9).trim();
        if (!validTimezone(timezone)) throw new ActivityInputError("Use a valid timezone, for example Africa/Kampala.");
        store.update(message.from, group => { group.timezone = timezone; });
        await message.reply(`✅ Activity times now use ${timezone}.`);
      } else {
        await message.reply(help());
      }
    } catch (error) {
      logger.error("[ACTIVITY] command failed:", error);
      if (message.commandContext?.throwErrors) { if (error instanceof ActivityInputError) error.publicMessage = error.message; throw error; }
      await message.reply(`❌ ${error instanceof ActivityInputError ? error.message : "Could not update the schedule. Please try again."}`);
    }
    return true;
  }

  async function tick() {
    if (!active || ticking) return;
    ticking = true;
    try {
      const timestamp = now();
      for (const [groupId, group] of store.entries()) {
        if (!active) break;
        if (group.autopilot === false || group.paused) continue;
        const clock = localClock(timestamp, group.timezone);
        if (clock.time < group.announceAt || group.lastAnnouncementDate === clock.date ||
            sentThisSession.get(groupId) === clock.date || !todaysActivities(group, clock).length) continue;
        try {
          const chat = await client.getChatById(groupId);
          if (!active) break;
          if (!chat?.isGroup) throw new Error("Scheduled group could not be resolved.");
          // Settings may change while the chat lookup is in progress.
          const current = store.get(groupId);
          const currentClock = localClock(now(), current.timezone);
          if (currentClock.time < current.announceAt || current.lastAnnouncementDate === currentClock.date ||
              sentThisSession.get(groupId) === currentClock.date || !todaysActivities(current, currentClock).length) continue;
          const outcome = await commands.executeCommand("agenda", { groupId, actor: { type: "system", id: "daily-agenda" }, args: { date: currentClock.date }, chat, client, storage: store, reply: text => chat.sendMessage(text) });
          if (!outcome.ok || outcome.status !== "success") continue;
          // Avoid repeated sends this session even if recording delivery fails.
          sentThisSession.set(groupId, currentClock.date);
          store.update(groupId, saved => { saved.lastAnnouncementDate = currentClock.date; });
        } catch (error) {
          logger.error(`[ACTIVITY] announcement failed for ${groupId}:`, error);
        }
      }
    } finally {
      ticking = false;
    }
  }

  commands.register({ name: "welcome", description: "Welcome new group members", requiredRole: "member", automationSafe: true, effect: true, args: {}, run: ctx => runWelcome(ctx.notification, ctx.enforcePolicy) });
  commands.register({ name: "agenda", aliases: ["activities"], description: "Show today's activities", automationSafe: true, effect: true, args: {}, run: ctx => {
    const group = store.get(ctx.groupId);
    return ctx.reply(agenda(group, localClock(now(), group.timezone)));
  } });
  commands.register({ name: "activity", description: "Manage group activities", requiredRole: "admin", args: {}, run: ctx => runActivityCommand(ctx.message) });

  async function welcome(notification) {
    return commands.executeCommand("welcome", { groupId: notification?.chatId, actor: { type: "system", id: "member-joined" }, args: {}, notification, client, storage: store, reply: () => {} });
  }

  async function handleCommand(message) {
    if (message?.fromMe || !message?.from?.endsWith("@g.us")) return false;
    const text = String(message.body || "").trim();
    if (text === `${prefix}activities`) {
      await commands.executeCommand("agenda", { groupId: message.from, actor: { type: "user", id: message.author || message.from }, args: {}, message, client, storage: store, reply: text => message.reply(text) });
      return true;
    }
    if (text !== `${prefix}activity` && !text.startsWith(`${prefix}activity `)) return false;
    await commands.executeCommand("activity", { groupId: message.from, actor: { type: "user", id: message.author || message.from }, args: {}, message, client, storage: store, reply: text => message.reply(text) });
    return true;
  }

  function start() {
    if (active) return;
    active = true;
    const run = () => { void tick().catch(error => logger.error("[ACTIVITY] scheduler failed:", error)); };
    timer = setInterval(run, intervalMs);
    timer.unref();
    run();
  }

  function stop() {
    active = false;
    clearInterval(timer);
  }

  return { welcome, handleCommand, start, stop, tick };
}

module.exports = { createAutomations, localClock, todaysActivities, agenda };
