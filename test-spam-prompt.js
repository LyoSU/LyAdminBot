require('dotenv').config()
const { OpenAI } = require('openai')

const openRouter = new OpenAI({
  baseURL: process.env.OPENROUTER_API_URL || 'https://openrouter.ai/api/v1',
  apiKey: process.env.OPENROUTER_API_KEY
})

async function testSpamPrompt() {
  // Симулюємо кейс Maksym
  const messageText = 'Дружина Наполеона'

  const contextInfo = [
    'Group: "Тестовий чат"',
    'Username: @MaxVpro18',
    'Messages in group: 3',
    'User bio: "Lego gunnery officer 🇬🇧🇬🇧"'
  ]

  const systemPrompt = `Telegram group spam classifier. Classify the MESSAGE. Output JSON: reasoning, classification (SPAM/CLEAN), confidence (0-100).

SPAM = unwanted commercial/scam content: ads, scams, phishing, service promotion, mass messaging.

NOT SPAM = normal human behavior: chatting, questions, jokes, trolling, rudeness, arguments, sharing links in context.

Key principle: offensive ≠ spam. Trolls and rude users are annoying but not spammers.
Trust users with history (messages, reputation, Stars rating).
CRITICAL: Base reasoning ONLY on actual text provided. Never invent or assume content not present.
When uncertain → CLEAN.`

  const userPrompt = `MESSAGE: ${messageText}

CONTEXT: ${contextInfo.join(' | ')}`

  console.log('=== SYSTEM PROMPT ===')
  console.log(systemPrompt)
  console.log('\n=== USER PROMPT ===')
  console.log(userPrompt)
  console.log('\n=== CALLING LLM ===')

  try {
    const response = await openRouter.chat.completions.create({
      model: process.env.OPENROUTER_MODEL || 'google/gemini-2.5-flash',
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt }
      ],
      temperature: 0,
      response_format: {
        type: 'json_schema',
        json_schema: {
          name: 'spam_analysis',
          schema: {
            type: 'object',
            properties: {
              reasoning: { type: 'string' },
              classification: { type: 'string', enum: ['SPAM', 'CLEAN'] },
              confidence: { type: 'integer', minimum: 0, maximum: 100 }
            },
            required: ['reasoning', 'classification', 'confidence'],
            additionalProperties: false
          }
        }
      },
      max_tokens: 150
    })

    const result = JSON.parse(response.choices[0].message.content)

    console.log('\n=== RESULT ===')
    console.log('Classification:', result.classification)
    console.log('Confidence:', result.confidence)
    console.log('Reasoning:', result.reasoning)

    if (result.classification === 'SPAM') {
      console.log('\n⚠️  Still classified as SPAM!')
    } else {
      console.log('\n✅ Correctly classified as CLEAN')
    }
  } catch (err) {
    console.error('Error:', err.message)
  }
}

testSpamPrompt()
