/**
 * ModerationPort over OpenAI omni moderation (text + image). The flag is
 * only a SIGNAL in v2 (never a decision) — NSFW chatter between regulars
 * is an admin-policy matter, not automatic spam.
 */
import OpenAI from 'openai'
import type { ModerationPort, ModerationResult } from '@lyadmin/core'

const MODERATION_MODEL = 'omni-moderation-latest'

export class OpenAiModerationPort implements ModerationPort {
  private readonly openai: OpenAI

  constructor(apiKey: string) {
    this.openai = new OpenAI({ apiKey })
  }

  async check(text: string, photoBase64: string | null): Promise<ModerationResult | null> {
    if (!text && !photoBase64) return null
    // NOTE: we deliberately do NOT swallow API errors here. A dead/expired
    // key (HTTP 401) used to return null silently, turning moderation into an
    // invisible no-op. Letting it throw surfaces it via the pipeline's safe()
    // wrapper as meta.portError_moderation in the per-message log.
    const input: OpenAI.Moderations.ModerationMultiModalInput[] = []
    if (text) input.push({ type: 'text', text: text.slice(0, 4000) })
    if (photoBase64) {
      input.push({
        type: 'image_url',
        image_url: { url: `data:image/jpeg;base64,${photoBase64}` }
      })
    }
    const response = await this.openai.moderations.create({
      model: MODERATION_MODEL,
      input
    })
    const result = response.results[0]
    if (!result) return null
    const categories = Object.entries(result.categories)
      .filter(([, flagged]) => flagged === true)
      .map(([name]) => name)
    return { flagged: result.flagged, categories }
  }
}
