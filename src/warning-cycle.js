const { publicError } = require("./permissions");

function resetLinkCycle(group, identities) {
  for (const id of identities) {
    const links = group.linkWarnings[id] || 0;
    group.warnings[id] = Math.max(0, (group.warnings[id] || 0) - links);
    group.linkWarnings[id] = 0;
    group.warningCycles[id] = (group.warningCycles[id] || 0) + 1;
  }
  for (const proposal of group.proposals) if (proposal.status === "pending" && identities.has(proposal.target) &&
    (proposal.args?.linkWarning || proposal.actor?.id === "builtin-link-removal")) {
    proposal.status = "rejected";
    proposal.result = "Member started a new warning cycle.";
  }
}

function checkLinkCycle(ctx, storage) {
  const current = storage.get(ctx.groupId).warningCycles[ctx.target] || 0;
  if (ctx.args.warningCycle === undefined) ctx.args.warningCycle = current;
  else if (ctx.args.warningCycle !== current) throw publicError("That link warning or removal belongs to an earlier membership. It will not affect the new warning cycle.");
}

module.exports = { resetLinkCycle, checkLinkCycle };
