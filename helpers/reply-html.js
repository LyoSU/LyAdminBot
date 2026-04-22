// Centralized HTML reply/edit helpers.
//
// - Always sets parse_mode HTML.
// - Defaults link previews OFF (modern link_preview_options + legacy
//   disable_web_page_preview for telegraf 3.33 backward-compat).
// - Accepts reply_to_message_id shorthand and emits modern reply_parameters
//   alongside the legacy field.
// - Bypasses telegraf's chunked sendMessage helpers and goes through callApi
//   so we can pass new Bot API fields without telegraf knowing about them.

const buildPayload = (chatId, text, opts = {}) => {
  const payload = {
    chat_id: chatId,
    text,
    parse_mode: 'HTML',
    ...opts
  }

  // Link preview defaults (modern + legacy). Caller can override either.
  // "Disabled" means is_disabled === true explicitly — absence means enabled
  // (so caller can pass link_preview_options:{url:'...'} without is_disabled
  // and still get the preview through both old and new API forms).
  if (payload.link_preview_options === undefined) {
    payload.link_preview_options = { is_disabled: true }
  }
  const isDisabled = payload.link_preview_options.is_disabled === true
  if (payload.disable_web_page_preview === undefined) {
    payload.disable_web_page_preview = isDisabled
  }

  // reply_to_message_id → reply_parameters (keep both)
  if (payload.reply_to_message_id !== undefined && payload.reply_parameters === undefined) {
    payload.reply_parameters = { message_id: payload.reply_to_message_id }
  }

  return payload
}

const replyHTML = (ctx, text, opts = {}) => {
  const payload = buildPayload(ctx.chat.id, text, opts)
  return ctx.telegram.callApi('sendMessage', payload)
}

const editHTML = (ctx, messageId, text, opts = {}) => {
  const payload = buildPayload(ctx.chat.id, text, opts)
  payload.message_id = messageId
  return ctx.telegram.callApi('editMessageText', payload)
}

module.exports = { replyHTML, editHTML }
