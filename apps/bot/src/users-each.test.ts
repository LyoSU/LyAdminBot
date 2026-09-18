import { describe, it, expect } from 'vitest'
import { getUsersEach } from './users-each.js'

describe('getUsersEach', () => {
  it('keeps every resolvable user when one id in a long list cannot be resolved', async () => {
    const ids = Array.from({ length: 10 }, (_, i) => i + 1)
    const fetchOne = async (id: number): Promise<{ id: number } | null> => {
      if (id === 7) throw new Error('Peer 7 is not found in local cache')
      return { id }
    }

    const users = await getUsersEach(fetchOne, ids)
    expect(users).toHaveLength(10)
    expect(users[6]).toBeNull()
    expect(users.filter((u) => u !== null)).toHaveLength(9)
  })

  it('keeps a user the server omitted as null in its own slot', async () => {
    const users = await getUsersEach(async (id) => (id === 2 ? null : { id }), [1, 2, 3])
    expect(users).toEqual([{ id: 1 }, null, { id: 3 }])
  })
})
