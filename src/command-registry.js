function createCommandRegistry({ authorize, beforeRun, audit, resolveDynamic, afterRun, onError = () => {} } = {}) {
  const entries = new Map();
  const aliases = new Map();

  function normalize(definition) {
    return { aliases: [], description: "", requiredRole: "member", needsBotAdmin: false, destructive: false, automationSafe: false, effect: false, args: {}, ...definition };
  }

  function register(definition) {
    if (!definition?.name || typeof definition.run !== "function") throw new Error("Commands need a name and run(ctx).");
    const entry = normalize(definition);
    entries.set(entry.name, entry);
    for (const alias of entry.aliases) aliases.set(alias, entry.name);
    return entry;
  }

  function get(name, ctx = {}) {
    const entry = entries.get(aliases.get(name) || name) || resolveDynamic?.(name, ctx);
    return entry ? normalize(entry) : null;
  }

  async function executeCommand(name, context = {}) {
    const ctx = { actor: { type: "user", id: "" }, args: {}, dryRun: false, depth: 0, stack: [], ...context };
    const entry = get(name, ctx);
    let outcome;
    try {
      if (!entry) throw new Error(`Unknown command: ${name}`);
      if (ctx.depth > 3 || /^(alias|macro):/.test(entry.name) && ctx.stack.includes(entry.name)) throw new Error("Command chain stopped: maximum depth or a loop was reached.");
      ctx.command = entry.name;
      ctx.stack = [...ctx.stack, entry.name];
      ctx.executeCommand = (child, overrides = {}) => executeCommand(child, {
        ...ctx, ...overrides, actor: ctx.actor, groupId: ctx.groupId,
        depth: ctx.depth + 1, stack: ctx.stack,
        dryRun: ctx.dryRun || overrides.dryRun
      });
      if (entry.parseArgs) ctx.args = entry.parseArgs(ctx.args, ctx);
      const permitted = authorize ? await authorize(entry, ctx) : entry.authorize ? await entry.authorize(ctx) : true;
      if (!permitted) outcome = { ok: false, status: "denied", command: entry.name };
      else {
        const intercepted = await beforeRun?.(entry, ctx);
        if (intercepted) outcome = intercepted;
        else if (ctx.dryRun && entry.effect) {
          await ctx.reply?.(`🧪 Dry run: ${entry.name}. No action was performed.`);
          outcome = { ok: true, status: "dry-run", command: entry.name };
        } else {
          const result = await entry.run(ctx);
          outcome = { ok: true, status: "success", command: entry.name, result };
        }
      }
    } catch (error) {
      onError(error, ctx);
      outcome = { ok: false, status: "failed", command: entry?.name || name, error: error.message };
      try { if (ctx.actor.type === "user" || ctx.dryRun) await ctx.reply?.(`❌ ${error.publicMessage || entry?.failureMessage?.replace(/^❌\s*/, "") || "Command failed. Check permissions and try again."}`); } catch { /* original error is audited below */ }
    }
    if (audit) {
      try { outcome.auditId = await audit(entry, ctx, outcome); } catch (error) { ctx.auditFailed = true; outcome.auditError = true; onError(error, ctx); }
    }
    if (outcome.status === "success" && afterRun) {
      try { await afterRun(entry, ctx, outcome); } catch (error) { onError(error, ctx); }
    }
    return outcome;
  }

  return { register, get, executeCommand, entries: () => [...entries.values()] };
}

module.exports = { createCommandRegistry };
