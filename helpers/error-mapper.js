/**
 * Map Telegram API errors to user-friendly locale keys
 * Returns the locale key to use for the error message
 */
const mapTelegramError = (error, action = 'generic') => {
  const errorText = (error.description || error.message || '').toLowerCase()

  // Admin-related errors
  if (errorText.includes('administrator') || errorText.includes('creator')) {
    return `${action}.error_admin`
  }

  // User not in chat
  if (errorText.includes('not a member') ||
      errorText.includes('user not found') ||
      errorText.includes('peer_id_invalid') ||
      errorText.includes('kicked') ||
      errorText.includes('left')) {
    return `${action}.error_left`
  }

  // Permission errors
  if (errorText.includes('not enough rights') ||
      errorText.includes('need administrator') ||
      errorText.includes('no rights') ||
      errorText.includes('chat_admin_required')) {
    return `${action}.error_no_rights`
  }

  // Message too old to delete
  if (errorText.includes('message to delete not found') ||
      errorText.includes("message can't be deleted")) {
    return `${action}.error_old`
  }

  // Generic fallback
  return `${action}.error`
}

module.exports = { mapTelegramError }
