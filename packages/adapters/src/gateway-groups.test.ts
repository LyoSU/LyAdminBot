import { describe, expect, it } from 'vitest'
import { MemoryStorage } from '@mtcute/node'
import { TelegramGateway, type MemberRemovalFacts } from './gateway.js'

/**
 * Both the join handler and the removal handler listen to member updates. The
 * dispatcher runs one handler per group, so this drives a real dispatcher and
 * checks that each update reaches the handler it is for.
 */
describe('member updates reach both the join and the removal handler', () => {
  const update = (type: string) => ({
    name: 'chat_member' as const,
    data: {
      type, isSelf: false, isSelfMade: false, date: new Date(0),
      chat: { id: -1001 }, user: { id: 7, isBot: false }, actor: { id: 99, isBot: false, isSelf: false }
    }
  })

  it('a ban is recorded although the join handler is registered first, and a join still arrives', async () => {
    const gateway = new TelegramGateway({ apiId: 1, apiHash: 'x', session: new MemoryStorage() } as never)
    const joins: number[] = []
    const removals: MemberRemovalFacts[] = []
    gateway.onMemberJoin(async (_chat, user) => { joins.push(user.id) })
    gateway.onMemberRemoval(async (removal) => { removals.push(removal) })
    const dispatcher = (gateway as unknown as { dispatcher: { dispatchUpdateNow(u: unknown): Promise<boolean> } }).dispatcher
    await dispatcher.dispatchUpdateNow(update('kicked'))
    await dispatcher.dispatchUpdateNow(update('joined'))
    expect(removals.map((r) => [r.kind, r.userId, r.actorId])).toEqual([['kicked', 7, 99]])
    expect(joins).toEqual([7])
  })
})
