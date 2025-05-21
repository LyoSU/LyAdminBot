const { OpenAI } = require('openai')
const { userName } = require('../utils')

// Create OpenAI client
const openai = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

/**
 * Checks message for spam or harmful content using OpenAI model
 * @param {String} text - text to check
 * @returns {Promise<Object>} - result with isSpam flag and reason
 */
const checkSpam = async (text) => {
  if (!text || text.length === 0) return { isSpam: false }

  try {
    const prompt = `
You are a Telegram spam detection system. Your only job is to identify typical Telegram spam messages.

Message to analyze:
"""
${text}
"""

Focus ONLY on these common Telegram spam patterns:
1. Cryptocurrency/trading schemes: Promises of quick profits, investments, crypto signals
2. Dating/adult content solicitation: Links to dating sites, inappropriate services
3. Mass group invitations: Messages inviting users to other groups/channels without context
4. Fake giveaways: Free crypto, prizes requiring clicking suspicious links
5. Job scams: Unrealistic work-from-home offers, easy money schemes
6. Automated bot messages: Generic templates with suspicious links
7. Unauthorized promotions: Unsolicited advertising of services or products
8. Phishing attempts: Messages asking for personal data or Telegram credentials

Important: Do NOT flag:
- Normal conversations
- Questions about cryptocurrencies without promotion
- Legitimate sharing of information
- Opinions or discussions
- Regular links shared in conversation

Respond ONLY with this exact JSON format:
{
  "isSpam": true or false,
  "reason": "brief explanation (3-10 words)"
}
`

    console.log(`[SPAM CHECK] Analyzing message: "${text.substring(0, 100)}${text.length > 100 ? '...' : ''}"`)

    const response = await openai.chat.completions.create({
      model: 'google/gemma-3n-e4b-it:free',
      messages: [
        { role: 'user', content: prompt }
      ],
      temperature: 0,
      // response_format: { type: 'json_object' },
      max_tokens: 150
    })

    try {
      const contentStr = response.choices[0].message.content.trim()
      // Use regex to extract JSON object from the response
      const jsonMatch = contentStr.match(/\{[\s\S]*\}/)
      const jsonStr = jsonMatch ? jsonMatch[0] : '{}'
      const result = JSON.parse(jsonStr)

      console.log(`[SPAM CHECK] Result: ${result.isSpam ? 'SPAM' : 'NOT SPAM'} - Reason: ${result.reason || 'Unspecified reason'}`)

      return {
        isSpam: result.isSpam,
        reason: result.reason || 'Unspecified reason'
      }
    } catch (parseError) {
      console.error('Failed to parse JSON response:', parseError)
      return { isSpam: false }
    }
  } catch (error) {
    console.error('OpenAI chat completion error:', error)
    return { isSpam: false }
  }
}

/**
 * Middleware for checking messages from new users for spam
 */
module.exports = async (ctx) => {
  // Skip if not in a group chat
  if (!ctx.chat || !['supergroup', 'group'].includes(ctx.chat.type)) {
    return
  }

  // Skip if message is a command
  if (ctx.message && ctx.message.text && ctx.message.text.startsWith('/')) {
    return
  }

  // Skip if user is an administrator
  const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null)
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
    return
  }

  // Skip if message is from an anonymous admin (bot acting on behalf of a chat)
  if (ctx.from && ctx.from.is_bot && ctx.sender_chat) {
    return
  }

  // Check number of messages from the user
  if (ctx.group &&
      ctx.group.members &&
      ctx.group.members[ctx.from.id] &&
      ctx.group.members[ctx.from.id].stats &&
      ctx.group.members[ctx.from.id].stats.messagesCount <= 5) {
    // Check message for spam
    if (ctx.message && (ctx.message.text || ctx.message.caption)) {
      const messageText = ctx.message.text || ctx.message.caption
      console.log(`[SPAM CHECK] Checking message from ${userName(ctx.from)} (messages: ${ctx.group.members[ctx.from.id].stats.messagesCount})`)

      const result = await checkSpam(messageText)

      if (result.isSpam) {
        console.log(`[MUTE] User ${userName(ctx.from)} (ID: ${ctx.from.id}) muted for spam`)
        console.log(`[MUTE] Message: "${messageText.substring(0, 150)}${messageText.length > 150 ? '...' : ''}"`)
        console.log(`[MUTE] Reason: ${result.reason}`)

        // Mute the user for 24 hours (86400 seconds)
        await ctx.telegram.restrictChatMember(
          ctx.chat.id,
          ctx.from.id,
          {
            can_send_messages: false,
            can_send_media_messages: false,
            can_send_other_messages: false,
            can_add_web_page_previews: false,
            until_date: Math.floor(Date.now() / 1000) + 86400 // 24 hours from now
          }
        ).catch(error => console.error(`[MUTE ERROR] Failed to mute user: ${error.message}`))

        // Delete the message
        await ctx.deleteMessage().catch(error => console.error(`[MUTE ERROR] Failed to delete message: ${error.message}`))

        // Send notification to the chat and delete it after 30 seconds
        const notificationMsg = await ctx.replyWithHTML(ctx.i18n.t('spam.muted', {
          name: userName(ctx.from, true),
          reason: result.reason
        })).catch(error => console.error(`[MUTE ERROR] Failed to send notification: ${error.message}`))

        // Schedule notification message deletion
        if (notificationMsg) {
          setTimeout(async () => {
            await ctx.telegram.deleteMessage(ctx.chat.id, notificationMsg.message_id)
              .catch(error => console.error(`[MUTE ERROR] Failed to delete notification after timeout: ${error.message}`))
            console.log(`[MUTE] Auto-deleted notification message after timeout`)
          }, 25 * 1000) // 25 seconds
        }

        return true // Stop further processing
      }
    }
  }

  return false // Continue processing
}
