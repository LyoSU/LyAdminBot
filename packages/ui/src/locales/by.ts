import type { Locale } from '../locale.js'
import { decimal1, groupDigits } from '../format.js'

/**
 * Slavic plural picker: one / few (2-4) / many (5+, and the whole 11-19 teens).
 * The profile line used to read "1 наших чатів" — a count is not a decoration,
 * and a card that misdeclines its own numbers reads as machine output.
 */
const plural = (n: number, one: string, few: string, many: string): string => {
  const mod100 = Math.abs(n) % 100
  const mod10 = mod100 % 10
  if (mod100 >= 11 && mod100 <= 19) return many
  if (mod10 === 1) return one
  if (mod10 >= 2 && mod10 <= 4) return few
  return many
}

/**
 * "толькі што" is already a point in time: "толькі што таму" is not
 * Belarusian. Every "<span> таму" in this file goes through here, so a span
 * under a minute reads as itself wherever an elapsed time is printed.
 */
const NOW = 'толькі што'
const ago = (span: string): string => (span === NOW ? NOW : `${span} таму`)

/** First-seen placeholder: the profile line reads it as a phrase, not a span. */
const NEVER_SEEN = 'упершыню'

export const by: Locale = {
  languageName: 'Беларуская',

  start: {
    privateCard: (name) => [
      `Прывітанне, <b>${name}</b>! 👋`,
      '',
      '🛡 <b>Антыспам для груп.</b>',
      'Лаўлю спам, баню махляроў, чышчу рэкламу.',
      '',
      'Дадай у групу → дай правы адміна → гатова.'
    ].join('\n'),
    liveProof: (chats, spammers, days) =>
      `📊 Зараз абараняю <b>${groupDigits(chats)}</b> ${plural(chats, 'чат', 'чаты', 'чатаў')}: ` +
      `<b>${groupDigits(spammers)}</b> ${plural(spammers, 'спамер заблакаваны', 'спамеры заблакаваны', 'спамераў заблакавана')} за ${days} ${plural(days, 'дзень', 'дні', 'дзён')}.`,
    groupHint: '🛡 Лаўлю спам, баню махляроў.\n<code>/settings</code> для адмінаў · <code>/stats</code> лічбы · <code>/help</code> каманды',
    addToGroupButton: '➕ Дадаць у групу',
    helpButton: '❓ Каманды',
    langButton: '🌐 Мова'
  },
  arrivals: {
    button: '👥 Новыя ўдзельнікі',
    title: '👥 <b>Хто прыйшоў у чат за тыдзень</b>',
    empty: 'За тыдзень бот не заўважыў у гэтым чаце новых удзельнікаў.',
    silent: 'маўчыць',
    spoke: (count) => `паведамленняў: ${count}`,
    suspect: 'уваход разам са спамерам',
    outcomes: {
      removed: 'прыбрана',
      banned_on_record: 'забанена паводле спам-баз',
      banned_carried: 'забанена ў іншым чаце за спам',
      banned_by_admin: 'забанена адмінам',
      gated: 'на праверцы'
    },
    footer: '⚠️ — уваход разам са спамерам і падобны профіль. «🚫 N» баніць удзельніка пад нумарам N.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Забаніць усіх, хто маўчыць (${count})`,
    confirmAll: (count) => `Забаніць <b>${count}</b> ${plural(count, 'навічка, які яшчэ нічога не напісаў', 'навічкоў, якія яшчэ нічога не напісалі', 'навічкоў, якія яшчэ нічога не напісалі')}?`,
    confirmYes: '🚫 Так, забаніць',
    cancel: 'Скасаваць',
    banned: (count) => `Забанена: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>Разам са спамерам ${plural(count, 'прыйшоў', 'прыйшлі', 'прыйшло')} яшчэ ${count} ${plural(count, 'падобны навічок', 'падобныя навічкі', 'падобных навічкоў')}</b>\nСпамер: ${spammer}`,
    hint: 'Падобны профіль, уваход у той самы час, ніводнага паведамлення. Бот нікога не абмяжоўваў — вырашае адмін.',
    banButton: (count) => `🚫 Забаніць ${count}`,
    keepButton: 'Пакінуць',
    banned: (done, total, admin) => `🚫 Забанена ${done} з ${total} ${plural(total, 'навічка', 'навічкоў', 'навічкоў')}, што прыйшлі разам са спамерам · ${admin}`,
    kept: (admin) => `✅ Навічкоў пакінута · ${admin}`,
    expired: 'Гэтая картка ўжо неактуальная.'
  },

  chatActions: {
    button: '🧾 Апошнія дзеянні',
    title: '🧾 <b>Апошнія дзеянні бота ў чаце</b>',
    empty: 'Пакуль пуста: у гэтым чаце бот яшчэ нічога не рабіў.',
    footer: '«За што?» адкрывае доказ і кнопку «Не спам», калі бот памыліўся.'
  },

  ownRestrictions: {
    title: '🧾 <b>Мае рашэнні пра цябе</b>',
    ago,
    endsIn: (span) => `скончыцца праз ${span}`,
    ended: 'ужо скончылася',
    permanent: 'без тэрміну',
    overturned: '↩️ адменена',
    unknownChat: 'чат без назвы',
    footer: [
      'Гэта аўтаматычныя рашэнні бота, а не адміністратараў.',
      'Калі я памыліўся — напішы адміну таго чата: адмін можа адмяніць гэта адным націскам.',
      'Абмежаванні на тэрмін здымаюцца самі.'
    ].join('\n'),
    whyButton: (n) => `За што? · ${n}`
  },

  helpText: [
    '🛡 <b>Што я ўмею</b>',
    'Лаўлю спам і баню махляроў сам. Большасць дзеянняў — кнопкамі, не камандамі.',
    '',
    '<b>Усім:</b>',
    '/report — скарга на спам (у адказ, або /report @нік ці id)',
    '/stats — колькі спаму я ўжо злавіў',
    '/mystats — мая статыстыка · /top, /top_banan — рэйтынгі',
    '/lang — мова',
    '',
    '<b>Адмінам:</b>',
    '/settings — панэль налад (у ПП, далей усё кнопкамі)',
    '/banan /kick /del — мадэрацыя ў адказ',
    '/check — картка карыстальніка з кнопкай даверу · /untrust — зняць давер',
    '/welcome — прывітанне навічкоў · /extra, /extras — трыгеры',
    '',
    'У кожным паведамленні ёсць спасылка <b>за што?</b> — там уся картка рашэння. Адмінам яшчэ і <b>[✅ Не спам]</b>: адмяняе рашэнне і дадае чалавека ў даверныя чата.'
  ].join('\n'),

  writeFailed: '⚠️ Не збярог — спрабуй яшчэ раз.',
  hiddenName: (userId) => `карыстальнік ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Група: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Выберы мову:',
    saved: 'Гатова, цяпер па-беларуску',
    openInPm: 'Сваю мову выбераш у прыватным чаце з ботам — націсні кнопку.',
    openButton: '🌐 Выбраць мову'
  },

  commands: {
    start: 'Пачаць працу з ботам',
    help: 'Дапамога і каманды',
    lang: 'Выбраць мову',
    mystats: 'Мая статыстыка',
    stats: 'Колькі спаму я ўжо злавіў',
    report: 'Паскардзіцца на спам (у адказ)',
    settings: 'Налады антыспаму (адміны)',
    banan: 'Мут у адказ (/banan 5m)',
    kick: 'Выгнаць удзельніка (у адказ)',
    del: 'Выдаліць паведамленне (у адказ)',
    untrust: 'Зняць давер (у адказ)',
    check: 'Праверыць профіль (у адказ)',
    top: 'Топ актыўных удзельнікаў',
    topBanan: 'Топ па бананах',
    extras: 'Захаваныя трыгеры',
    welcome: 'Прывітанне навічкоў',
    ping: 'Праверыць, ці бот жывы'
  },

  actions: {
    captcha: '👋 праверка',
    delete: '🧹 паведамленне выдалена',
    kick: '🚪 выгнана з чата',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за што?',
    whyButton: 'ℹ️ За што?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Скасавана: абмежаванне знята, акаўнт цяпер у даверных гэтага чата.',
    overridePartial: '⚠️ Скасавана не цалкам: не ўдалося зняць абмежаванне ці дадаць у даверныя. Правер мае правы і націсні яшчэ раз.',
    overrideAlreadyDone: 'Ужо скасавана.',
    adminOnly: 'Толькі для адмінаў гэтага чата.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` За суткі так ${plural(accounts, 'застаўся', 'засталося', 'засталося')} ${accounts} ${plural(accounts, 'акаўнт', 'акаўнты', 'акаўнтаў')}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Спам выдаляю, але саміх спамераў прыбраць не магу — няма права «Блакаваць карыстальнікаў».${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Спамераў блакую, але іх паведамленні выдаліць не магу — няма права «Выдаляць паведамленні».'
      }
      return `⚠️ Знайшоў спам, але не маю правоў нічога зрабіць. Дай мне правы «Выдаляць паведамленні» і «Блакаваць карыстальнікаў».${left}`
    }
  },

  reasons: {
    job_scam: 'падобна на махлярскую прапанову працы',
    crypto_scam: 'крыптамахлярства',
    gambling_promo: 'рэклама казіно ці ставак',
    adult_promo: 'рэклама 18+',
    ad_network: 'продаж рэкламы і размяшчэнняў',
    flirt_bait: 'флірт-прынада',
    phishing: 'фішынгавая спасылка',
    channel_promo: 'непрошаная рэклама канала',
    guest_bot_promo: 'рэклама праз бота, выкліканага згадкай',
    flood: 'флуд або масавая рассылка',
    prompt_injection: 'спроба абысці антыспам-праверку',
    other_spam: 'спам',
    known_spam_signature: 'супадзенне з пацверджаным спамам',
    semantic_spam_match: 'вельмі падобна на вядомы спам',
    velocity_exceeded: 'тое самае паведамленне ў некалькіх чатах запар',
    custom_deny: 'забаронена правілам чата',
    scam_flag_new: 'Telegram пазначыў акаўнт як махлярскі',
    external_ban_new: 'акаўнт у спам-базах',
    shared_profile_photo: 'тое ж фота профілю яшчэ на некалькіх акаўнтах',
    external_high_factor_new: 'акаўнт у спам-базах',
    edit_injected_promo: 'рэкламу дададзена падчас рэдагавання',
    edit_injected_invisibles: 'нябачныя сімвалы дададзены падчас рэдагавання',
    private_invite_new: 'запрашэнне ў закрыты чат ад новага акаўнта',
    identity_churn_promo: 'частая змена імя і рэклама',
    nsfw_promo_profile: 'профіль працуе як рэклама: адкрытыя фота ці відэа і канал у профілі',
    hidden_url_new: 'схаваная спасылка ад навічка',
    low_information: 'недастаткова інфармацыі — пакуль толькі назіранне',
    low_information_profile: 'мала тэксту, але профіль падазроны',
    low_information_profile_unreachable: 'профіль падазроны, але праверку даслаць не ўдалося — пакуль толькі назіранне',
    reported_unreachable: 'на акаўнт паскардзіліся, а праверку даслаць не ўдалося — абмежавана на гадзіну',
    profile_farm_unreachable: 'рэклама проста ў фота профілю, а праверку даслаць не ўдалося — абмежавана на гадзіну',
    content_unconfirmed: 'профіль падазроны, але сам тэкст як спам не пацверджаны',
    admin_report: 'скарга адміна: спам',
    trusted_report: 'скарга даверанага ўдзельніка: спам',
    community_vote: 'супольнасць прагаласавала: спам',
    forward_blacklist: 'пераслана з вядомай спам-крыніцы',
    record_ban_elsewhere: 'акаўнт ужо забанены ў іншым чаце праз спам-базы ці пазнаку Telegram — тут забанены яшчэ да першага паведамлення',
    content_ban_elsewhere: 'акаўнт забанены ў іншым чаце за спам — тут забанены яшчэ да першага паведамлення',
    listed_arrival: 'пры ўваходзе: акаўнт у спам-базах або пазначаны Telegram',
    arrival_look: 'навічок маўчыць, а профіль падобны на спам-сетку',
    arrived_with_spammer: 'уваход разам са спамерам, падобны профіль — забаніў адмін',
    admin_arrival_ban: 'забанена адмінам са спісу новых удзельнікаў'
  },
  reasonFallback: 'падазроная актыўнасць',

  why: {
    title: '🛡 Бот толькі назірае',
    inChat: (chatTitle) => `у чаце ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Вельмі падобна на спам · ацэнка бота ${percent}%`,
      medium: (percent) => `🟠 Імаверна спам · ацэнка бота ${percent}%`,
      low: (percent) => `🟡 Магчыма спам · ацэнка бота ${percent}%`
    },
    noticedTitle: 'Што я заўважыў:',
    profileReuseEvidence: (accounts) =>
      `тое ж фота профілю яшчэ на ${accounts} ${plural(accounts, 'акаўнце', 'акаўнтах', 'акаўнтах')}`,
    profileMediaEvidence: (score) => `адкрытае фота ў профілі · ацэнка ${score}`,
    externalBanEvidence: (sources, when) => [
      'у спам-базах',
      ...(sources > 1 ? [`${sources} ${plural(sources, 'крыніца', 'крыніцы', 'крыніц')}`] : []),
      ...(when ? [ago(when)] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'акаўнт у спам-базах',
      external_repeat_offender: 'некалькі разоў у спам-базах',
      fresh_external_ban: 'нядаўна ў спам-базах',
      many_shared_chats: 'адразу ў многіх нашых чатах',
      promo_in_bio: 'рэкламная спасылка ў біо',
      private_invite_in_bio: 'запрашэнне ў закрыты канал у біо',
      contact_in_bio: 'кантакт па-за Telegram у біо',
      personal_channel: 'канал прывязаны да профілю',
      promo_in_linked_channel: 'у канале з профілю — рэклама',
      promo_in_message_link: 'спасылка вядзе на рэкламны канал',
      restricted_for_spam: 'Telegram абмежаваў за спам',
      just_joined: 'піша адразу пасля ўваходу ў чат',
      joined_during_surge: 'уваход падчас наплыву новых удзельнікаў',
      arrived_with_spammer: 'уваход у чат разам са спамерам, падобны профіль',
      scam_flag: 'Telegram пазначыў акаўнт як махлярскі',
      fake_flag: 'Telegram пазначыў акаўнт як фэйкавы',
      restricted_flag: 'акаўнт абмежаваны Telegram',
      sleeper_awakened: 'даўно неактыўны акаўнт раптам пачаў пісаць',
      fresh_account: 'акаўнт можа быць зусім новы',
      new_globally: 'новы ў нашых чатах',
      new_in_chat: 'новы ў гэтым чаце',
      identity_churn_24h: 'частая змена імя ці фота профілю',
      avatar_recently_set: 'фота профілю пастаўлена гэтымі днямі',
      prior_spam_detections: 'ад акаўнта ўжо быў спам раней',
      unofficial_client_risk: 'дасланае з неафіцыйнага дадатку',
      forward_hidden_user: 'пераслана ад аўтара, які схаваў свой профіль',
      forward_source_suspicious: 'пераслана з падазронай крыніцы',
      hidden_url: 'замаскіраваная спасылка',
      external_url: 'знешняя спасылка',
      url_shortener: 'скарочаная спасылка',
      private_invite_link: 'запрашэнне ў закрыты чат',
      bot_deeplink: 'спасылка, якая запускае бота',
      messenger_contact_link: 'кантакт у іншым месенджары',
      many_url_buttons: 'некалькі кнопак са спасылкамі',
      phone_number: 'нумар тэлефона',
      cashtag: 'згадка манеты ці акцыі праз $',
      long_text: 'доўгі тэкст',
      invisible_in_word: 'нябачныя сімвалы ўнутры слоў',
      mixed_script_word: 'літары розных алфавітаў у адным слове',
      greek_homoglyph_word: 'грэчаскія літары замест падобных на іх у слове',
      foreign_script: 'напісана незвычным для чата пісьмом',
      custom_emoji_heavy: 'шмат прэміум-эмодзі',
      paid_media: 'платны медыякантэнт',
      giveaway_media: 'розыгрыш',
      story_share: 'перасланая гісторыя',
      unknown_media: 'нераспазнанае ўкладанне',
      guest_bot_delivery: 'даслана праз бота, выкліканага згадкай',
      edited_message: 'паведамленне адрэдагавана',
      edit_injected_invisibles: 'нябачныя сімвалы дададзены падчас рэдагавання',
      edit_injected_link: 'спасылку дададзена падчас рэдагавання',
      moderation_flagged: '18+ у тэксце або фота',
      sole_avatar_replaced: 'стары акаўнт, адзінае фота профілю пастаўлена нядаўна',
      avatar_shared_with_account: 'тое ж фота профілю яшчэ на адным акаўнце',
      avatar_shared_with_accounts: 'тое ж фота профілю на некалькіх акаўнтах',
      nsfw_avatar: '18+ у фота профілю',
      suggestive_profile_media: 'паўадкрытае фота ці відэа ў профілі',
      nsfw_stories: '18+ у гісторыях',
      nsfw_linked_channel: '18+ у фота канала з профілю',
      promo_in_name: 'рэклама ў імені акаўнта',
      invisible_in_name: 'нябачныя сімвалы ў імені',
      signature_candidate_match: 'падобна на вядомы спам',
      vector_similar_spam: 'па змесце падобна на вядомы спам',
      velocity_repeats: 'той самы тэкст паўтараецца',
      velocity_wave: 'той самы тэкст з некалькіх акаўнтаў',
      bot_mention: 'згадка бота',
      sender_burst: 'серыя паведамленняў ад аднаго акаўнта',
      burst_grey_repeat: 'некалькі паведамленняў серыі ўжо выглядалі падазрона'
    },
    decidedBy: {
      custom_rule: 'правіла чата',
      deterministic: 'жорсткае правіла',
      signature: 'база сігнатур',
      vector: 'семантычны пошук',
      forward: 'чорны спіс крыніц перасылкі',
      velocity: 'рассылка па некалькіх чатах',
      moderation: 'мадэрацыя кантэнту',
      llm: 'ШІ-аналіз',
      llm_cached: 'ШІ-аналіз (кэш)',
      session: 'аналіз серыі паведамленняў',
      burst: 'аналіз серыі ад аднаго акаўнта',
      score: 'сума сігналаў',
      abstain: 'без рашэння',
      error: 'памылка'
    },
    expired: 'Дэталі гэтага рашэння больш не захоўваюцца.',
    appeal: 'Калі гэта памылка — напішы адміну гэтага чата: адмін можа адмяніць рашэнне.'
  },

  profile: {
    title: '👤 Профіль',
    openButton: '👤 Профіль',
    accountAge: (age) => `акаўнт ${age}`,
    // "вядомы боту <span>" agrees with the "акаўнт" that opens the line; a span
    // under a minute is a first sighting too, and "вядомы боту толькі што" is not.
    firstSeen: (seen) => (seen === NEVER_SEEN || seen === NOW ? 'бот бачыць упершыню' : `вядомы боту ${seen}`),
    activity: (messages, chats) =>
      [
        ...(messages === null ? [] : [`${messages} ${plural(messages, 'паведамленне', 'паведамленні', 'паведамленняў')}`]),
        `${chats} ${plural(chats, 'чат', 'чаты', 'чатаў')}`
      ].join(' · '),
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (when, offenses) => [
      'у спам-базах',
      ...(when ? [`бан ${ago(when)}`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'парушэнне', 'парушэнні', 'парушэнняў')}`] : [])
    ].join(' · '),
    justJoined: (span) => (span === NOW ? 'у чаце толькі што' : `у чаце ўсяго ${span}`),
    promoInBio: 'рэклама ў біо',
    personalChannel: 'прывязаны канал',
    unknownAge: 'невядомага ўзросту',
    neverSeen: NEVER_SEEN,
    units: { now: NOW, m: 'хв', h: 'гадз', d: 'д', mo: 'мес', y: 'г' },
    checkNeedReply: 'Зрабі /check адказам на паведамленне карыстальніка.',
    notFound: 'Не ўдалося атрымаць профіль.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Гэта спам?</b> Аўтар: ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Гэта спам?</b> Аўтар: ${userLabel} · без тэксту, толькі ${what}`
        : `🤔 <b>Гэта спам?</b> Аўтар: ${userLabel} · без тэксту`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'фота', sticker: 'стыкер', video: 'відэа',
      voice: 'галасавое ці аўдыя', file: 'файл', other: 'укладанне'
    },
    redacted: { link: '[спасылка]', mention: '[@згадка]', invite: '[запрашэнне]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `✅ Не спам (${count})`,
    counted: 'Голас залічаны.',
    enforcement: {
      done: 'Выдалена, аўтара абмежавана.',
      deletedOnly: 'Выдалена, але абмежаваць аўтара не ўдалося.',
      mutedOnly: 'Аўтара абмежавана, але выдаліць паведамленне не ўдалося.',
      failed: '⚠️ Не ўдалося ні выдаліць паведамленне, ні абмежаваць аўтара.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      // The name follows a "·", never "ад": a display name cannot be declined.
      '🗑 Супольнасць вырашыла: спам' + (who ? ` · ${who}` : '')
      + (enforcement ? `. ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      '✅ Супольнасць вырашыла: не спам' + (who ? ` · ${who}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Галасаванне ўжо закрыта.',
    voters: {
      button: '👥 Хто галасаваў',
      title: (spam, ham) => `👥 <b>Галасаванне</b> · спам ${spam} : ${ham} не спам`,
      spamGroup: '🗑 Спам',
      hamGroup: '✅ Не спам',
      adminMark: 'адмін',
      changedMark: 'голас зменены',
      span: (span) => (span === NOW ? '⏱ усе галасы — менш чым за хвіліну' : `⏱ ад першага да апошняга голасу: ${span}`),
      more: (count) => `…і яшчэ ${count}`,
      nobody: 'Ніхто не паспеў прагаласаваць.',
      notForTarget: 'Гэта галасаванне пра цябе: у ім ты не галасуеш і не бачыш, хто галасаваў.',
      noStanding: 'Голас не залічаны: галасуюць тыя, хто ў чаце не менш за тыдзень і напісаў тут ад 10 паведамленняў (або ад 50 ва ўсіх чатах з ботам), ці хто ў чаце больш за год.',
      knownBad: 'Голас не залічаны: з гэтага акаўнта ўжо прыходзіў спам.'
    }
  },

  report: {
    needReply: 'Зрабі /report адказам на паведамленне або пазнач чалавека: /report @нік, /report 123456789, ці абяры яго праз @ са спісу.',
    notFound: (who) => `Не знайшоў у гэтым чаце: ${who}. Адкажы на паведамленне гэтага чалавека або абяры яго праз @ са спісу.`,
    notInChat: 'Гэтага чалавека ўжо няма ў чаце.',
    cantReportAdmin: 'На адмінаў скардзіцца нельга.',
    rateLimited: 'Зашмат скаргаў. Пачакай некалькі хвілін.',
    accepted: 'Прыняў, дзякуй.',
    oneAtATime: 'Тут зайшло некалькі чалавек адразу. Адкажы на паведамленне таго, на каго скардзішся.',
    voteClosed: 'Галасаванне па гэтым паведамленні ўжо закрытае. Вырашыць можа адмін.',
    channelSender: 'Гэта напісана ад імя канала. Заблакаваць канал можа толькі адмін.'
  },

  botStats: {
    title: '🛡 <b>Што я ўжо зрабіў</b>',
    window: (days) => `За ${plural(days, 'апошні', 'апошнія', 'апошнія')} ${days} ${plural(days, 'дзень', 'дні', 'дзён')}:`,
    checked: (count) => `📬 <b>${groupDigits(count)}</b> ${plural(count, 'праверанае паведамленне', 'правераныя паведамленні', 'правераных паведамленняў')}`,
    spammers: (count) => `🚫 <b>${groupDigits(count)}</b> ${plural(count, 'спамер заблакаваны', 'спамеры заблакаваны', 'спамераў заблакавана')}`,
    chats: (count) => `💬 <b>${groupDigits(count)}</b> ${plural(count, 'чат пад аховай', 'чаты пад аховай', 'чатаў пад аховай')}`,
    speed: (ms) => `⚡ рашэнне за <b>${groupDigits(ms)} мс</b>`,
    quiet: (percent) => `<b>${decimal1(percent)}%</b> паведамленняў я не крануў. Пакуль спаму няма, мяне не чуваць.`,
    reasonsTitle: '<b>Найчасцей лаўлю:</b>',
    reasonLine: (name, count) => `• ${name} — ${groupDigits(count)}`,
    memory: (signatures) => `🧠 У памяці ${groupDigits(signatures)} ${plural(signatures, 'сігнатура', 'сігнатуры', 'сігнатур')} спаму`,
    corrections: (percent) => `✅ Адміны скасавалі ${decimal1(percent)}% маіх рашэнняў`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> за ${days} ${plural(days, 'дзень', 'дні', 'дзён')}`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${groupDigits(checked)} праверана · 🚫 ${groupDigits(spammers)} ${plural(spammers, 'спамер', 'спамеры', 'спамераў')} · 🧹 ${groupDigits(deletes)} выдалена`,
    chatLastSpam: (span) => `Апошні спам: ${ago(span)}`,
    chatClean: '✨ За гэты час бот не выявіў спаму.',
    unavailable: '📊 Лічбы зараз недаступныя, паспрабуй крыху пазней.',
    button: '📊 Статыстыка бота'
  },

  stats: {
    title: '📊 <b>Твая статыстыка</b>',
    inChat: (count, chatTitle) => chatTitle ? `Паведамленняў у чаце ${chatTitle}: ${count}` : `Паведамленняў у гэтым чаце: ${count}`,
    global: (count) => `Паведамленняў ва ўсіх чатах: ${count}`,
    reputation: (score, status) => `Рэпутацыя: ${score} (${status})`,
    repStatus: { trusted: 'надзейны', neutral: 'нейтральны', suspicious: 'падазроны', restricted: 'абмежаваны' },
    bananCaught: (count) => `Бананаў атрымана: ${count} 🍌`,
    openInPm: 'Твая статыстыка — у прыватным чаце з ботам, націсні кнопку.',
    openButton: '📊 Мая статыстыка'
  },

  top: {
    titleMessages: '🏆 <b>Самыя актыўныя ў чаце</b>',
    titleBanan: '🍌 <b>Топ па бананах</b>',
    empty: 'Пакуль няма статыстыкі.',
    messagesUnit: (count) => plural(count, 'паведамленне', 'паведамленні', 'паведамленняў'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} больш не ў чаце.`,
    needReply: 'Зрабі /kick адказам на паведамленне таго, каго хочаш выгнаць.'
  },

  untrust: {
    success: (name) => `🔓 Давер зняты: ${name}. Паведамленні зноў праходзяць праверку.`,
    needReply: 'Зрабі /untrust адказам на паведамленне таго, з каго хочаш зняць давер.',
    notTrusted: (name) => `ℹ️ ${name} не ў спісе даверных — няма чаго здымаць.`
  },

  trust: {
    button: '✅ Давяраць',
    untrustButton: '🔓 Зняць давер',
    added: 'Дадаў у даверныя гэтага чата.',
    removed: 'Зняў давер.',
    grantedBy: (who, span, via) =>
      `✅ Давер ад ${who}, ${ago(span)}` +
      (via === 'override' ? ' · адмена рашэння бота' : via === 'vote' ? ' · голас адміна' : ''),
    grantUnknown: '✅ Ёсць давер · ад каго і калі — не запісана'
  },

  welcome: {
    enabled: '👋 Прывітанні ўключаны.',
    disabled: '👋 Прывітанні выключаны.',
    textSet: '✅ Тэкст прывітання захаваны. Падстаноўка %name% працуе.',
    gifSet: '✅ Медыя для прывітання захавана.',
    usage: [
      '/welcome — уключыць/выключыць',
      '/welcome <тэкст з %name%> — задаць прывітанне',
      'адказ гіфкай на /welcome — задаць гіфку'
    ].join('\n'),
    limit: '⚠️ Больш дадаць нельга: ліміт вычарпаны. Спачатку выдалі нешта ў наладах.',
    duplicate: 'ℹ️ Гэта ўжо дададзена.',
    tooLong: '⚠️ Тэкст занадта доўгі (макс. 1000 сімвалаў).',
    saveFailed: '⚠️ Не ўдалося захаваць.',
    surgeAlert: (count, riskCount) => `⚠️ Наплыў навічкоў: ${count} ${plural(count, 'удзельнік', 'удзельнікі', 'удзельнікаў')}, з іх ${riskCount} ${plural(riskCount, 'падазроны', 'падазроныя', 'падазроных')}`,
    defaultGreeting: (name) => `👋 Вітаем, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Прывітанне навічкоў</b>\n\nСтан: ${state}\nТэкстаў: ${nTexts} · Гіфак: ${nGifs}\n\nКалі іх некалькі — бот штораз бярэ выпадковы.`,
      enable: '🔔 Уключыць',
      disable: '🔕 Выключыць',
      texts: (n) => `📝 Тэксты (${n})`,
      gifs: (n) => `🎞 Медыя (${n})`,
      preview: '👁 Прагляд',
      textsTitle: (n, max) => `📝 <b>Тэксты прывітання</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тэксты прывітання</b>\n\nПакуль пуста. Дадай першы — можна з <code>%name%</code> для імя навічка.',
      addText: '➕ Дадаць тэкст',
      gifsTitle: (n, max) => `🎞 <b>Медыя для прывітання</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 медыя #${i}`,
      gifsEmpty: '🎞 <b>Медыя для прывітання</b>\n\nПакуль пуста. Дашлі гіфку, відэа ці фота.',
      addGif: '➕ Дадаць медыя',
      promptText: '📝 Дашлі тэкст прывітання адным паведамленнем.\nМожна ўставіць <code>%name%</code> — падстаўлю імя навічка.\n\n/cancel — скасаваць.',
      promptGif: '🎞 Дашлі гіфку, відэа ці фота адным паведамленнем.\n\n/cancel — скасаваць.',
      added: '✅ Дададзена.',
      cancelled: '↩️ Скасавана.',
      invalidGif: '⚠️ Тут патрэбна гіфка, відэа ці фота — дашлі нешта адно з іх.',
      removed: '🗑 Выдалена.',
      removeMissing: 'Гэтага ўжо няма — абнавіў спіс.',
      expired: '⌛ Час выйшаў. Адкрый рэдактар яшчэ раз.',
      previewEmpty: 'Пакуль няма чаго паказаць — дадай тэкст, гіфку, відэа ці фота.'
    }
  },

  extra: {
    saved: (name) => `✅ Захавана #${name}`,
    deleted: (name) => `🗑 Выдалена #${name}`,
    notFound: (name) => `Няма такога: #${name}`,
    usage: [
      '/extra назва (у адказ на паведамленне) — захаваю яго пад #назва',
      '/extra назва (без адказу) — выдалю трыгер'
    ].join('\n'),
    listTitle: '📂 Захаваныя трыгеры:',
    listEmpty: 'Тут пакуль няма трыгераў.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Трыгеры</b> (${n})\n\nНапішы <code>#назва</code> ў чаце — бот дашле захаванае.\nЛіміт адказаў на адно паведамленне: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Трыгеры</b>\n\nПакуль пуста. Дадай першы — назва + тэкст ці медыя.',
      add: '➕ Дадаць трыгер',
      maxLabel: (n) => `Ліміт: ${n}`,
      promptName: '#️⃣ Увядзі назву трыгера (без #), адным словам.\n\n/cancel — скасаваць.',
      promptContent: (name) => `Цяпер дашлі, чым бот будзе адказваць на <code>#${name}</code>: тэкст, гіфку, фота ці відэа.\n\n/cancel — скасаваць.`,
      added: (name) => `✅ Трыгер #${name} захаваны.`,
      cancelled: '↩️ Скасавана.',
      invalidName: '⚠️ Назва — адно слова: літары, лічбы або _, без прабелаў.',
      removed: '🗑 Выдалена.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} атрымлівае банан на ${duration}`,
    lifted: (name) => `🍌 ${name} пазбаўляецца банана`,
    self: (name, duration) => `🍌 ${name} бярэ сабе банан на ${duration}. Паважаю`,
    needReply: 'Зрабі /banan адказам на паведамленне, або /banan без рэплая для сябе.',
    undoButton: '↩️ Скасаваць',
    units: { m: 'хв', h: 'гадз', d: 'дн' },
    show: (name) => `🍌 ${name} паказвае банан`
  },

  captcha: {
    prompt: (name, minutes) =>
      `👋 ${name}, націсні кнопку${minutes === undefined ? '' : ` на працягу ${minutes} хв`} і пішы далей. Гэта хуткая праверка, што ты не бот.`,
    button: '🙋 Я чалавек',
    passed: 'Гатова, пішы.',
    retry: 'Не ўдалося зняць абмежаванне. Націсні яшчэ раз.',
    notForYou: 'Гэтая кнопка для іншага ўдзельніка.'
  },

  settings: {
    openInPm: 'Налады — у прыватным чаце з ботам, націсні кнопку.',
    openInPmButton: '⚙️ Адкрыць налады',
    title: '⚙️ <b>Налады антыспаму</b>',
    preset: 'Рэжым',
    presets: { soft: 'Мяккі', standard: 'Стандартны', strict: 'Строгі' },
    captcha: 'Капча для навічкоў',
    voting: 'Галасаванне супольнасці',
    enabled: 'Антыспам',
    banDatabase: 'Спам-базы',
    quiet: 'Ціхі рэжым',
    quietHint: '🤫 Апавяшчэнні пра ўпэўненыя дзеянні прыходзяць без гуку і кнопак і знікаюць праз 5 с. Усё, што зрабіў бот, — у «🧾 Апошнія дзеянні». Галасаванні застаюцца.',
    banan: 'Працягласць банана',
    language: 'Мова бота ў чаце',
    languageSaved: 'Мову чата абноўлена',
    welcome: '👋 Прывітанне',
    extras: '#️⃣ Трыгеры',
    on: 'Уключана',
    off: 'Выключана',
    back: '‹ Назад'
  }
}
