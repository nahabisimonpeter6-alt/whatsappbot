const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createMessageArchive } = require("../src/message-archive");
const logger = { error() {}, warn() {} };
const message = (id, extra = {}) => ({ id: { _serialized: id }, from: "1000@g.us", author: "300@lid", body: "A saved message", type: "chat", ...extra });

test("saved text survives revocation without an original snapshot and a restart", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-archive-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.json");
  const archive = createMessageArchive(file);
  const id = archive.observe(message("original"));
  archive.revoked(message("revocation", { type: "revoked", body: "", protocolMessageKey: { $1: "original" } }));
  const restored = createMessageArchive(file).get("1000@g.us", id);
  assert.equal(restored.deleted, true);
  assert.equal(restored.body, "A saved message");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
});

test("a restart marks interrupted media downloads unavailable and preserves saved text", t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-interrupted-media-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, "archive.json");
  const archive = createMessageArchive(file);
  const id = archive.observe(message("interrupted"));
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  saved.messages[0].mediaStatus = "downloading";
  fs.writeFileSync(file, JSON.stringify(saved));
  const restarted = createMessageArchive(file);
  assert.equal(restarted.get("1000@g.us", id).mediaStatus, "unavailable");
  assert.equal(restarted.get("1000@g.us", id).body, "A saved message");
});

test("an original revocation snapshot can recover a missed message but an empty revocation cannot invent content", () => {
  const archive = createMessageArchive();
  archive.revoked(message("a", { type: "revoked", body: "" }), message("a"));
  archive.revoked(message("b", { type: "revoked", body: "" }));
  assert.equal(archive.get("1000@g.us", "a").body, "A saved message");
  assert.equal(archive.get("1000@g.us", "b").body, "");
});

test("ordinary and available view-once media are saved independently of deletion", async () => {
  const archive = createMessageArchive();
  for (const isViewOnce of [false, true]) {
    const id = archive.observe(message(String(isViewOnce), { type: "image", hasMedia: true, _data: { isViewOnce },
      downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("picture").toString("base64"), filename: "photo.png" }) }));
    await archive.waitFor(id);
    const row = archive.get("1000@g.us", id);
    assert.equal(row.mediaStatus, "saved");
    assert.equal(row.viewOnce, isViewOnce);
    assert.equal(Buffer.from(row.media.data, "base64").toString(), "picture");
  }
});

test("view-once media unavailable from WhatsApp is recorded without fabricated media", async () => {
  const archive = createMessageArchive(undefined, { logger });
  const id = archive.observe(message("hidden", { body: "", type: "image", _data: { isViewOnce: true }, downloadMedia: async () => undefined }));
  await archive.waitFor(id);
  assert.equal(archive.get("1000@g.us", id).mediaStatus, "unavailable");
  assert.equal(archive.get("1000@g.us", id).media, null);
});

test("a stalled media download times out without losing the text or hanging the archive", async () => {
  const archive = createMessageArchive(undefined, { logger, downloadTimeoutMs: 10 });
  const id = archive.observe(message("stalled", { hasMedia: true, downloadMedia: () => new Promise(() => {}) }));
  await archive.waitFor(id);
  assert.equal(archive.get("1000@g.us", id).mediaStatus, "unavailable");
  assert.equal(archive.get("1000@g.us", id).body, "A saved message");
});

