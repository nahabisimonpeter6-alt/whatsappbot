const { randomUUID } = require("node:crypto");
const { createCommandRegistry } = require("./command-registry");
const { createPermissions, ROLES, publicError } = require("./permissions");

function createCommandEngine({ client, storage, logger = console, now = () => new Date(), ownerNumbers, prefix = ".", resolveDynamic, afterRun }) {
  const permissions = createPermissions({ client, storage, ownerNumbers });
  const rate = new Map();
  const auditPaused = new Set();
  let registry;
  const approvalToken = Symbol("approved action");

  async function authorize(entry, ctx) {
    ctx.client = client; ctx.storage = storage; ctx.enforcePolicy = true;
    if (!ctx.groupId) {
      if (entry.groupOptional) return true;
      throw publicError(`Select a group first with ${prefix}use GROUP_ID.`);
    }
    ctx.settings = storage.get(ctx.groupId);
    ctx.dryRun = !!(ctx.dryRun || ctx.settings.dryRun);
    ctx.chat ||= ctx.message?.from === ctx.groupId ? await ctx.message.getChat() : await client.getChatById(ctx.groupId);
    if (!ctx.chat?.isGroup) throw publicError("The group could not be resolved.");
    if (ctx.actor.type === "user") {
      ctx.role = await permissions.role(ctx.chat, ctx.groupId, ctx.actor.id);
      if (ctx.isDM && ROLES[ctx.role] < ROLES.admin) throw publicError("Private control is limited to owners and this group's current admins.");
      const required = ctx.settings.permissions[entry.name] || entry.requiredRole;
      const floor = entry.minimumRole || "member";
      if (ROLES[ctx.role] < Math.max(ROLES[required], ROLES[floor])) throw publicError("Admins only (or delegated moderators for permitted commands).");
    } else {
      if (!["system", "rule"].includes(ctx.actor.type)) throw publicError("Unknown actor type.");
      if (!entry.automationSafe) throw publicError("This command cannot run automatically.");
      if (!ctx.settings.autopilot || ctx.settings.paused || auditPaused.has(ctx.groupId)) throw publicError("Automation is paused for this group.");
    }
    if (!entry.control && ctx.settings.disabledCommands.includes(entry.name)) throw publicError("This command is disabled in this group.");
    if (entry.needsBotAdmin && !(await permissions.botAdmin(ctx.chat))) throw publicError("The bot must be a group admin.");
    if (entry.resolveTarget) await entry.resolveTarget(ctx, permissions);
    if (ctx.actor.type !== "user" && entry.targetSafety && ctx.target && await permissions.protectedTarget(ctx.chat, ctx.groupId, ctx.target)) {
      throw publicError("Automation skipped a protected member.");
    }
    return true;
  }

  async function beforeRun(entry, ctx) {
    if (!ctx.groupId) return;
    const timestamp = now().valueOf();
    const key = `${ctx.groupId}:${ctx.actor.type}:${ctx.actor.id}`;
    const recent = (rate.get(key) || []).filter(time => timestamp - time < 60000);
    const limit = ctx.actor.type === "user" ? ctx.settings.commandRate : 120;
    if (!entry.control && recent.length >= limit) throw publicError("Command rate limit reached. Please wait a minute.");
    if (!entry.control) { recent.push(timestamp); rate.set(key, recent); }
    expireProposals(ctx.groupId);
    if (!ctx.dryRun && ctx.actor.type !== "user" && entry.effect && ctx.approvalToken !== approvalToken &&
        (ctx.settings.approval === "all" || ctx.settings.approval === "destructive" && entry.destructive)) {
      const snapshot = {
        command: entry.name, args: ctx.args, target: ctx.target || null,
        messageId: ctx.targetMessage?.id?._serialized || null,
        actor: ctx.actor, ruleChain: ctx.ruleChain || [],
        notification: ctx.notification ? { chatId: ctx.notification.chatId, id: ctx.notification.id, recipientIds: ctx.notification.recipientIds } : null
      };
      const signature = JSON.stringify(snapshot);
      const existing = storage.get(ctx.groupId).proposals.find(proposal => proposal.status === "pending" && proposal.signature === signature);
      if (existing) return { ok: true, status: "proposed", command: entry.name, proposalId: existing.id };
      const id = randomUUID().slice(0, 8);
      storage.update(ctx.groupId, group => {
        if (group.proposals.filter(proposal => proposal.status === "pending").length >= 100) throw publicError("Too many pending proposals. Review them first.");
        group.proposals.push({ ...snapshot, id, signature, status: "pending", createdAt: now().toISOString(), expiresAt: new Date(timestamp + group.proposalExpiryMs).toISOString() });
        group.proposals = group.proposals.slice(-200);
      });
      try {
        await ctx.chat.sendMessage(`Proposed (${id}): ${entry.name}${ctx.target ? ` @${ctx.target.split("@")[0]}` : ""} by ${ctx.actor.type} ${ctx.actor.id}.\nApprove: ${prefix}yes ${id}\nReject: ${prefix}no ${id}\nExpires in ${Math.round(ctx.settings.proposalExpiryMs / 60000)} minutes.`, ctx.target ? { mentions: [ctx.target] } : {});
      } catch (error) {
        storage.update(ctx.groupId, group => { group.proposals.find(proposal => proposal.id === id).status = "failed"; });
        throw error;
      }
      return { ok: true, status: "proposed", command: entry.name, proposalId: id };
    }
    const current = storage.get(ctx.groupId);
    if (ctx.actor.type !== "user" && (!current.autopilot || current.paused)) throw publicError("Automation is paused for this group.");
    if (!ctx.dryRun && entry.destructive && ctx.actor.type !== "user") {
      const units = entry.destructiveUnits ? entry.destructiveUnits(ctx) : 1;
      let exceeded = false;
      storage.update(ctx.groupId, group => {
        group.destructiveActions = group.destructiveActions.filter(action => timestamp - action.at < 3600000);
        if (group.destructiveActions.reduce((sum, action) => sum + action.units, 0) + units > group.destructiveCap) {
          group.paused = true; exceeded = true;
        } else if (units) group.destructiveActions.push({ at: timestamp, command: entry.name, units });
      });
      if (exceeded) {
        const admins = (ctx.chat.participants || []).filter(person => person.isAdmin || person.isSuperAdmin).map(person => person.id._serialized);
        await ctx.chat.sendMessage(`⚠️ Automation paused: the hourly destructive-action limit was reached. Admins: review ${prefix}status and ${prefix}audit before using ${prefix}resume.`, { mentions: admins });
        throw publicError("Hourly destructive-action cap reached; automation is paused.");
      }
    }
    // Persist intent before operational side effects. If storage is unavailable,
    // no delete, removal, send, or state-changing moderation action can proceed.
    if (entry.effect && !ctx.dryRun) {
      ctx.auditId = randomUUID().slice(0, 8);
      storage.update(ctx.groupId, group => {
        group.audit.push({ id: ctx.auditId, at: now().toISOString(), actor: ctx.actor, command: entry.name, args: structuredClone(ctx.args), target: ctx.target || null, result: "running", dryRun: false, approvedBy: ctx.approvedBy || null });
        group.audit = group.audit.slice(-200);
      });
    }
    if (rate.size > 2000) for (const [id, times] of rate) if (times.at(-1) < timestamp - 60000) rate.delete(id);
  }

  async function audit(entry, ctx, outcome) {
    if (!ctx.groupId) return;
    const id = ctx.auditId || randomUUID().slice(0, 8);
    storage.update(ctx.groupId, group => {
      const row = { id, at: now().toISOString(), actor: ctx.actor, command: entry?.name || ctx.command,
        args: structuredClone(ctx.args), target: ctx.target || null, result: outcome.status, error: outcome.error || null,
        dryRun: !!ctx.dryRun, approvedBy: ctx.approvedBy || null, undo: outcome.result?.undo || null,
        irreversible: outcome.result?.irreversible || null };
      const previous = group.audit.findIndex(row => row.id === id);
      if (previous < 0) group.audit.push(row); else group.audit[previous] = row;
      group.audit = group.audit.slice(-200);
    });
    return id;
  }

  function expireProposals(groupId) {
    if (!storage.get(groupId).proposals.some(proposal => proposal.status === "pending" && new Date(proposal.expiresAt) <= now())) return;
    storage.update(groupId, group => {
      for (const proposal of group.proposals) if (proposal.status === "pending" && new Date(proposal.expiresAt) <= now()) proposal.status = "expired";
    });
  }

  async function decide(ctx, approve) {
    if (ctx.actor.type !== "user" || ROLES[await permissions.role(ctx.chat, ctx.groupId, ctx.actor.id)] < ROLES.admin) throw publicError("Only current group admins or owners can approve proposals.");
    expireProposals(ctx.groupId);
    const id = ctx.args.raw?.trim();
    const proposal = storage.get(ctx.groupId).proposals.find(proposal => proposal.id === id);
    if (!proposal || proposal.status !== "pending") throw publicError("That proposal is missing, expired, or already decided.");
    // Claim it before awaiting the action so competing approvals cannot run it twice.
    storage.update(ctx.groupId, group => { group.proposals.find(proposal => proposal.id === id).status = approve ? "executing" : "rejected"; });
    if (!approve) { await ctx.reply(`✅ Proposal ${id} rejected.`); return; }
    const notification = proposal.notification ? { ...proposal.notification, getChat: () => client.getChatById(ctx.groupId) } : null;
    const result = await registry.executeCommand(proposal.command, {
      groupId: ctx.groupId, actor: proposal.actor, target: proposal.target,
      args: { ...proposal.args, ...(proposal.messageId ? { messageId: proposal.messageId } : {}) },
      notification, approvedBy: ctx.actor.id, approvalToken, ruleChain: proposal.ruleChain,
      depth: ctx.depth + 1, stack: ctx.stack, reply: text => ctx.chat.sendMessage(text)
    });
    storage.update(ctx.groupId, group => {
      const current = group.proposals.find(proposal => proposal.id === id);
      current.status = result.ok ? "approved" : "failed"; current.approvedBy = ctx.actor.id; current.result = result.status;
    });
    await ctx.reply(`Proposal ${id}: ${result.status}.`);
    return result;
  }

  registry = createCommandRegistry({ authorize, beforeRun, audit, resolveDynamic: (name, ctx) => registry.resolveDynamic?.(name, ctx) || resolveDynamic?.(name, ctx), afterRun: (entry, ctx, outcome) => registry.afterRun?.(entry, ctx, outcome) || afterRun?.(entry, ctx, outcome), onError: (error, ctx) => { if (ctx.auditFailed && ctx.groupId) auditPaused.add(ctx.groupId); logger.error("[COMMAND] failed:", error); } });
  const execute = registry.executeCommand;
  const queues = new Map();
  registry.executeCommand = (name, ctx = {}) => {
    if (!ctx.groupId || ctx.depth > 0 || registry.get(name, ctx)?.urgent) return execute(name, ctx);
    const previous = queues.get(ctx.groupId) || Promise.resolve();
    const running = previous.catch(() => {}).then(() => execute(name, ctx));
    queues.set(ctx.groupId, running);
    void running.finally(() => { if (queues.get(ctx.groupId) === running) queues.delete(ctx.groupId); }).catch(() => {});
    return running;
  };
  return Object.assign(registry, { permissions, expireProposals, decide, auditPaused });
}

module.exports = { createCommandEngine };
