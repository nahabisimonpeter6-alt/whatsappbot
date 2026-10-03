const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { prepareSessionStorage } = require("../src/session-storage");

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "whatsapp-session-storage-"));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const logs = [], warnings = [];
  const logger = { log: text => logs.push(text), warn: text => warnings.push(text) };
  const volume = path.join(root, "volume");
  fs.mkdirSync(volume);
  const profile = path.join(volume, "session");
  const env = { RAILWAY_PROJECT_ID: "project", RAILWAY_VOLUME_MOUNT_PATH: volume };
  const options = { projectPath: root, env, logger, hostname: "current-container", isProcessAlive: () => false };
  return { root, volume, profile, env, options, logs, warnings };
}

function locks(f, owner) {
  fs.mkdirSync(f.profile, { recursive: true });
  fs.symlinkSync(owner, path.join(f.profile, "SingletonLock"));
  fs.symlinkSync("cookie", path.join(f.profile, "SingletonCookie"));
  fs.symlinkSync(path.join(f.root, "external-socket"), path.join(f.profile, "SingletonSocket"));
}

test("local defaults remain unchanged, while Railway uses its actual volume mount", t => {
  const f = fixture(t);
  assert.equal(prepareSessionStorage({ ...f.options, env: {} }), path.join(f.root, "data", "session"));
  assert.equal(prepareSessionStorage(f.options), f.volume);
  assert.equal(f.warnings.length, 0);
  assert.ok(!fs.readdirSync(f.volume).some(name => name.startsWith(".write-check-")));
});

test("an explicit nested session path on the volume is kept", t => {
  const f = fixture(t), directory = path.join(f.volume, "saved-pairing");
  fs.mkdirSync(path.join(directory, "session", "Default"), { recursive: true });
  assert.equal(prepareSessionStorage({ ...f.options, env: { ...f.env, SESSION_PATH: directory } }), directory);
  assert.ok(f.logs.some(line => line.includes("Existing browser profile")));
});

test("the previous Docker session path is reused when the volume mounts its parent", t => {
  const f = fixture(t), volume = path.join(f.root, "data"), previous = path.join(volume, "session");
  fs.mkdirSync(path.join(previous, "session", "Default"), { recursive: true });
  const state = path.join(previous, "automations.json"); fs.writeFileSync(state, "existing activities");
  assert.equal(prepareSessionStorage({ ...f.options, env: { ...f.env, RAILWAY_VOLUME_MOUNT_PATH: volume } }), previous);
  assert.equal(fs.readFileSync(state, "utf8"), "existing activities");
});

test("an existing legacy LocalAuth directory on the volume is reused without moving it", t => {
  const f = fixture(t), previous = path.join(f.volume, ".wwebjs_auth");
  fs.mkdirSync(path.join(previous, "session", "Default"), { recursive: true });
  assert.equal(prepareSessionStorage(f.options), previous);
  assert.ok(fs.existsSync(path.join(previous, "session", "Default")));
});

test("Railway warns before pairing when no persistent volume is attached", t => {
  const f = fixture(t);
  prepareSessionStorage({ ...f.options, env: { RAILWAY_PROJECT_ID: "project" } });
  assert.match(f.warnings[0], /No Railway persistent volume/);
});

test("Railway rejects a session directory outside its volume before creating it", t => {
  const f = fixture(t), outside = path.join(f.root, "volume-other");
  assert.throws(() => prepareSessionStorage({ ...f.options, env: { ...f.env, SESSION_PATH: outside } }), /outside the Railway volume/);
  assert.equal(fs.existsSync(outside), false);
});

test("session and profile symlinks cannot escape the Railway volume", t => {
  const f = fixture(t), outside = path.join(f.root, "outside");
  fs.mkdirSync(outside);
  const escaped = path.join(f.volume, "escaped"); fs.symlinkSync(outside, escaped);
  assert.throws(() => prepareSessionStorage({ ...f.options, env: { ...f.env, SESSION_PATH: escaped } }), /outside the Railway volume through a symlink/);
  fs.symlinkSync(outside, f.profile);
  assert.throws(() => prepareSessionStorage(f.options), /browser profile resolves outside/);
});

test("a new Railway container clears old browser locks while preserving pairing and group data", t => {
  const f = fixture(t);
  locks(f, "previous-container-1234");
  const auth = path.join(f.profile, "Default", "IndexedDB");
  fs.mkdirSync(auth, { recursive: true });
  fs.writeFileSync(path.join(auth, "saved-session"), "test pairing data");
  fs.writeFileSync(path.join(f.volume, "automations.json"), "test group data");
  fs.writeFileSync(path.join(f.root, "external-socket"), "leave this file untouched");
  assert.equal(prepareSessionStorage(f.options), f.volume);
  for (const name of ["SingletonLock", "SingletonCookie", "SingletonSocket"]) assert.throws(() => fs.lstatSync(path.join(f.profile, name)), { code: "ENOENT" });
  assert.equal(fs.readFileSync(path.join(auth, "saved-session"), "utf8"), "test pairing data");
  assert.equal(fs.readFileSync(path.join(f.volume, "automations.json"), "utf8"), "test group data");
  assert.equal(fs.readFileSync(path.join(f.root, "external-socket"), "utf8"), "leave this file untouched");
  // Repeating startup still sees the original saved profile.
  prepareSessionStorage(f.options);
  assert.ok(f.logs.some(line => line.includes("stale Chromium lock")));
});

test("a running browser's lock is never cleared", t => {
  const f = fixture(t); locks(f, "current-container-1234");
  assert.throws(() => prepareSessionStorage({ ...f.options, isProcessAlive: () => true }), /already in use/);
  assert.equal(fs.readlinkSync(path.join(f.profile, "SingletonLock")), "current-container-1234");
  assert.ok(fs.lstatSync(path.join(f.profile, "SingletonSocket")).isSymbolicLink());
});

test("a dead browser on the same host permits startup without deleting its profile", t => {
  const f = fixture(t); locks(f, "current-container-1234");
  prepareSessionStorage({ ...f.options, env: { SESSION_PATH: f.volume } });
  assert.throws(() => fs.lstatSync(path.join(f.profile, "SingletonLock")), { code: "ENOENT" });
  assert.ok(fs.statSync(f.profile).isDirectory());
});

test("foreign-host locks outside Railway are preserved", t => {
  const f = fixture(t); locks(f, "other-computer-1234");
  assert.throws(() => prepareSessionStorage({ ...f.options, env: { SESSION_PATH: f.volume } }), /locked by another host/);
  assert.equal(fs.readlinkSync(path.join(f.profile, "SingletonLock")), "other-computer-1234");
});

test("malformed or non-symlink locks are never removed automatically", t => {
  const f = fixture(t); locks(f, "malformed");
  const file = path.join(f.profile, "SingletonLock");
  assert.throws(() => prepareSessionStorage(f.options), /malformed/);
  assert.equal(fs.readlinkSync(file), "malformed");
  fs.unlinkSync(file); fs.writeFileSync(file, "leave this alone");
  assert.throws(() => prepareSessionStorage(f.options), /not a recognised symlink/);
  assert.equal(fs.readFileSync(file, "utf8"), "leave this alone");
});
