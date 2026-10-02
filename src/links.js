const { parse } = require("tldts");

function containsLink(body) {
  const text = String(body || "");
  // Explicit web URLs count even when they use an IP address or an internal host.
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/gi)) {
    try {
      if (new URL(match[0]).hostname) return true;
    } catch {
      // Malformed URLs are checked below as possible bare domains.
    }
  }

  // Accept punctuation around a domain, without matching inside email addresses.
  const domains = /(?<![\p{L}\p{N}_@.-])(?:[\p{L}\p{N}-]+\.)+[\p{L}\p{N}-]+/giu;
  for (const match of text.matchAll(domains)) {
    if (text[match.index + match[0].length] === "@") continue;
    const result = parse(match[0], { allowPrivateDomains: true });
    if (result.domain && (result.isIcann || result.isPrivate)) return true;
  }
  return false;
}

module.exports = { containsLink };
