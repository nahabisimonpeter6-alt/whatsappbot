// Conservative checks for clear English profanity/insults and direct threats.
// Regional language, slang and ambiguous context need the API classifier.
const GAP = "[\\s*._-]{0,8}";
function disguised(parts) {
  // Bound repeats and separators so adversarial input cannot cause long
  // backtracking across adjacent repeated letters or masking characters.
  return new RegExp(`(?<![\\p{L}\\p{N}])${parts.map(part => part.replace(/\+/g, "{1,12}")).join(GAP)}(?![\\p{L}\\p{N}])`, "iu");
}
const vulgar = [
  disguised(["f+", "[u*]+", "c+", "k+"]),
  disguised(["f+", "[u*]+", "c+", "k+", "[i1!*]+", "n+", "g+"]),
  disguised(["s+", "h+", "[i1!*]+", "t+"]),
  disguised(["b+", "[i1!*]+", "t+", "c+", "h+"]),
  disguised(["a+", "s+", "s+", "h+", "[o0*]+", "l+", "[e3*]+"]),
  disguised(["c+", "[u*]+", "n+", "t+"])
];

function classifyLocalContent(input) {
  let text = String(input ?? "").normalize("NFKC").replace(/[\u200b-\u200d\ufeff]/g, "");
  if (!text.trim() || text.length > 20000) return "OK";
  // Remove explicit quotations before checking the speaker's own words.
  text = text.replace(/"[^"\n]*"|“[^”\n]*”|‘[^’\n]*’|(?:^|\s)'[^'\n]+'(?=\s|[.,!?;:]|$)/gu, " ");
  // Context-dependent discussion, meaning questions, news, and friendly banter
  // remain OK rather than guessing intent from a word list.
  if (/\b(?:mean(?:ing|s)?|definition|define|translate|translation|quote[ds]?|quoted|word|term|lyrics?|profanity|swearing|slur|news|report(?:ed|ing)?|article|headline|discussion|discuss(?:ing|ed)?|said|says|told|joking|kidding|banter)\b/iu.test(text)) return "OK";
  if (/\bwhat\s+(?:is|are)\b/iu.test(text) && /\?\s*$/.test(text)) return "OK";
  if (/\b(?:do\s+not|don't|never|avoid|stop)\b[^.!?\n]{0,60}\b(?:kill|hurt|shoot|beat|attack|say|use|swear)\b/iu.test(text)) return "OK";
  if (/\b(?:if|would|could|might|maybe)\b/iu.test(text)) return "OK";
  if (/\b(?:i|we)\s+(?:(?:will|shall|am\s+going\s+to|are\s+going\s+to)\s+)(?:kill|shoot|stab|rape)\s+you\b/iu.test(text) ||
      /\b(?:let'?s|go\s+and)\s+(?:kill|shoot|stab)\s+(?:him|her|them)\b/iu.test(text)) return "FLAG";
  if (/\b(?:bro|mate|buddy|my\s+friend)\b/iu.test(text)) return "OK";
  return vulgar.some(pattern => pattern.test(text)) ? "FLAG" : "OK";
}

module.exports = { classifyLocalContent };
