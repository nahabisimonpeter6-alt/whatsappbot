// whatsapp-web.js 1.34.7 reads raw message keys through _serialized.
// Current WhatsApp Web uses $1 instead. Adapt the pinned injection in memory,
// before Client captures LoadUtils; npm ci does not need to modify node_modules.
// Based on the upstream fix: https://github.com/wwebjs/whatsapp-web.js/pull/201848
function compatibleUtils(loadUtils) {
  let source = loadUtils.toString();
  const replace = (old, replacement) => {
    if (!source.includes(old) || source.indexOf(old) !== source.lastIndexOf(old)) {
      throw new Error("WhatsApp compatibility adapter no longer matches the pinned library. Review it before upgrading.");
    }
    source = source.replace(old, replacement);
  };
  replace("window.WWebJS = {};", `window.WWebJS = {};
    window.WWebJS.getMsgKeyId = key => key?._serialized ?? key?.$1;
    window.WWebJS.botMessageKeyCompat = true;`);
  replace(".Msg.get(newMsgKey._serialized)", ".Msg.get(window.WWebJS.getMsgKeyId(newMsgKey))");
  replace(".Msg.get(msg.id._serialized);", ".Msg.get(window.WWebJS.getMsgKeyId(msg.id));");
  replace("const lastMessage = chat.lastReceivedKey", `const lastReceivedKeyId = window.WWebJS.getMsgKeyId(chat.lastReceivedKey);
            const lastMessage = lastReceivedKeyId`);
  replace(".Msg.get(chat.lastReceivedKey._serialized)", ".Msg.get(lastReceivedKeyId)");
  replace("chat.lastReceivedKey._serialized,", "lastReceivedKeyId,");
  replace("delete msg.pendingAckUpdate;", `msg.isViewOnce = Boolean(message.isViewOnce || msg.isViewOnce);
        if (msg.id && msg.id._serialized == null) {
            const serializedId = window.WWebJS.getMsgKeyId(msg.id);
            if (serializedId) msg.id = { ...msg.id, _serialized: serializedId };
        }
        delete msg.pendingAckUpdate;`);
  // This source is the checked-in, pinned dependency's function, never user input.
  return new Function(`return (${source});`)();
}

function installWhatsAppCompatibility() {
  const utils = require("whatsapp-web.js/src/util/Injected/Utils");
  if (utils.LoadUtils.botMessageKeyCompat) return;
  if (require("whatsapp-web.js/package.json").version !== "1.34.7") {
    throw new Error("Review WhatsApp message-key compatibility when changing whatsapp-web.js versions.");
  }
  const patched = compatibleUtils(utils.LoadUtils);
  patched.botMessageKeyCompat = true;
  utils.LoadUtils = patched;
}

async function recoverMissedAuthSync(client, hasAuthenticated = () => false) {
  if (!client.pupPage || hasAuthenticated()) return false;
  return client.pupPage.evaluate(async () => {
    // The pinned library subscribes to change:hasSynced without checking its
    // current value. A restored session can finish syncing before subscription.
    const socket = window.require("WAWebSocketModel").Socket;
    if (!socket.hasSynced || window.WWebJS || typeof window.onAppStateHasSyncedEvent !== "function") return false;
    await window.onAppStateHasSyncedEvent();
    return true;
  });
}

module.exports = { compatibleUtils, installWhatsAppCompatibility, recoverMissedAuthSync };
