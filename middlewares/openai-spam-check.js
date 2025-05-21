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
You are a chat moderator. Your task is to determine if a message contains spam or harmful content.

Analyze the following message and identify if it contains any of these issues:
1. Spam (advertisements, suspicious links, mass messaging)
2. Offensive content or hate speech
3. Threats, scams, or manipulative content
4. Messages that appear to be sent by bots rather than humans

Message:
"""
${text}
"""

Respond ONLY with a JSON object in this format:
{
  "isSpam": true or false,
  "reason": "brief explanation of why this was flagged or not (1-10 words)"
}
`

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

  // // Skip if user is an administrator
  const chatMember = await ctx.telegram.getChatMember(ctx.chat.id, ctx.from.id).catch(() => null)
  if (chatMember && ['creator', 'administrator'].includes(chatMember.status)) {
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
      const result = await checkSpam(ctx.message.text || ctx.message.caption)

      if (result.isSpam) {
        // Permanently ban the user
        await ctx.telegram.kickChatMember(
          ctx.chat.id,
          ctx.from.id
        ).catch(console.error)

        // Delete the message
        await ctx.deleteMessage().catch(console.error)

        // Send notification to the chat
        await ctx.replyWithHTML(ctx.i18n.t('spam.banned', {
          name: userName(ctx.from, true),
          reason: result.reason
        })).catch(console.error)

        return // Stop further processing
      }
    }
  }

  return true // Continue processing
}
