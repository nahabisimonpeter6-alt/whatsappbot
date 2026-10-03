const fs = require("node:fs");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { classifyLocalContent } = require("./local-content-classifier");
const POLICY = fs.readFileSync(path.join(__dirname, "content-policy.txt"), "utf8").trim();
const DEFAULT_MODEL = "gpt-4.1-mini";
const MAX_TEXT_LENGTH = 20000;

function createContentClassifier({ apiKey = process.env.OPENAI_API_KEY || "", model = process.env.CONTENT_MODERATION_MODEL || DEFAULT_MODEL,
  timeoutMs = Number(process.env.CONTENT_MODERATION_TIMEOUT_MS || 4000), fetchImpl = globalThis.fetch, logger = console,
  maxConcurrent = 4, maxPerMinute = 60, now = Date.now } = {}) {
  if (!Number.isInteger(timeoutMs) || timeoutMs < 10 || timeoutMs > 30000) throw new Error("CONTENT_MODERATION_TIMEOUT_MS must be an integer between 10 and 30000.");
  let active = 0, calls = [], lastError = null, lastLog = -Infinity;
  const cache = new Map(), pending = new Map();
  function fail(reason) {
    lastError = reason;
    if (now() - lastLog >= 30000) { logger.warn(`[CONTENT] ${reason}; keeping the message.`); lastLog = now(); }
    return "OK";
  }

  async function classify(input) {
    const text = String(input ?? "");
    if (!text.trim()) return "OK";
    if (!apiKey) return classifyLocalContent(text);
    if (text.length > MAX_TEXT_LENGTH) return fail("message too long for configured classifier");
    const key = createHash("sha256").update(text).digest("hex");
    const saved = cache.get(key);
    if (saved && saved.until > now()) return saved.verdict;
    if (pending.has(key)) return pending.get(key);
    calls = calls.filter(time => now() - time < 60000);
    if (active >= maxConcurrent || calls.length >= maxPerMinute) return fail("classifier capacity reached");
    calls.push(now()); active++;
    const abort = new AbortController();
    let timer;
    const request = (async () => {
      const response = await fetchImpl("https://api.openai.com/v1/responses", {
        method: "POST", signal: abort.signal,
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({ model, instructions: POLICY, input: [{ role: "user", content: [{ type: "input_text", text }] }],
          store: false, max_output_tokens: 32 })
      });
      if (!response.ok) return fail(`classifier HTTP ${response.status}`);
      const result = await response.json();
      if (result.status !== "completed" || result.error) return fail("classifier response incomplete");
      const messages = result.output?.filter(item => item.type === "message" && item.role === "assistant");
      if (messages?.length !== 1 || !messages[0].content?.length || messages[0].content.some(part => part.type !== "output_text" || typeof part.text !== "string")) return fail("classifier response invalid");
      const verdict = messages[0].content.map(part => part.text).join("").trim();
      if (verdict !== "FLAG" && verdict !== "OK") return fail("classifier verdict invalid");
      if (abort.signal.aborted) return "OK";
      lastError = null;
      cache.set(key, { verdict, until: now() + 120000 });
      if (cache.size > 500) cache.delete(cache.keys().next().value);
      return verdict;
    })().catch(() => fail(abort.signal.aborted ? "classifier timed out" : "classifier request failed"));
    // Retain the occupied slot until the underlying request actually settles.
    void request.then(() => { active--; });
    const timeout = new Promise(resolve => {
      timer = setTimeout(() => { abort.abort(); resolve(fail("classifier timed out")); }, timeoutMs);
    });
    const job = Promise.race([request, timeout]).finally(() => { clearTimeout(timer); pending.delete(key); });
    pending.set(key, job);
    return job;
  }

  return { classify, status: () => ({ configured: true, apiConfigured: !!apiKey, mode: apiKey ? "openai" : "local",
    model: apiKey ? model : "built-in conservative checks", lastError, active }) };
}

module.exports = { createContentClassifier, POLICY, DEFAULT_MODEL, MAX_TEXT_LENGTH };
