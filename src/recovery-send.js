// Keep normal photo/video recovery in one outgoing message. Preserve long
// text and non-caption media using separate parts rather than truncating it.
const INLINE_CAPTION_LIMIT = 1024;
function canAttachCaption(media, text) {
  return !!media && /^(?:image|video)\//i.test(media.mimetype || "") &&
    Array.from(text).length <= INLINE_CAPTION_LIMIT;
}

async function sendRecovery({ send, makeMedia, media, text, textSent = false, mediaSent = false, markDelivered = () => {} }) {
  if (!textSent && !mediaSent && canAttachCaption(media, text)) {
    await send(makeMedia(media), { caption: text, isViewOnce: false });
    // Sending succeeded for both parts. Save them together when the caller
    // supplies a combined marker so a later deletion cannot send either again.
    await markDelivered({ textSent: true, mediaSent: true });
    return;
  }
  if (!textSent) { await send(text); await markDelivered({ textSent: true }); }
  if (media && !mediaSent) { await send(makeMedia(media), { isViewOnce: false }); await markDelivered({ mediaSent: true }); }
}

module.exports = { sendRecovery, canAttachCaption, INLINE_CAPTION_LIMIT };
