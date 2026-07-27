import { describe, expect, it, vi, beforeEach } from 'vitest'

/**
 * The OpenAI client is replaced wholesale so these tests exercise our own
 * logic: score pass-through and the content-addressed cache. The cache is not
 * an optimisation detail — profile media is re-checked on every message a
 * newcomer sends, so without it each of those was a paid call on one picture.
 */
const createMock = vi.fn()
vi.mock('openai', () => ({
  default: class {
    moderations = { create: createMock }
  }
}))

const { OpenAiModerationPort } = await import('./moderation-port.js')

const response = (
  categories: Record<string, boolean>,
  categoryScores: Record<string, number>,
  flagged = true
): unknown => ({ results: [{ flagged, categories, category_scores: categoryScores }] })

beforeEach(() => { createMock.mockReset() })

describe('OpenAiModerationPort', () => {
  it('returns nothing, and calls nothing, for empty input', async () => {
    const port = new OpenAiModerationPort('k')
    expect(await port.check('', null)).toBeNull()
    expect(createMock).not.toHaveBeenCalled()
  })

  it('passes per-category scores through', async () => {
    createMock.mockResolvedValue(response(
      { sexual: true, violence: false },
      { sexual: 0.91, violence: 0.02 }
    ))
    const result = await new OpenAiModerationPort('k').check('text', null)
    expect(result?.scores['sexual']).toBe(0.91)
    expect(result?.scores['violence']).toBe(0.02)
    expect(result?.categories).toEqual(['sexual'])
  })

  it('survives a provider that omits category_scores', async () => {
    createMock.mockResolvedValue({ results: [{ flagged: true, categories: { sexual: true } }] })
    const result = await new OpenAiModerationPort('k').check('text', null)
    expect(result?.scores).toEqual({})
    expect(result?.flagged).toBe(true)
  })

  it('ignores non-numeric scores rather than propagating them', async () => {
    createMock.mockResolvedValue(response({}, { sexual: 'high' as unknown as number, violence: 0.3 }))
    const result = await new OpenAiModerationPort('k').check('text', null)
    expect(result?.scores).toEqual({ violence: 0.3 })
  })

  it('bills identical input only once', async () => {
    createMock.mockResolvedValue(response({ sexual: true }, { sexual: 0.9 }))
    const port = new OpenAiModerationPort('k')
    const first = await port.check('', 'AVATARBYTES')
    const second = await port.check('', 'AVATARBYTES')
    expect(createMock).toHaveBeenCalledTimes(1)
    expect(second).toEqual(first)
  })

  it('does not confuse different inputs', async () => {
    createMock
      .mockResolvedValueOnce(response({ sexual: true }, { sexual: 0.9 }))
      .mockResolvedValueOnce(response({}, { sexual: 0.01 }, false))
    const port = new OpenAiModerationPort('k')
    const porn = await port.check('', 'PORN')
    const cat = await port.check('', 'CAT')
    expect(createMock).toHaveBeenCalledTimes(2)
    expect(porn?.scores['sexual']).toBe(0.9)
    expect(cat?.scores['sexual']).toBe(0.01)
  })

  it('keys text and image separately — same bytes, different text is a different question', async () => {
    createMock.mockResolvedValue(response({}, { sexual: 0.1 }, false))
    const port = new OpenAiModerationPort('k')
    await port.check('hello', 'IMG')
    await port.check('goodbye', 'IMG')
    expect(createMock).toHaveBeenCalledTimes(2)
  })

  it('caches a null result too, so a scoreless response is not retried forever', async () => {
    createMock.mockResolvedValue({ results: [] })
    const port = new OpenAiModerationPort('k')
    expect(await port.check('text', null)).toBeNull()
    expect(await port.check('text', null)).toBeNull()
    expect(createMock).toHaveBeenCalledTimes(1)
  })

  it('lets API errors propagate — a dead key must be visible, not a silent no-op', async () => {
    // The v1 bug: swallowing 401 turned moderation into an invisible no-op for
    // months. The pipeline's safe() wrapper records the throw as a port error.
    createMock.mockRejectedValue(new Error('401 Incorrect API key'))
    await expect(new OpenAiModerationPort('k').check('text', null)).rejects.toThrow('401')
  })

  it('does not cache failures', async () => {
    createMock
      .mockRejectedValueOnce(new Error('rate limit'))
      .mockResolvedValueOnce(response({ sexual: true }, { sexual: 0.8 }))
    const port = new OpenAiModerationPort('k')
    await expect(port.check('text', null)).rejects.toThrow('rate limit')
    expect((await port.check('text', null))?.scores['sexual']).toBe(0.8)
  })

  it('stays bounded under a flood of distinct inputs', async () => {
    createMock.mockResolvedValue(response({}, { sexual: 0.01 }, false))
    const port = new OpenAiModerationPort('k')
    for (let i = 0; i < 1500; i += 1) await port.check(`msg-${i}`, null)
    // Every input was distinct, so all 1500 hit the API; the point is that the
    // process is still healthy and the cache did not grow without limit.
    expect(createMock).toHaveBeenCalledTimes(1500)
    const size = (port as unknown as { cache: Map<string, unknown> }).cache.size
    expect(size).toBeLessThanOrEqual(1000)
  })

  it('truncates very long text instead of sending it whole', async () => {
    createMock.mockResolvedValue(response({}, {}, false))
    await new OpenAiModerationPort('k').check('x'.repeat(10_000), null)
    const input = createMock.mock.calls[0]?.[0].input as { type: string; text?: string }[]
    expect(input[0]?.text?.length).toBe(4000)
  })
})
