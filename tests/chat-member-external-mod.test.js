// Regression coverage for handlers/chat-member.js external-moderation mirror.
// Pins:
//   - human admin ban writes to User.crossChat + ModLog
//   - bot actor (our bot or any other) is ignored
//   - unban pulls chatId from bannedInChats (current state)
//   - distinctAdminsBanned is monotonic (not pulled on unban)
//   - ban while restricted clears restrictedInChats (ban supersedes)
//   - bot target (user.is_bot) is ignored
//
// Uses a hand-rolled mock for ctx.db.User / ctx.db.ModLog that records the
// update operators passed by the handler so we can assert on the shape.

const assert = require('assert')

const handler = require('../handlers/chat-member')

const makeCtx = ({ chatId = -100500, update }) => {
  const userUpdates = []
  const modLogs = []
  return {
    ctx: {
      chat: { id: chatId },
      update: { chat_member: update },
      group: { info: { id: chatId } },
      db: {
        User: {
          updateOne: async (query, op) => {
            userUpdates.push({ query, op })
            return { matchedCount: 1 }
          }
        },
        GroupMember: {
          findOne: async () => null
        },
        ModLog: {
          create: async (doc) => {
            modLogs.push(doc)
            return doc
          }
        }
      }
    },
    userUpdates,
    modLogs
  }
}

const mkMember = (status, userOverrides = {}) => ({
  status,
  user: { id: 777, first_name: 'Target', is_bot: false, ...userOverrides }
})

const mkUpdate = ({
  oldStatus,
  newStatus,
  from = { id: 999, first_name: 'Admin', is_bot: false },
  userOverrides = {},
  date = Math.floor(Date.now() / 1000)
}) => ({
  chat: { id: -100500 },
  from,
  date,
  old_chat_member: mkMember(oldStatus, userOverrides),
  new_chat_member: mkMember(newStatus, userOverrides)
})

;(async () => {
  // Case 1: human admin bans member → record ban.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({ oldStatus: 'member', newStatus: 'kicked' })
    })
    await handler(ctx)
    const op = userUpdates[0]?.op
    assert.ok(op, 'case1: updateOne called')
    assert.strictEqual(op.$addToSet?.['crossChat.bannedInChats'], -100500)
    assert.strictEqual(op.$addToSet?.['crossChat.distinctAdminsBanned'], 999)
    assert.strictEqual(op.$inc?.['crossChat.networkBanCount'], 1)
    assert.ok(op.$set?.['crossChat.lastNetworkBanAt'] instanceof Date)
    assert.strictEqual(modLogs[0]?.eventType, 'external_ban')
    assert.strictEqual(modLogs[0]?.actorId, 999)
    assert.strictEqual(modLogs[0]?.targetId, 777)
  }

  // Case 2: bot actor (our bot) → ignored.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({
        oldStatus: 'member',
        newStatus: 'kicked',
        from: { id: 42, first_name: 'LyAdminBot', is_bot: true }
      })
    })
    await handler(ctx)
    assert.strictEqual(userUpdates.length, 0, 'case2: bot-driven ban must not mirror')
    assert.strictEqual(modLogs.length, 0, 'case2: bot-driven ban must not log')
  }

  // Case 3: unban (kicked → left) pulls chatId but keeps distinctAdminsBanned.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({ oldStatus: 'kicked', newStatus: 'left' })
    })
    await handler(ctx)
    const op = userUpdates[0]?.op
    assert.strictEqual(op.$pull?.['crossChat.bannedInChats'], -100500)
    assert.strictEqual(op.$addToSet, undefined, 'case3: unban must not addToSet admin')
    assert.strictEqual(op.$inc, undefined, 'case3: unban does not increment')
    assert.strictEqual(modLogs[0]?.eventType, 'external_unban')
  }

  // Case 4: restrict → ban (escalation) clears restrictedInChats AND emits
  // TWO ModLog rows — one per transition — so the audit log reflects the
  // full state change, not just the dominant one.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({ oldStatus: 'restricted', newStatus: 'kicked' })
    })
    await handler(ctx)
    const op = userUpdates[0]?.op
    assert.strictEqual(op.$addToSet?.['crossChat.bannedInChats'], -100500)
    assert.strictEqual(op.$pull?.['crossChat.restrictedInChats'], -100500,
      'case4: ban while restricted must clear restrictedInChats')
    const eventTypes = modLogs.map((m) => m.eventType).sort()
    assert.deepStrictEqual(eventTypes, ['external_ban', 'external_unrestrict'].sort(),
      'case4: both ban and unrestrict must be logged — otherwise audit loses half the transition')
  }

  // Case 5: member → restricted → record restrict (not ban).
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({ oldStatus: 'member', newStatus: 'restricted' })
    })
    await handler(ctx)
    const op = userUpdates[0]?.op
    assert.strictEqual(op.$addToSet?.['crossChat.restrictedInChats'], -100500)
    assert.strictEqual(op.$inc?.['crossChat.networkRestrictCount'], 1)
    assert.strictEqual(op.$addToSet?.['crossChat.bannedInChats'], undefined,
      'case5: restrict must not touch bannedInChats')
    assert.strictEqual(modLogs[0]?.eventType, 'external_restrict')
  }

  // Case 6: bot target (user.is_bot=true) → early return, no processing.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({
        oldStatus: 'member',
        newStatus: 'kicked',
        userOverrides: { is_bot: true }
      })
    })
    await handler(ctx)
    assert.strictEqual(userUpdates.length, 0, 'case6: bot target must not mirror')
    assert.strictEqual(modLogs.length, 0)
  }

  // Case 7: noop transition (member → member status-less change) → no writes.
  {
    const { ctx, userUpdates, modLogs } = makeCtx({
      update: mkUpdate({ oldStatus: 'member', newStatus: 'member' })
    })
    await handler(ctx)
    assert.strictEqual(userUpdates.length, 0, 'case7: no state change must not mirror')
    assert.strictEqual(modLogs.length, 0)
  }

  console.log('chat-member external-mod regression: all 7 cases OK')
})().catch((err) => {
  console.error(err)
  process.exit(1)
})