test("timed-out browser downloads still occupy their slots until the requests settle", async () => {
  const archive = createMessageArchive(undefined, { logger, downloadTimeoutMs: 10 });
  const releases = [];
  let downloads = 0;
  const downloadMedia = () => { downloads++; return new Promise(resolve => releases.push(resolve)); };
  const ids = Array.from({ length: 4 }, (_, index) => archive.observe(message(`stalled-${index}`, { hasMedia: true, downloadMedia })));
  await Promise.all(ids.map(id => archive.waitFor(id)));
  const refused = archive.observe(message("fifth", { hasMedia: true, downloadMedia }));
  await archive.waitFor(refused);
  assert.equal(downloads, 4);
  assert.equal(archive.get("1000@g.us", refused).mediaStatus, "unavailable");
  for (const release of releases) release(undefined);
  await new Promise(setImmediate);
  const next = archive.observe(message("sixth", { hasMedia: true, downloadMedia: async () => {
    downloads++; return { mimetype: "image/png", data: Buffer.from("picture").toString("base64") };
  } }));
  await archive.waitFor(next);
  assert.equal(downloads, 5);
  assert.equal(archive.get("1000@g.us", next).mediaStatus, "saved");
});

test("retrying unavailable media preserves the original body, ID and deletion status", async () => {
  const archive = createMessageArchive(undefined, { logger });
  const id = archive.observe(message("retry", { hasMedia: true, downloadMedia: async () => undefined }));
  await archive.waitFor(id);
  archive.revoked(message("retry", { body: "", type: "revoked" }));
  const retry = archive.observe(message("retry", { body: "Edited later", hasMedia: true,
    downloadMedia: async () => ({ mimetype: "image/png", data: Buffer.from("picture").toString("base64") }) }), { retryMedia: true });
  assert.equal(retry, id);
  await archive.waitFor(id);
  const row = archive.get("1000@g.us", id);
  assert.equal(row.body, "A saved message");
  assert.equal(row.deleted, true);
  assert.equal(row.mediaStatus, "saved");
});

test("large media is rejected before download when size is known and after download otherwise", async () => {
  const archive = createMessageArchive(undefined, { maxMediaBytes: 3 });
  let downloads = 0;
  const downloadMedia = async () => { downloads++; return { mimetype: "image/png", data: Buffer.from("large").toString("base64") }; };
  const known = archive.observe(message("known", { hasMedia: true, _data: { size: 5 }, downloadMedia }));
  assert.equal(downloads, 0);
  const unknown = archive.observe(message("unknown", { hasMedia: true, downloadMedia }));
  await archive.waitFor(unknown);
  assert.equal(downloads, 1);
  for (const id of [known, unknown]) assert.equal(archive.get("1000@g.us", id).media, null);
});

test("expired messages and older entries above the group limit are evicted", () => {
  let date = new Date("2026-10-02T04:00:00Z");
  const archive = createMessageArchive(undefined, { now: () => date, perGroup: 2 });
  for (const id of ["a", "b", "c"]) { archive.observe(message(id)); date = new Date(date.valueOf() + 1000); }
  assert.deepEqual(archive.list("1000@g.us").map(row => row.sourceId), ["c", "b"]);
  date = new Date(date.valueOf() + 86400000);
  assert.equal(archive.list("1000@g.us").length, 0);
});

test("group isolation, duplicate delivery and excluded personal chats do not leak or overwrite saved content", () => {
  const archive = createMessageArchive();
  archive.observe(message("a"));
  archive.observe(message("a", { body: "Changed" }));
  assert.equal(archive.get("1000@g.us", "a").body, "A saved message");
  assert.equal(archive.list("1000@g.us").length, 1);
  assert.equal(archive.get("2000@g.us", "a"), undefined);
  assert.equal(archive.observe(message("dm", { from: "300@c.us" })), undefined);
  assert.equal(archive.observe(message("self", { fromMe: true })), undefined);
});

test("the total archive byte limit evicts older records across groups", () => {
  let date = new Date("2026-10-02T04:00:00Z");
  const archive = createMessageArchive(undefined, { now: () => date, maxBytes: 1200 });
  archive.observe(message("older", { body: "x".repeat(600) }));
  date = new Date(date.valueOf() + 1000);
  archive.observe(message("newer", { from: "2000@g.us", body: "y".repeat(600) }));
  assert.equal(archive.list("1000@g.us").length, 0);
  assert.equal(archive.list("2000@g.us").length, 1);
});
