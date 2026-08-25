import { describe, expect, it } from 'vitest'
import type { Verdict, SignalName } from '@lyadmin/core'
import { callbackData, captchaPrompt, compactNotification, startGroupHint, langPanel, parseCallback, resolveLocale, settingsDeepLink, settingsPanel, topList, userProfileCard, userProfileLines, votePrompt, voterListView, voteResult, VOTERS_SHOWN_MAX, whyCard, whyDeepLink, whyView, welcomeEditor, welcomeTextsScreen, welcomeGifsScreen, extrasEditor, LOCALES, type UserFacts } from './views.js'
import { uk } from './locales/uk.js'

const makeVerdict = (overrides: Partial<Verdict> = {}): Verdict => ({
  pSpam: 0.93, action: 'mute', needsVote: false, banDurationSeconds: null, decidedBy: 'llm',
  ruleId: null, signals: [{ name: 'external_url' }, { name: 'is_reply' }],
  reasonCode: 'job_scam', reasonEvidence: 'оплата щодня', meta: {},
  ...overrides
})

const target = { chatId: -100123, messageId: 7, userId: 42, userLabel: 'Іван' }

describe('compactNotification', () => {
  it('is exactly one line with two buttons', () => {
    const view = compactNotification(uk, makeVerdict(), target)
    expect(view.text).toBe('🔇 мут · <a href="tg://user?id=42">Іван</a>')
    expect(view.text).not.toContain('\n')
    expect(view.buttons[0]).toHaveLength(2)
  })

  it('does not reprint a display name that IS the advert', () => {
    // `promo_in_name` fires on accounts whose name is bought ad space. The
    // notice about the advert used to print the advert — and once names became
    // tappable, it became a link into the advertiser. The id is not the advert,
    // so the mention still resolves.
    const view = compactNotification(uk, makeVerdict({
      signals: [{ name: 'promo_in_name' }]
    }), { ...target, userLabel: 'КУПИ КРИПТУ t.me/x' })
    expect(view.text).not.toContain('КУПИ')
    expect(view.text).not.toContain('t.me')
    expect(view.text).toContain(uk.hiddenName(42))
    expect(view.text).toContain('<a href="tg://user?id=42">')
  })

  it('never contains em-dash or « » (AI-slop markers)', () => {
    for (const action of ['delete', 'mute', 'ban'] as const) {
      const view = compactNotification(uk, makeVerdict({ action }), target)
      expect(view.text).not.toMatch(/—|«|»/)
    }
  })

  it('callback payloads stay within the 64-byte Telegram limit', () => {
    const view = compactNotification(uk, makeVerdict(), {
      chatId: -1001234567890123, messageId: 999999999, userId: 9876543210, userLabel: 'X'
    })
    for (const button of view.buttons.flat()) {
      expect(Buffer.byteLength(button.data ?? '')).toBeLessThanOrEqual(64)
    }
  })

  it('refuses to render non-enforcement verdicts', () => {
    expect(() => compactNotification(uk, makeVerdict({ action: 'observe' }), target)).toThrow()
  })

  it('escapes HTML in the user label (display names are attacker-controlled)', () => {
    const view = compactNotification(uk, makeVerdict(), {
      ...target, userLabel: '<a href="https://evil.example">Іван</a>'
    })
    // The name now lives inside a mention of ours, so the test is no longer
    // "there is no anchor" but "the only anchor is ours".
    expect(view.text).toContain('<a href="tg://user?id=42">')
    expect(view.text).toContain('&lt;a href="https://evil.example"&gt;Іван&lt;/a&gt;')
    expect(view.text).not.toMatch(/<a href="https:\/\/evil/)
  })

  it('names the person as a tappable mention', () => {
    const view = compactNotification(uk, makeVerdict(), target)
    expect(view.text).toContain('<a href="tg://user?id=42">Іван</a>')
  })

  it('without botUsername the why button stays a callback', () => {
    const view = compactNotification(uk, makeVerdict(), target)
    const why = view.buttons[0]![0]!
    expect(why.data).toBe('why:-100123:7')
    expect(why.url).toBeUndefined()
  })

  it('with botUsername the why route moves into the text, leaving one button', () => {
    const view = compactNotification(uk, makeVerdict(), target, { botUsername: 'LyAdminBot' })
    expect(view.text).toContain('<a href="https://t.me/LyAdminBot?start=why_-100123_7_42">за що?</a>')
    expect(view.text).not.toContain('\n') // still one line
    expect(view.buttons[0]).toHaveLength(1)
    expect(view.buttons[0]![0]!.data).toBe('ovr:-100123:7:42')
    // No button may repeat the link — that was the whole point of moving it.
    expect(view.buttons.flat().some((b) => b.url !== undefined)).toBe(false)
  })

  it('the inline link sits after the repeat count, so the run count reads first', () => {
    const view = compactNotification(uk, makeVerdict(), target, { botUsername: 'LyAdminBot', incidentCount: 4 })
    expect(view.text).toMatch(/×4 · <a href=/)
  })

  it('an attacker-controlled name cannot break out into the why link', () => {
    const view = compactNotification(uk, makeVerdict(), {
      ...target, userLabel: '</a><a href="https://evil.example">клац'
    }, { botUsername: 'LyAdminBot' })
    // Two anchors, and both are ours: the mention and the why link.
    expect(view.text.match(/<a href=/g)).toHaveLength(2)
    expect(view.text).toContain('<a href="tg://user?id=42">')
    expect(view.text).toContain('t.me/LyAdminBot?start=why_')
    expect(view.text).not.toMatch(/<a href="https:\/\/evil/)
  })
})

describe('whyDeepLink', () => {
  it('encodes chat/message/user into a start payload', () => {
    expect(whyDeepLink('LyAdminBot', -1001234567890, 555, 42))
      .toBe('https://t.me/LyAdminBot?start=why_-1001234567890_555_42')
  })
})

describe('whyCard', () => {
  it('renders an HTML card and offers override + technical footer for admins', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: true })
    expect(view.text).toContain('93%')
    expect(view.text).toContain('<b>') // verdict line is emphasized
    expect(view.text).toContain('ШІ-аналіз') // technical footer (admins only)
    expect(view.text).toContain('external_url') // raw codes only in footer
    expect(view.buttons[0]![0]!.data).toBe('ovr:-100123:7:42')
  })

  it('omits override button AND technical footer for non-admins', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: false })
    expect(view.buttons).toHaveLength(0)
    expect(view.text).not.toContain('ШІ-аналіз') // no decidedBy jargon
    expect(view.text).not.toContain('external_url') // no raw signal codes
    expect(view.text).toContain('зовнішнє посилання') // humanized instead
  })

  it('wraps the offending message in a blockquote', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: false })
    expect(view.text).toContain('<blockquote>оплата щодня</blockquote>')
  })

  it('does not hand a member the invite it removed', () => {
    // The card is reached from a link in a notice the whole chat reads. A
    // non-admin tapping it used to get the destination, in a PM from the bot.
    const member = whyCard(uk, makeVerdict({ reasonEvidence: 'жми t.me/+AbCd123' }), target, {
      canOverride: false
    })
    expect(member.text).not.toContain('AbCd123')
    expect(member.text).toContain(uk.vote.redacted.invite)

    // The admin is the one asked to judge it, and the message it came from is
    // already deleted by the time they look.
    const admin = whyCard(uk, makeVerdict({ reasonEvidence: 'жми t.me/+AbCd123' }), target, {
      canOverride: true
    })
    expect(admin.text).toContain('AbCd123')
  })

  it('leads with the action and the name, then the evidence, then our verdict', () => {
    const view = whyCard(uk, makeVerdict({ action: 'delete' }), { ...target, userLabel: 'Іван' }, {
      canOverride: true, chatTitle: 'Наш чат'
    })
    const lines = view.text.split('\n').filter((l) => l !== '')
    expect(lines[0]).toBe(`<b>${uk.actions.delete} · <a href="tg://user?id=42">Іван</a></b>`)
    expect(lines[1]).toBe('<i>у чаті Наш чат</i>')
    // Evidence above the confidence line — the reader judges the text first.
    expect(view.text.indexOf('<blockquote>')).toBeLessThan(view.text.indexOf('93%'))
  })

  it('carries the mute duration in the headline (a week is not a minute)', () => {
    const week = whyCard(uk, makeVerdict({ action: 'mute', banDurationSeconds: 7 * 86400 }), target, { canOverride: true })
    expect(week.text.split('\n')[0]).toContain('7д')
    const month = whyCard(uk, makeVerdict({ action: 'mute', banDurationSeconds: 30 * 86400 }), target, { canOverride: true })
    expect(month.text.split('\n')[0]).toContain('1міс')
    // No duration on the verdict → the bare action, never a stray "0".
    const plain = whyCard(uk, makeVerdict({ action: 'mute' }), target, { canOverride: true })
    expect(plain.text.split('\n')[0]).toBe(`<b>${uk.actions.mute} · <a href="tg://user?id=42">Іван</a></b>`)
  })

  it('names the chat only when it was given one', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: false })
    expect(view.text).not.toContain('у чаті')
  })

  it('takes the name from the profile facts when the caller had none', () => {
    const view = whyCard(uk, makeVerdict(), { chatId: -100123, messageId: 7, userId: 42 }, {
      canOverride: false,
      facts: {
        userId: 42, username: 'x', displayName: 'Оксана', predictedAgeDays: null, localAgeDays: null,
        messagesGlobal: 0, groupsActive: 0, reputationStatus: 'neutral', premium: false,
        externalBan: null, joinedAgoSeconds: null, promoInBio: false, personalChannel: false
      }
    })
    expect(view.text.split('\n')[0]).toContain('Оксана')
  })

  it('escapes an attacker-controlled name in the headline', () => {
    const view = whyCard(uk, makeVerdict(), { ...target, userLabel: '<b>x</b>' }, { canOverride: false })
    expect(view.text).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('offers the profile route to admins only (it shows ban history)', () => {
    const admin = whyCard(uk, makeVerdict(), target, { canOverride: true })
    expect(admin.buttons[0]!.map((b) => b.data)).toEqual(['ovr:-100123:7:42', 'prof:-100123:42'])
    const member = whyCard(uk, makeVerdict(), target, { canOverride: false })
    expect(member.buttons).toHaveLength(0)
  })

  it('cuts long evidence without orphaning half an emoji', () => {
    const view = whyCard(uk, makeVerdict({ reasonEvidence: `${'а'.repeat(299)}🙂` }), target, { canOverride: false })
    // A lone surrogate is unencodable and would take the whole card down.
    expect(view.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(view.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('escapes HTML in attacker-controlled evidence', () => {
    const view = whyCard(uk, makeVerdict({ reasonEvidence: '<b>x</b> & <a>' }), target, { canOverride: false })
    expect(view.text).toContain('&lt;b&gt;x&lt;/b&gt; &amp; &lt;a&gt;')
    expect(view.text).not.toContain('<b>x</b>')
  })
})

describe('whyView', () => {
  it('renders plain text (no tags) for the in-group alert toast', () => {
    const text = whyView(uk, makeVerdict())
    expect(text).not.toMatch(/<[a-z]/) // no HTML in the toast surface
    expect(text).toContain('93%')
    expect(text).toContain('шахрайську "вакансію"')
    expect(text).toContain('оплата щодня') // evidence quote is allowed
  })

  it('shows a confidence bucket by pSpam, not a bare percentage', () => {
    expect(whyView(uk, makeVerdict({ pSpam: 0.96 }))).toContain('🔴')
    expect(whyView(uk, makeVerdict({ pSpam: 0.7 }))).toContain('🟠')
    expect(whyView(uk, makeVerdict({ pSpam: 0.4 }))).toContain('🟡')
  })

  it('falls back gracefully for unknown reason codes', () => {
    const text = whyView(uk, makeVerdict({ reasonCode: 'mystery_reason_42' }))
    expect(text).toContain(uk.reasonFallback)
  })

  it('humanizes suspicious signals and hides trust signals + raw codes', () => {
    const text = whyView(uk, makeVerdict())
    expect(text).toContain('зовнішнє посилання') // external_url, humanized
    expect(text).not.toContain('external_url') // never the raw code (no footer)
    expect(text).not.toContain('is_reply') // trust signals excluded
  })

  it('drops unmapped signals from the human list rather than leaking the code', () => {
    const text = whyView(uk, makeVerdict({
      signals: [{ name: 'external_url' }, { name: 'totally_unknown_signal' as SignalName }]
    }))
    expect(text).toContain('зовнішнє посилання')
    expect(text).not.toContain('totally_unknown_signal')
  })
})

describe('userProfileLines', () => {
  const facts = (over: Partial<UserFacts> = {}): UserFacts => ({
    userId: 7856024228, username: 'verdont_luna', displayName: 'Місяць', predictedAgeDays: 800, localAgeDays: 0.003,
    messagesGlobal: 26, groupsActive: 8, reputationStatus: 'suspicious', premium: false,
    externalBan: { banned: true, bannedAtDaysAgo: 0.003, offenses: 3 }, joinedAgoSeconds: 240,
    promoInBio: true, personalChannel: false, ...over
  })

  it('renders the LolsBot-style essentials in human language', () => {
    const text = userProfileLines(uk, facts()).join('\n')
    expect(text).toContain('👤')
    expect(text).toContain('@verdont_luna')
    expect(text).toContain('26 повідомлень')
    expect(text).toContain('8 чатів')
    expect(text).toContain('статус: підозрілий') // agrees in gender, unlike "репутація: підозрілий"
    expect(text).toContain('спам-базах')
    expect(text).toContain('промо в біо')
  })

  it('declines the counts it prints (a card that writes "1 чатів" reads as a machine)', () => {
    const line = (m: number, c: number): string =>
      userProfileLines(uk, facts({ messagesGlobal: m, groupsActive: c })).join('\n')
    expect(line(1, 1)).toContain('1 повідомлення · 1 чат')
    expect(line(3, 2)).toContain('3 повідомлення · 2 чати')
    expect(line(26, 8)).toContain('26 повідомлень · 8 чатів')
    // The teens all take the many form, however they end.
    expect(line(11, 21)).toContain('11 повідомлень · 21 чат')
  })

  it('humanizes spans (account ~years, just-joined minutes)', () => {
    const text = userProfileLines(uk, facts({ predictedAgeDays: 800, joinedAgoSeconds: 240 })).join('\n')
    expect(text).toMatch(/акаунт ~2р/)   // 800d ≈ 2 years
    expect(text).toMatch(/у чаті лише 4хв/) // 240s = 4 min
  })

  it('omits ban/join/promo lines when absent', () => {
    const text = userProfileLines(uk, facts({
      externalBan: null, joinedAgoSeconds: null, promoInBio: false, personalChannel: false
    })).join('\n')
    expect(text).not.toContain('спам-базах')
    expect(text).not.toContain('🆕')
    expect(text).not.toContain('⚠️')
  })

  it('REGRESSION: a long-standing member is not filed under risk with a 🆕', () => {
    // The condition used to be "we know the join date at all", so a member of
    // two years was listed among the risk flags beside the external-ban and
    // promo-in-bio lines. Telegram's join date is the one hard tenure fact we
    // have and the card spent it as an accusation (2026-08-20).
    const text = userProfileLines(uk, facts({
      joinedAgoSeconds: 700 * 86400, externalBan: null, promoInBio: false
    })).join('\n')
    expect(text).not.toContain('🆕')
  })

  it('REGRESSION: tenure is not "never seen" when Telegram places them in the chat', () => {
    // `localAgeDays` restarts whenever our own record does, so the card said
    // "never seen" about a present member — and the admin could not see the
    // tenure the verdict had been based on.
    const text = userProfileLines(uk, facts({
      localAgeDays: null, joinedAgoSeconds: 700 * 86400
    })).join('\n')
    expect(text).not.toContain(uk.profile.neverSeen)
    expect(text).toMatch(/1р|2р/)
  })

  it('escapes an attacker-controlled username', () => {
    const text = userProfileLines(uk, facts({ username: '<b>x' }), { html: true }).join('\n')
    expect(text).toContain('&lt;b&gt;x')
    expect(text).not.toContain('<b>x')
  })

  it('shows the override + profile block in the why card for admins', () => {
    const view = whyCard(uk, makeVerdict(), target, { canOverride: true, facts: facts() })
    expect(view.text).toContain('👤')
    expect(view.text).toContain('@verdont_luna')
    expect(view.buttons[0]![0]!.data).toBe('ovr:-100123:7:42')
  })
})

describe('topList', () => {
  const entries = [
    { name: 'Аня', value: 120 },
    { name: 'Богдан', value: 90 },
    { name: 'Влад', value: 30 },
    { name: 'Гліб', value: 5 }
  ]

  it('medals the top three and numbers the rest', () => {
    const view = topList(uk, 'messages', entries)
    expect(view.text).toContain('🥇')
    expect(view.text).toContain('🥈')
    expect(view.text).toContain('🥉')
    expect(view.text).toContain('4.')
    expect(view.text).toContain('Аня')
    expect(view.text).toContain('120')
  })

  it('shows an empty-state line when there is no data', () => {
    const view = topList(uk, 'messages', [])
    expect(view.text).toBe(uk.top.empty)
    expect(view.buttons).toHaveLength(0)
  })

  it('escapes attacker-controlled names', () => {
    const view = topList(uk, 'banan', [{ name: '<b>x</b>', value: 3 }])
    expect(view.text).not.toContain('<b>x</b>') // the name's own tags are escaped
    expect(view.text).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('uses the banan title and unit for the banan board', () => {
    const view = topList(uk, 'banan', entries)
    expect(view.text).toContain(uk.top.titleBanan)
  })
})

describe('locales', () => {
  it('uk and en cover the same reason codes (no missing translations)', () => {
    expect(Object.keys(LOCALES['uk']!.reasons).sort()).toEqual(Object.keys(LOCALES['en']!.reasons).sort())
  })

  it('language names contain no flag emoji', () => {
    for (const locale of Object.values(LOCALES)) {
      expect(locale.languageName).not.toMatch(/[\u{1F1E6}-\u{1F1FF}]/u)
    }
  })

  it('resolveLocale falls back to en and supports uk/ru/be/tr/by', () => {
    expect(resolveLocale('uk').languageName).toBe('Українська')
    expect(resolveLocale('ru').languageName).toBe('Русский')
    expect(resolveLocale('be').languageName).toBe('Беларуская')
    expect(resolveLocale('by').languageName).toBe('Беларуская')
    expect(resolveLocale('tr').languageName).toBe('Türkçe')
    expect(resolveLocale('de').languageName).toBe('English')
    expect(resolveLocale(null).languageName).toBe('English')
  })

  it('all locales expose the same reason codes', () => {
    const reference = Object.keys(LOCALES['en']!.reasons).sort()
    for (const [code, locale] of Object.entries(LOCALES)) {
      expect(Object.keys(locale.reasons).sort(), `locale ${code}`).toEqual(reference)
    }
  })

  it('every locale can show the banana, and it says nothing about muting', () => {
    // The oldest joke in this bot: an admin types a bare `/banan` and holds the
    // banana up, punishing nobody. Restored 2026-08-07 after v2 shipped without
    // it — the branch was gone, so the admin muted themselves instead. A
    // duration anywhere in this string would mean the branch went missing again.
    for (const [code, locale] of Object.entries(LOCALES)) {
      const line = locale.banan.show('Хтось')
      expect(line, `locale ${code}`).toContain('Хтось')
      expect(line, `locale ${code}`).toContain('🍌')
      expect(line, `locale ${code}`).not.toMatch(/\d/)
    }
  })
})

describe('settings', () => {
  it('group settings view is a PM deep link, never a panel', () => {
    const view = settingsDeepLink(uk, 'LyAdminBot', -100123)
    expect(view.buttons[0]?.[0]?.url).toContain('t.me/LyAdminBot?start=settings_-100123')
    expect(view.text).toBe(uk.settings.openInPm)
  })

  it('every panel button carries the target chatId (the panel lives in PM)', () => {
    const view = settingsPanel(uk, -1001234567890, {
      enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true,
      externalBanEnabled: true, bananDefaultSeconds: 300, locale: 'uk'
    })
    const datas = view.buttons.flat().map((b) => b.data ?? '')
    expect(datas.length).toBeGreaterThan(0)
    for (const data of datas) {
      // Root panel routes to the antispam (set:), welcome (wel:) and extras
      // (ext:) handlers — all must carry the target chatId and stay ≤64 bytes.
      expect(data).toMatch(/^(set|wel|ext):-1001234567890:/)
      expect(Buffer.byteLength(data)).toBeLessThanOrEqual(64)
    }
  })

  it('language lives behind its own screen, not inline on the root panel', () => {
    const root = settingsPanel(uk, -100123, {
      enabled: true, preset: 'standard', captchaEnabled: false, votingEnabled: true,
      externalBanEnabled: true, bananDefaultSeconds: 600, locale: 'uk'
    })
    const rootDatas = root.buttons.flat().map((b) => b.data ?? '')
    // The root panel opens the language screen but never sets a language directly.
    expect(rootDatas).toContain('set:-100123:lang_open')
    expect(rootDatas.some((d) => d.startsWith('set:-100123:lang:'))).toBe(false)

    const lang = langPanel(uk, -100123, 'uk')
    const langDatas = lang.buttons.flat().map((b) => b.data ?? '')
    // The sub-screen carries one button per locale plus a back-to-root button.
    for (const code of Object.keys(LOCALES)) {
      expect(langDatas).toContain(`set:-100123:lang:${code}`)
    }
    expect(langDatas).toContain('set:-100123:root')
  })

  it('/check card carries a trust toggle for admins', () => {
    const facts: UserFacts = {
      userId: 42, username: null, displayName: null, predictedAgeDays: null, localAgeDays: null,
      messagesGlobal: 0, groupsActive: 0, reputationStatus: 'neutral', premium: false,
      externalBan: null, joinedAgoSeconds: null, promoInBio: false, personalChannel: false
    }
    const trusted = userProfileCard(uk, facts, { chatId: -100123, isTrusted: true })
    expect(trusted.buttons[0]?.[0]?.data).toBe('tr:-100123:42:0') // already trusted → untrust
    const untrusted = userProfileCard(uk, facts, { chatId: -100123, isTrusted: false })
    expect(untrusted.buttons[0]?.[0]?.data).toBe('tr:-100123:42:1') // not trusted → trust
    expect(userProfileCard(uk, facts).buttons).toEqual([]) // no action context → no button
  })
})

describe('votePrompt', () => {
  it('quotes the text safely, shows live counts, buttons carry vote ids', () => {
    const view = votePrompt(uk, {
      chatId: -100123, messageId: 7, userLabel: '<i>Іра</i>', textPreview: '<b>купи</b> крипту'
    }, { spam: 2, ham: 1, outcome: 'pending' })
    expect(view.text).toContain('&lt;b&gt;купи&lt;/b&gt; крипту')
    expect(view.text).toContain('&lt;i&gt;Іра&lt;/i&gt;')
    expect(view.text).not.toMatch(/—|«|»/)
    const [spamBtn, hamBtn] = view.buttons[0] ?? []
    expect(spamBtn?.data).toBe('vt:-100123:7:s')
    expect(hamBtn?.data).toBe('vt:-100123:7:h')
    expect(spamBtn?.text).toContain('2')
    expect(hamBtn?.text).toContain('1')
    for (const btn of view.buttons.flat()) {
      expect(Buffer.byteLength(btn.data ?? '')).toBeLessThanOrEqual(64)
    }
  })

  it('cuts the quote on a character boundary, not a code unit', () => {
    // The report path has already cut this to 200 CODE POINTS; a second cut at
    // 200 CODE UNITS lands inside a surrogate pair whenever an odd number of
    // units precedes one — here, a single leading letter. The orphan then went
    // through escapeHtml into Telegram HTML, and this spam is mostly emoji.
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'x', textPreview: 'a' + '\u{1F381}'.repeat(200)
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toMatch(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])/)
    expect(view.text).not.toMatch(/(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/)
  })

  it('a message with no words names what it was instead of quoting nothing', () => {
    // Production 2026-08-25: a ballot rendered `""` and collected two spam
    // votes. Emptiness presented as content is not "no text", it is a claim
    // that the message said nothing — and people vote on it regardless.
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: '', media: 'photo'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toContain('""')
    expect(view.text).toContain('світлина')
    expect(view.text).toContain('Іра')
  })

  it('whitespace-only is no text either', () => {
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: '   \n  ', media: 'sticker'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toContain('""')
    expect(view.text).toContain('стікер')
  })

  it('says the plain thing when there was not even an attachment to name', () => {
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: '', media: null
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toContain('""')
    expect(view.text).toContain('без тексту')
  })

  it('names the medium alongside the text, not only instead of it', () => {
    // Reversed 2026-08-25, deliberately. The previous rule ("a caption IS the
    // message") assumed the words carry the offence, and for an advert they do
    // not: the innocuous caption is the half a voter can read, and the picture
    // is the half doing the selling. A ballot that quotes only the caption asks
    // about half the message, and the half it hides is the paid one.
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: 'купи крипту', media: 'photo'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).toContain('купи крипту')
    expect(view.text).toContain('світлина')
  })

  it('quotes the message in a monospace block, so no link in it is tappable', () => {
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: 'рядок один\nрядок два'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    // Real newlines inside the block: `viewHtml` leaves them alone there,
    // because the HTML parser drops a <br> inside a <pre>.
    expect(view.text).toContain('<pre>рядок один\nрядок два</pre>')
  })

  it('redacts destinations out of the quote, naming what each one was', () => {
    // The ballot is a message the bot posts to the whole chat. Quoting a live
    // invite means the bot delivers the spam itself, with its own authority
    // behind it — the one channel a spammer cannot buy.
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра',
      textPreview: 'заходь t.me/+AbCd123 і пиши @cryptoking, деталі example.com/promo'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toContain('AbCd123')
    expect(view.text).not.toContain('cryptoking')
    expect(view.text).not.toContain('example.com')
    expect(view.text).toContain(uk.vote.redacted.invite)
    expect(view.text).toContain(uk.vote.redacted.mention)
    expect(view.text).toContain(uk.vote.redacted.link)
  })

  it('a message that was nothing but a link still reads as a message with text', () => {
    // Redaction replaces, never deletes: otherwise the ballot would claim a
    // link-only advert "had no text" and ask about a medium instead.
    const view = votePrompt(uk, {
      chatId: -1, messageId: 1, userLabel: 'Іра', textPreview: 'https://evil.example/a'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).toContain('<pre>')
    expect(view.text).not.toContain('без тексту')
    expect(view.text).not.toContain('evil.example')
  })

  it('mentions the subject and links the explanation when a bot username is known', () => {
    const view = votePrompt(uk, {
      chatId: -100123, messageId: 7, userId: 42, userLabel: 'Іра', textPreview: 'текст'
    }, { spam: 0, ham: 0, outcome: 'pending' }, { botUsername: 'LyAdminBot' })
    expect(view.text).toContain('<a href="tg://user?id=42">Іра</a>')
    expect(view.text).toContain('start=why_-100123_7_42')
    // The explanation stays a link. The buttons are for the two acts that
    // change state, and nothing else.
    expect(view.buttons.flat()).toHaveLength(2)
    expect(view.buttons.flat().every((b) => b.url === undefined)).toBe(true)
  })

  it('drops the why link rather than pointing it at a verdict that does not exist', () => {
    const view = votePrompt(uk, {
      chatId: -100123, messageId: 7, userId: 42, userLabel: 'Іра', textPreview: 'текст'
    }, { spam: 0, ham: 0, outcome: 'pending' })
    expect(view.text).not.toContain('start=why_')
  })

  it('every locale can ask about a wordless message', () => {
    for (const locale of Object.values(LOCALES)) {
      const view = votePrompt(locale, {
        chatId: -1, messageId: 1, userLabel: 'X', textPreview: '', media: 'voice'
      }, { spam: 0, ham: 0, outcome: 'pending' })
      expect(view.text).not.toContain('""')
      expect(view.text.length).toBeGreaterThan(10)
    }
  })
})

describe('captchaPrompt', () => {
  it('addresses the user, escapes the name, and carries chatId+userId in the button', () => {
    const view = captchaPrompt(uk, {
      chatId: -100123, userId: 42, userLabel: '<b>Іван</b>'
    })
    expect(view.text).not.toContain('<b>Іван')
    expect(view.text).toContain('&lt;b&gt;Іван&lt;/b&gt;')
    expect(view.buttons[0]?.[0]?.data).toBe(callbackData.captcha(-100123, 42))
    expect(parseCallback(callbackData.captcha(-100123, 42))).toEqual({ kind: 'cap', parts: ['-100123', '42'] })
  })
})

describe('parseCallback', () => {
  it('round-trips callback data', () => {
    expect(parseCallback('ovr:-100:7:42')).toEqual({ kind: 'ovr', parts: ['-100', '7', '42'] })
    expect(parseCallback('')).toEqual({ kind: '', parts: [] })
  })
})

describe('welcome editor', () => {
  const chatId = -100500

  it('root shows counts and hides preview when empty', () => {
    const view = welcomeEditor(uk, chatId, { enable: false, textsCount: 0, gifsCount: 0 })
    expect(view.text).toContain('Привітання')
    const labels = view.buttons.flat().map((b) => b.text)
    expect(labels.some((t) => t.includes('👁'))).toBe(false)
  })

  it('root shows a preview button once there is content', () => {
    const view = welcomeEditor(uk, chatId, { enable: true, textsCount: 2, gifsCount: 1 })
    const preview = view.buttons.flat().find((b) => b.text.includes('👁'))
    expect(preview?.data).toBe(callbackData.welcome(chatId, 'preview'))
  })

  it('texts screen lists items with per-index delete callbacks', () => {
    const view = welcomeTextsScreen(uk, chatId, ['hello %name%', 'hi'], 0)
    expect(view.text).toContain('1. hello %name%')
    const del = view.buttons.flat().find((b) => b.data === callbackData.welcome(chatId, 'tdel', '0'))
    expect(del?.text).toBe('1 🗑')
  })

  it('texts screen shows an add button in the empty state', () => {
    const view = welcomeTextsScreen(uk, chatId, [], 0)
    const add = view.buttons.flat().find((b) => b.data === callbackData.welcome(chatId, 'taddc'))
    expect(add).toBeTruthy()
  })

  it('escapes a greeting preview — the editor screen is HTML too', () => {
    // The extras list beside it has always escaped; this one did not. The
    // template is admin-authored, but `viewHtml` parses it as HTML either way,
    // so a stray `<` or a tag cut in half by the 50-character preview took the
    // whole editor screen down rather than just looking odd.
    const view = welcomeTextsScreen(uk, chatId, ['<b>вітаю %name% & друзі'], 0)
    expect(view.text).toContain('&lt;b&gt;')
    expect(view.text).toContain('&amp;')
    expect(view.text).not.toContain('<b>вітаю')
  })

  it('gifs screen paginates past one page', () => {
    const gifs = Array.from({ length: 20 }, (_, i) => `file${i}`)
    const view = welcomeGifsScreen(uk, chatId, gifs, 0)
    const nav = view.buttons.flat().find((b) => b.text === '›')
    expect(nav?.data).toBe(callbackData.welcome(chatId, 'gpage', '1'))
  })
})

describe('extras editor', () => {
  const chatId = -100500

  it('marks media vs text extras and wires delete + max stepper', () => {
    const view = extrasEditor(uk, chatId, [
      { name: 'rules', hasMedia: false },
      { name: 'meme', hasMedia: true }
    ], 3, 0)
    expect(view.text).toContain('📝 #rules')
    expect(view.text).toContain('📎 #meme')
    const inc = view.buttons.flat().find((b) => b.data === callbackData.extras(chatId, 'maxinc'))
    const del0 = view.buttons.flat().find((b) => b.data === callbackData.extras(chatId, 'del', '0'))
    expect(inc?.text).toBe('+')
    expect(del0?.text).toBe('1 🗑')
  })

  it('empty state offers add + back only', () => {
    const view = extrasEditor(uk, chatId, [], 3, 0)
    const add = view.buttons.flat().find((b) => b.data === callbackData.extras(chatId, 'addc'))
    expect(add).toBeTruthy()
  })
})

/**
 * The roster answers a question the counters cannot: was this a real vote?
 * Three taps four minutes apart is a chat reacting; three taps in two seconds
 * is a crew. Names alone do not show that, so the span is part of the view.
 */
describe('voterListView', () => {
  const roster = {
    spam: [
      { userId: 1, label: 'Олег', isAdmin: true, choice: 'spam' as const, changedMind: false },
      { userId: 2, label: 'Марія', isAdmin: false, choice: 'spam' as const, changedMind: false }
    ],
    ham: [
      { userId: 3, label: 'Ігор', isAdmin: false, choice: 'ham' as const, changedMind: true }
    ],
    spanSeconds: 240
  }

  it('names every voter under the side they landed on', () => {
    const text = voterListView(uk, roster)
    expect(text).toContain('Олег')
    expect(text).toContain('Марія')
    expect(text).toContain('Ігор')
  })

  it('marks the admin and the one who changed their mind', () => {
    const text = voterListView(uk, roster)
    expect(text).toContain(uk.vote.voters.adminMark)
    expect(text).toContain(uk.vote.voters.changedMark)
  })

  it('shows how long the voting took', () => {
    expect(voterListView(uk, roster)).toContain(uk.vote.voters.span(`4${uk.profile.units.m}`))
  })

  it('omits the span when no two ballots were timed', () => {
    const text = voterListView(uk, { ...roster, spanSeconds: null })
    expect(text).not.toContain(uk.vote.voters.span(`4${uk.profile.units.m}`))
  })

  it('escapes a name that is trying to be markup', () => {
    const text = voterListView(uk, {
      spam: [{ userId: 1, label: '<b>bold</b>', isAdmin: false, choice: 'spam' as const, changedMind: false }],
      ham: [], spanSeconds: null
    })
    expect(text).toContain('&lt;b&gt;bold&lt;/b&gt;')
    expect(text).not.toContain('<b>bold</b>')
  })

  it('falls back to the id for a ballot cast before names were stored', () => {
    const text = voterListView(uk, {
      spam: [{ userId: 777, label: null, isAdmin: false, choice: 'spam' as const, changedMind: false }],
      ham: [], spanSeconds: null
    })
    expect(text).toContain('777')
  })

  it('stays inside the alert-toast budget for a landslide', () => {
    // The fallback path when ephemeral delivery is unavailable is a 200-char
    // callback alert, so a 40-voter roster must not be produced only to be cut
    // mid-name.
    const many = Array.from({ length: 40 }, (_, i) => ({
      userId: i, label: `Учасник ${i}`, isAdmin: false, choice: 'spam' as const, changedMind: false
    }))
    const text = voterListView(uk, { spam: many, ham: [], spanSeconds: 60 })
    expect(text.length).toBeLessThan(1200)
    expect(text).toContain(uk.vote.voters.more(40 - VOTERS_SHOWN_MAX))
  })

  it('renders without markup for the alert-toast fallback', () => {
    // A callback alert does not parse HTML, so tags would show up literally and
    // an escaped name would read as &lt;b&gt; to the person asking.
    const text = voterListView(uk, {
      spam: [{ userId: 1, label: '<b>bold</b>', isAdmin: false, choice: 'spam' as const, changedMind: false }],
      ham: [], spanSeconds: null
    }, 'text')
    // Our own markup is gone from every heading...
    for (const line of text.split('\n').filter((l) => !l.startsWith(' •'))) {
      expect(line).not.toMatch(/<\/?b>/)
    }
    // ...and a name is passed through as the person typed it, unescaped.
    expect(text).toContain('<b>bold</b>')
    expect(text).not.toContain('&lt;')
  })

  it('says so plainly when nobody voted', () => {
    expect(voterListView(uk, { spam: [], ham: [], spanSeconds: null }))
      .toContain(uk.vote.voters.nobody)
  })
})

describe('resolved vote receipt', () => {
  it('offers the roster behind a button rather than in the text', () => {
    const view = voteResult(uk, { chatId: -100123, messageId: 7 }, 'spam')
    expect(view.text).toBe(uk.vote.resolvedSpam({ who: null, enforcement: null, whyLink: null }))
    expect(view.buttons[0]?.[0]?.data).toBe(callbackData.voters(-100123, 7))
  })

  it('names who the question was about — the receipt replaces the ballot in place', () => {
    const view = voteResult(uk, {
      chatId: -100123, messageId: 7, userId: 42, userLabel: 'Іра'
    }, 'spam', { botUsername: 'LyAdminBot' })
    expect(view.text).toContain('<a href="tg://user?id=42">Іра</a>')
    expect(view.text).toContain('start=why_-100123_7_42')
  })

  it('escapes a subject label that is trying to be markup', () => {
    const view = voteResult(uk, {
      chatId: -1, messageId: 1, userId: 42, userLabel: '<b>Іра</b>'
    }, 'ham')
    expect(view.text).toContain('&lt;b&gt;Іра&lt;/b&gt;')
    expect(view.text.match(/<a href=/g)).toHaveLength(1)
  })

  it('claims only what the enforcement actually managed', () => {
    const both = voteResult(uk, { chatId: -1, messageId: 1 }, 'spam', {
      enforced: { deleted: true, muted: true }
    })
    expect(both.text).toContain(uk.vote.enforcement.done)

    const gone = voteResult(uk, { chatId: -1, messageId: 1 }, 'spam', {
      enforced: { deleted: true, muted: false }
    })
    expect(gone.text).toContain(uk.vote.enforcement.deletedOnly)

    const quiet = voteResult(uk, { chatId: -1, messageId: 1 }, 'spam', {
      enforced: { deleted: false, muted: true }
    })
    expect(quiet.text).toContain(uk.vote.enforcement.mutedOnly)

    // The case the old receipt got wrong: rights lost mid-ballot, message still
    // on screen, author still posting — and "Прибрав." printed anyway.
    const neither = voteResult(uk, { chatId: -1, messageId: 1 }, 'spam', {
      enforced: { deleted: false, muted: false }
    })
    expect(neither.text).toContain(uk.vote.enforcement.failed)
  })

  it('asserts nothing about enforcement when the caller attempted none', () => {
    const view = voteResult(uk, { chatId: -1, messageId: 1 }, 'spam')
    for (const clause of Object.values(uk.vote.enforcement)) {
      expect(view.text).not.toContain(clause)
    }
  })

  it('says less rather than guessing when a restart lost the label', () => {
    const view = voteResult(uk, { chatId: -1, messageId: 1, userId: null, userLabel: null }, 'ham')
    expect(view.text).toBe(uk.vote.resolvedHam({ who: null, whyLink: null }))
  })

  it('keeps the roster payload inside the 64-byte callback limit', () => {
    const data = callbackData.voters(-1002147483647, 999999999)
    expect(Buffer.byteLength(data, 'utf8')).toBeLessThanOrEqual(64)
    expect(parseCallback(data)).toMatchObject({ kind: 'vrs' })
  })
})

describe('audit follow-ups', () => {
  it('a PM panel is stamped with nothing by the view — the app layer does it', () => {
    // The stamp lives in the renderers so every sub-screen gets it and no new
    // screen can forget. The view itself stays pure, which is what makes it
    // testable at all; this test just pins the contract that produces it.
    expect(uk.panelForChat('Наш чат')).toContain('Наш чат')
    expect(uk.panelForChat('Наш чат')).toContain('<b>')
  })

  it('the leaderboard links the names it knows ids for', () => {
    const view = topList(uk, 'messages', [
      { name: 'Іра', value: 10, userId: 42 },
      { name: 'Ігор', value: 9 }
    ])
    expect(view.text).toContain('<a href="tg://user?id=42">Іра</a>')
    // A row whose id we lost is still a row, just not a link.
    expect(view.text).toContain('Ігор')
    expect(view.text.match(/<a href=/g)).toHaveLength(1)
  })

  it('a leaderboard name that is trying to be markup stays escaped', () => {
    const view = topList(uk, 'banan', [{ name: '<b>x</b>', value: 1, userId: 7 }])
    expect(view.text).toContain('&lt;b&gt;x&lt;/b&gt;')
  })

  it('the group help button is a link once the bot knows its own username', () => {
    const linked = startGroupHint(uk, 'LyAdminBot')
    expect(linked.buttons[0]?.[0]?.url).toBe('https://t.me/LyAdminBot?start=help')
    // Before /getMe lands there is nothing to link to, so the callback stays.
    const fallback = startGroupHint(uk)
    expect(fallback.buttons[0]?.[0]?.url).toBeUndefined()
    expect(fallback.buttons[0]?.[0]?.data).toBeDefined()
  })
})

