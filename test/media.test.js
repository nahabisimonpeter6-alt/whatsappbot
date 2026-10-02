const test = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const { downloadAvailableMedia, downloadInBrowser } = require("../src/media");

function fixture(current) {
  const calls = [];
  const window = { require: name => {
    if (name === "WAWebCollections") return { Msg: { get: id => { assert.equal(id, "photo"); return current; } } };
    if (name === "WAWebDownloadManager") return { downloadManager: { downloadAndMaybeDecrypt: async args => {
      calls.push(args); return new Uint8Array([1, 2, 3]).buffer;
    } } };
    throw new Error(`Unexpected module: ${name}`);
  }, WWebJS: { arrayBufferToBase64Async: async bytes => Buffer.from(bytes).toString("base64") } };
  const client = { pupPage: { evaluate: (fn, ...args) => vm.runInNewContext(`(${fn.toString()})(...args)`, { window, args, AbortController, setTimeout, clearTimeout }) } };
  return { client, calls, window };
}

const fields = { directPath: "/received-media", encFilehash: "encrypted-hash", filehash: "plain-hash", mediaKey: "received-key", mimetype: "image/jpeg", type: "image", size: 3 };

test("available view-once media is downloaded even when hasMedia is false, including mimetype", async () => {
  const f = fixture({ ...fields, isViewOnce: true });
  const result = await downloadAvailableMedia(f.client, { id: { $1: "photo" }, hasMedia: false, _data: {} }, 1024);
  assert.equal(result.data, "AQID");
  assert.equal(result.mimetype, "image/jpeg");
  assert.equal(f.calls[0].mimetype, "image/jpeg");
  assert.equal(f.calls[0].mediaKey, "received-key");
});

test("received media metadata survives deletion and is used without inventing keys", async () => {
  const f = fixture({ type: "revoked" });
  const result = await downloadAvailableMedia(f.client, { id: { _serialized: "photo" }, _data: fields }, 1024);
  assert.equal(result.data, "AQID");
  assert.equal(f.calls[0].type, "image");
});

test("view-once media without received download keys remains unavailable", async () => {
  const f = fixture({ isViewOnce: true, type: "image" });
  assert.equal(await downloadAvailableMedia(f.client, { id: { _serialized: "photo" }, _data: {} }, 1024), undefined);
  assert.equal(f.calls.length, 0);
});

test("oversized media is refused before download", async () => {
  const f = fixture({ ...fields, size: 2000 });
  assert.equal(await downloadAvailableMedia(f.client, { id: { _serialized: "photo" }, _data: {} }, 1024), undefined);
  assert.equal(f.calls.length, 0);
});

test("oversized decoded media is refused before encoding or saving", async () => {
  const f = fixture({ ...fields, size: undefined });
  assert.equal(await downloadAvailableMedia(f.client, { id: { _serialized: "photo" }, _data: {} }, 2), undefined);
});
