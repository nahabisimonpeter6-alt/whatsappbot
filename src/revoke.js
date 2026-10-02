// Message.delete(true) silently falls back to local deletion when revocation is
// unavailable. Use the same revocation action as whatsapp-web.js, without that
// fallback. Keep this adapter covered when upgrading the library.
async function revokeForEveryone(client, message) {
  const id = message?.id?._serialized || message?.id?.$1;
  if (!id) throw new Error("That message could not be resolved.");

  const revoked = await client.pupPage.evaluate(async messageId => {
    const collections = window.require("WAWebCollections");
    const message = collections.Msg.get(messageId) ||
      (await collections.Msg.getMessagesById([messageId]))?.messages?.[0];
    if (!message) return false;

    const capability = window.require("WAWebMsgActionCapability");
    if (!(capability.canSenderRevokeMsg(message) || capability.canAdminRevokeMsg(message))) {
      return false;
    }

    const chat = collections.Chat.get(message.id.remote) ||
      await collections.Chat.find(message.id.remote);
    const { Cmd } = window.require("WAWebCmd");
    if (window.WWebJS.compareWwebVersions(window.Debug.VERSION, ">=", "2.3000.0")) {
      await Cmd.sendRevokeMsgs(chat, { list: [message], type: "message" }, { clearMedia: true });
    } else {
      await Cmd.sendRevokeMsgs(chat, [message], {
        clearMedia: true,
        type: message.id.fromMe ? "Sender" : "Admin"
      });
    }
    return true;
  }, id);

  if (!revoked) {
    throw new Error("WhatsApp does not allow deleting that message for everyone (permissions or message age).");
  }
}

module.exports = { revokeForEveryone };
