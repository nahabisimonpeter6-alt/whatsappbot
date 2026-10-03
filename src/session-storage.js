const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");

function inside(directory, parent) {
  const relative = path.relative(parent, directory);
  return relative === "" || relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function processAlive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === "ESRCH") return false; throw error; }
}

function prepareSessionStorage({ env = process.env, projectPath = path.join(__dirname, ".."), logger = console,
  hostname = os.hostname(), isProcessAlive = processAlive } = {}) {
  const onRailway = !!(env.RAILWAY_PROJECT_ID || env.RAILWAY_ENVIRONMENT_ID);
  const volume = env.RAILWAY_VOLUME_MOUNT_PATH ? path.resolve(env.RAILWAY_VOLUME_MOUNT_PATH) : null;
  const localDefault = path.resolve(projectPath, "data", "session");
  // Earlier Docker builds used /app/data/session even with a volume mounted
  // at /app/data. Retain an existing profile there instead of choosing an
  // empty volume root after upgrading. Legacy LocalAuth folders are likewise
  // reused in place; authentication data is never copied or moved.
  const existing = volume && [volume, localDefault, path.join(volume, "session"), path.join(volume, ".wwebjs_auth")]
    .find(directory => inside(directory, volume) && fs.existsSync(path.join(directory, "session", "Default")));
  const sessionPath = path.resolve(env.SESSION_PATH || existing || volume || localDefault);
  if (onRailway && volume && !inside(sessionPath, volume)) {
    throw new Error(`SESSION_PATH (${sessionPath}) is outside the Railway volume (${volume}). Set SESSION_PATH to the directory containing your saved session inside that volume, or remove the override to use the volume mount.`);
  }
  if (onRailway && !volume) logger.warn("[SESSION] No Railway persistent volume is attached. QR pairing will be lost on redeploy. Attach a volume at /app/data/session before pairing.");
  fs.mkdirSync(sessionPath, { recursive: true, mode: 0o700 });
  if (onRailway && volume && !inside(fs.realpathSync(sessionPath), fs.realpathSync(volume))) {
    throw new Error("SESSION_PATH resolves outside the Railway volume through a symlink. Use a directory on the mounted volume.");
  }
  const probe = path.join(sessionPath, `.write-check-${randomUUID()}`);
  try { fs.writeFileSync(probe, "", { flag: "wx", mode: 0o600 }); }
  catch (error) { throw new Error(`Session storage is not writable (${error.code}). Check the volume's permissions and available space.`, { cause: error }); }
  finally { if (fs.existsSync(probe)) fs.unlinkSync(probe); }

  const profile = path.join(sessionPath, "session");
  if (onRailway && volume && fs.existsSync(profile) && !inside(fs.realpathSync(profile), fs.realpathSync(volume))) {
    throw new Error("The browser profile resolves outside the Railway volume. Keep the saved session on the mounted volume.");
  }
  const lock = path.join(profile, "SingletonLock");
  let target;
  try {
    const stat = fs.lstatSync(lock);
    if (!stat.isSymbolicLink()) throw new Error("Chromium's session lock is not a recognised symlink. Stop other instances and inspect the profile lock before restarting.");
    target = fs.readlinkSync(lock);
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  if (target) {
    const match = /^(.*)-(\d+)$/.exec(target);
    if (!match || Number(match[2]) < 1) throw new Error("Chromium's session lock is malformed. Stop other instances and inspect the profile lock before restarting.");
    if (match[1] === hostname) {
      if (isProcessAlive(Number(match[2]))) throw new Error("This WhatsApp session is already in use by a running browser. Stop the other bot instance before starting another.");
    } else if (!(onRailway && volume)) {
      throw new Error("This WhatsApp session is locked by another host. Stop that instance before moving the session; its lock was left untouched.");
    }
    // Railway prevents overlapping deployments on the same attached volume.
    // A different hostname here is the previous container. Remove only its
    // browser lock symlinks; retain all WhatsApp login and group data.
    for (const name of ["SingletonSocket", "SingletonCookie", "SingletonLock"]) {
      const file = path.join(profile, name);
      try { if (fs.lstatSync(file).isSymbolicLink()) fs.unlinkSync(file); }
      catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    logger.log("[SESSION] Removed stale Chromium lock symlinks; saved pairing data was preserved.");
  }
  logger.log(`[SESSION] directory: ${sessionPath}`);
  logger.log(fs.existsSync(path.join(profile, "Default"))
    ? "[SESSION] Existing browser profile found; attempting to reuse its WhatsApp pairing."
    : "[SESSION] No saved browser profile found; a new QR pairing may be required.");
  return sessionPath;
}

module.exports = { prepareSessionStorage };
