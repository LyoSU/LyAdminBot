import { describe, expect, it } from 'vitest'
import fc from 'fast-check'
import { memberRemovalOf, type MemberUpdateLike } from './gateway.js'

const DATE = new Date('2026-11-22T12:00:00Z')
const update = (over: Partial<MemberUpdateLike> = {}): MemberUpdateLike => ({
  type: 'kicked',
  isSelf: false,
  isSelfMade: false,
  date: DATE,
  chat: { id: -1001 },
  user: { id: 7, isBot: false },
  actor: { id: 99, isBot: false, isSelf: false },
  ...over
})

describe('memberRemovalOf — a removal made by somebody else', () => {
  it('reads a ban and a restriction by an admin as facts', () => {
    expect(memberRemovalOf(update())).toEqual({
      chatId: -1001, userId: 7, actorId: 99, actorIsBot: false, kind: 'kicked', date: DATE
    })
    expect(memberRemovalOf(update({ type: 'restricted' }))?.kind).toBe('restricted')
  })

  it('says when another bot did it', () => {
    expect(memberRemovalOf(update({ actor: { id: 5, isBot: true, isSelf: false } }))?.actorIsBot).toBe(true)
  })

  it('is silent about this bot\'s own acts, self-made changes, removed bots and every other kind of update', () => {
    expect(memberRemovalOf(update({ actor: { id: 1, isBot: true, isSelf: true } }))).toBeNull()
    expect(memberRemovalOf(update({ isSelf: true }))).toBeNull()
    expect(memberRemovalOf(update({ isSelfMade: true }))).toBeNull()
    expect(memberRemovalOf(update({ actor: { id: 7, isBot: false, isSelf: false } }))).toBeNull()
    expect(memberRemovalOf(update({ user: { id: 7, isBot: true } }))).toBeNull()
    for (const type of ['joined', 'added', 'left', 'unkicked', 'unrestricted', 'promoted', 'demoted', 'demoted_kicked', 'demoted_restricted', 'other']) {
      expect(memberRemovalOf(update({ type }))).toBeNull()
    }
  })

  it('PROPERTY: whatever the update, a result names a ban or restriction of a person by a different actor that is not this bot', () => {
    const anyUpdate = fc.record({
      type: fc.oneof(fc.constantFrom('kicked', 'restricted', 'joined', 'left', 'demoted_kicked', 'other'), fc.string()),
      isSelf: fc.boolean(),
      isSelfMade: fc.boolean(),
      date: fc.constant(DATE),
      chat: fc.record({ id: fc.integer() }),
      user: fc.record({ id: fc.integer({ min: 1, max: 5 }), isBot: fc.boolean() }),
      actor: fc.record({ id: fc.integer({ min: 1, max: 5 }), isBot: fc.boolean(), isSelf: fc.boolean() })
    })
    fc.assert(fc.property(anyUpdate, (upd) => {
      const r = memberRemovalOf(upd)
      if (r === null) return
      expect(['kicked', 'restricted']).toContain(r.kind)
      expect(r.actorId).not.toBe(r.userId)
      expect(upd.actor.isSelf || upd.isSelf || upd.isSelfMade || upd.user.isBot).toBe(false)
      expect(r).toMatchObject({ chatId: upd.chat.id, userId: upd.user.id, actorId: upd.actor.id })
    }))
  })
})
