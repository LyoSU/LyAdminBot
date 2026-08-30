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
      `📊 Зараз трымаю <b>${groupDigits(chats)}</b> ${plural(chats, 'чат', 'чаты', 'чатаў')}: ` +
      `<b>${groupDigits(spammers)}</b> ${plural(spammers, 'спамер заблакаваны', 'спамеры заблакаваны', 'спамераў заблакавана')} за ${days} ${plural(days, 'дзень', 'дні', 'дзён')}.`,
    groupHint: '🛡 Лаўлю спам, баню махляроў.\n<code>/settings</code> для адмінаў · <code>/help</code> каманды',
    addToGroupButton: '➕ Дадаць у групу',
    helpButton: '❓ Каманды',
    langButton: '🌐 Мова'
  },

  helpText: [
    '🛡 <b>Што я ўмею</b>',
    'Лаўлю спам і баню машэннікаў сам. Большасць дзеянняў — кнопкамі, не камандамі.',
    '',
    '<b>Усім:</b>',
    '/report — скарга на спам (у адказ)',
    '/stats — колькі спаму я ўжо злавіў',
    '/mystats — мая статыстыка · /top, /top_banan — рэйтынгі',
    '/lang — мова',
    '',
    '<b>Адмінам:</b>',
    '/settings — панэль налад (у ПП, далей усё кнопкамі)',
    '/banan /kick /del — мадэрацыя ў адказ',
    '/check — картка карыстальніка з кнопкамі (давер і інш.)',
    '/welcome — прывітанне навічкоў · /extra, /extras — трыгеры',
    '',
    'У кожным паведамленні ёсць спасылка <b>за што?</b> — там уся картка рашэння. Адмінам яшчэ і <b>[✅ Не спам]</b>.'
  ].join('\n'),

  writeFailed: '⚠️ Не збярог — спрабуй яшчэ раз.',
  hiddenName: (userId) => `карыстальнік ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Група: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Выберы мову:',
    saved: 'Гатова, цяпер па-беларуску',
    openInPm: 'Мову для сябе выбереш у асабістых.',
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
    delete: '🧹 спам выдалены',
    kick: '🚪 выдалены з чата',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за што?',
    whyButton: '🤨 За што?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, скасаваў. Юзер разблакаваны і цяпер у даверных гэтага чата.',
    overridePartial: 'Скасаваў, але не ўсё ўдалося застасаваць. Спрабуй яшчэ раз або праверце мае правы.',
    overrideAlreadyDone: 'Ужо скасавана.',
    adminOnly: 'Толькі для адмінаў гэтага чата.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` За суткі так засталося ${accounts} ${plural(accounts, 'акаўнт', 'акаўнты', 'акаўнтаў')}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Спам выдаляю, але самих спамераў прыбраць не магу — няма права «Блакаваць карыстальнікаў».${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Спамераў блакую, але іх паведамленні выдаліць не магу — няма права «Выдаляць паведамленні».'
      }
      return `⚠️ Знайшоў спам, але не маю праў нічога зрабіць. Дайце мне правы «Выдаляць паведамленні» і «Блакаваць карыстальнікаў».${left}`
    }
  },

  reasons: {
    job_scam: 'падобна на махлярскую "вакансію"',
    crypto_scam: 'крыптамахлярства',
    gambling_promo: 'рэклама казіно/ставак',
    adult_promo: 'рэклама 18+',
    ad_network: 'продаж рэкламы/размяшчэнняў',
    flirt_bait: 'флірт-прынада',
    phishing: 'фішынгавая спасылка',
    channel_promo: 'непрошаная рэклама канала',
    guest_bot_promo: 'промо праз гасцявога бота',
    flood: 'флуд/масавая рассылка',
    prompt_injection: 'спроба ашукаць мадэрацыю',
    other_spam: 'спам',
    known_spam_signature: 'супадзенне з пацверджаным спамам',
    semantic_spam_match: 'вельмі падобна на вядомы спам',
    velocity_exceeded: 'тое самае паведамленне ў некалькіх чатах запар',
    custom_deny: 'забаронена правілам чата',
    scam_flag_new: 'Telegram пазначыў акаўнт як махлярскі',
    external_ban_new: 'акаўнт у базах спамераў',
    external_high_factor_new: 'акаўнт у базах спамераў',
    edit_injected_promo: 'у паведамленне адрэдагавана рэклама',
    edit_injected_invisibles: 'нябачныя сімвалы ўстаўлены рэдагаваннем',
    private_invite_new: 'закрытае запрашэнне ад новага акаўнта',
    identity_churn_promo: 'частая змена імя + рэклама',
    nsfw_promo_profile: 'профіль сам зʼяўляецца рэкламай (адкрытае медыя + канал у профілі)',
    hidden_url_new: 'схаваная спасылка ад навічка',
    low_information: 'недастаткова інфармацыі, назіраем',
    low_information_profile: 'мала інфармацыі, але профіль падазроны — просім пацвердзіць',
    content_unconfirmed: 'падазроны профіль, але змест не пацверджаны',
    admin_report: 'адмін зарэпорціў як спам',
    community_vote: 'супольнасць прагаласавала: спам',
    forward_blacklist: 'пераслана з вядомай спам-крыніцы'
  },
  reasonFallback: 'падазроная актыўнасць',

  why: {
    title: '🛡 Чаму я ўмяшаўся',
    inChat: (chatTitle) => `у чаце ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Вельмі падобна на спам · ${percent}%`,
      medium: (percent) => `🟠 Імаверна спам · ${percent}%`,
      low: (percent) => `🟡 Магчыма спам · ${percent}%`
    },
    noticedTitle: 'Што я заўважыў:',
    externalBanEvidence: (sources, ago) => [
      'у спам-базах',
      ...(sources > 1 ? [`${sources} ${plural(sources, 'незалежная крыніца', 'незалежныя крыніцы', 'незалежных крыніц')}`] : []),
      ...(ago ? [`${ago} таму`] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'акаўнт у спам-базах',
      external_repeat_offender: 'некалькі разоў у спам-базах',
      fresh_external_ban: 'нядаўна трапіў у спам-базы',
      many_shared_chats: 'адразу ў многіх нашых чатах',
      promo_in_bio: 'рэкламная спасылка ў біо',
      private_invite_in_bio: 'запрашэнне ў закрыты канал у біо',
      contact_in_bio: 'кантакт па-за Telegram у біо',
      personal_channel: 'канал прывязаны да профілю',
      promo_in_linked_channel: 'канал з профілю рэкламуе сам сябе',
      promo_in_message_link: 'спасылка вядзе на рэкламны канал',
      restricted_for_spam: 'Telegram абмежаваў за спам',
      just_joined: 'толькі зайшоў і адразу піша',
      joined_during_surge: 'далучыўся падчас наплыву новых удзельнікаў',
      scam_flag: 'Telegram пазначыў акаўнт як махлярскі',
      fake_flag: 'Telegram пазначыў акаўнт як фэйкавы',
      restricted_flag: 'акаўнт абмежаваны Telegram',
      sleeper_awakened: 'спячы акаўнт раптам ажыў',
      fresh_account: 'толькі што створаны акаўнт',
      new_globally: 'навічок у Telegram',
      new_in_chat: 'першае паведамленне ў гэтым чаце',
      identity_churn_24h: 'частая змена імя / фота',
      avatar_recently_set: 'аватар пастаўлены толькі што',
      prior_spam_detections: 'раней ужо лавілі на спаме',
      low_reputation: 'нізкая рэпутацыя',
      unofficial_client_risk: 'дасланае з неафіцыйнага дадатку',
      forward_hidden_user: 'пераслана ад схаванага акаўнта',
      forward_source_suspicious: 'пераслана з падазронай крыніцы',
      hidden_url: 'замаскіраваная спасылка',
      external_url: 'знешняя спасылка',
      url_shortener: 'скарочаная спасылка',
      private_invite_link: 'закрытая запрашальная спасылка',
      bot_deeplink: 'спасылка-запуск бота',
      messenger_contact_link: 'кантакт у іншым месенджары',
      many_url_buttons: 'шмат спасылак-кнопак',
      phone_number: 'нумар тэлефона',
      cashtag: 'згадка крыптавалюты / тыкера',
      long_text: 'незвычайна доўгі тэкст',
      invisible_in_word: 'нябачныя сімвалы ўнутры слоў',
      mixed_script_word: 'мешаніна алфавітаў у слове',
      greek_homoglyph_word: 'грэчаскія літары замест падобных на іх у слове',
      foreign_script: 'напісана незвычным для чату пісьмом',
      custom_emoji_heavy: 'шмат кастамных эмодзі',
      paid_media: 'платны медыякантэнт',
      giveaway_media: 'розыгрыш',
      story_share: 'пашыраная сторыс',
      unknown_media: 'нераспазнанае ўкладанне',
      guest_bot_delivery: 'дастаўлена праз гасцявога бота',
      edited_message: 'паведамленне адрэдагавана',
      edit_injected_invisibles: 'нябачныя сімвалы ўстаўлены рэдагаваннем',
      edit_injected_link: 'спасылка дададзена рэдагаваннем',
      moderation_flagged: 'NSFW у тэксце або фота',
      sole_avatar_replaced: 'адзінае фота профілю, пастаўленае нядаўна на старым акаўнце',
      avatar_shared_with_account: 'тое ж фота профілю яшчэ на адным акаўнце',
      avatar_shared_with_accounts: 'тое ж фота профілю на некалькіх акаўнтах',
      nsfw_avatar: 'NSFW на аватарцы',
      suggestive_profile_media: 'адкрытае медыя ў профілі (намёк)',
      nsfw_stories: 'NSFW у сторыс',
      nsfw_linked_channel: 'NSFW на аватарцы канала з профілю',
      promo_in_name: 'рэклама ў імені акаўнта',
      invisible_in_name: 'нябачныя сімвалы ў імені',
      signature_candidate_match: 'падобна на вядомы спам',
      vector_similar_spam: 'семантычна блізка да спаму',
      velocity_repeats: 'той самы тэкст паўтараецца',
      velocity_wave: 'той самы тэкст з некалькіх акаўнтаў',
      bot_mention: 'згадка бота',
      sender_burst: 'серыя паведамленняў ад аднаго акаўнта',
      burst_grey_repeat: 'серыя, дзе некалькі паведамленняў ужо выглядалі падазрона'
    },
    decidedBy: {
      custom_rule: 'правіла чата',
      deterministic: 'дэтэрмінаванае правіла',
      signature: 'база сігнатур',
      vector: 'семантычны пошук',
      forward: 'чорны спіс крыніц форвардаў',
      velocity: 'крос-чатавая хуткасць',
      moderation: 'мадэрацыя кантэнту',
      llm: 'ШІ-аналіз',
      llm_cached: 'ШІ-аналіз (кэш)',
      session: 'аналіз серыі паведамленняў',
      burst: 'аналіз серыі ад аднаго акаўнта',
      score: 'сума сігналаў',
      abstain: 'устрыманне',
      error: 'памылка'
    },
    expired: 'Гэтае рашэнне ўжо састарэла — дэталяў не засталося.'
  },

  profile: {
    title: '👤 Профіль',
    openButton: '👤 Профіль',
    accountAge: (age) => `акаўнт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) =>
      `${messages} ${plural(messages, 'паведамленне', 'паведамленні', 'паведамленняў')} · ${chats} ${plural(chats, 'чат', 'чаты', 'чатаў')}`,
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'у спам-базах',
      ...(ago ? [`бан ${ago} таму`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'парушэнне', 'парушэнні', 'парушэнняў')}`] : [])
    ].join(' · '),
    justJoined: (ago) => `у чаце ўсяго ${ago}`,
    promoInBio: 'промо ў біо',
    personalChannel: 'прывязаны канал',
    unknownAge: 'узрост невядомы',
    neverSeen: 'упершыню',
    units: { now: 'толькі што', m: 'хв', h: 'гадз', d: 'д', mo: 'мес', y: 'г' },
    checkNeedReply: 'Адкажыце камандай /check на паведамленне карыстальніка.',
    notFound: 'Не ўдалося атрымаць профіль.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Гэта спам?</b> Паведамленне ад ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Гэта спам?</b> Паведамленне ад ${userLabel} — без тэксту, толькі ${what}.`
        : `🤔 <b>Гэта спам?</b> Паведамленне ад ${userLabel} — без тэксту.`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'здымак', sticker: 'стыкер', video: 'відэа',
      voice: 'аўдыя', file: 'файл', other: 'укладанне'
    },
    redacted: { link: '[спасылка]', mention: '[@згадка]', invite: '[запрашэнне]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голас залічаны.',
    enforcement: {
      done: 'Прыбраў.',
      deletedOnly: 'Прыбраў, але змоўкнуць не прымусіў — не хапае правоў.',
      mutedOnly: 'Змоўкнуць прымусіў, а паведамленне прыбраць не ўдалося.',
      failed: '⚠️ Ні прыбраць, ні абмежаваць не ўдалося — не хапае правоў.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      (who ? `🗑 Супольнасць вырашыла: паведамленне ад ${who} — спам.` : '🗑 Супольнасць вырашыла: спам.')
      + (enforcement ? ` ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      (who ? `👌 Супольнасць вырашыла: паведамленне ад ${who} — не спам.` : '👌 Супольнасць вырашыла: не спам.')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Галасаванне ўжо закрыта.',
    voters: {
      button: '👥 Хто галасаваў',
      title: (spam, ham) => `👥 <b>Галасаванне</b> · спам ${spam} : ${ham} норм`,
      spamGroup: '🗑 Спам',
      hamGroup: '👌 Норм',
      adminMark: 'адмін',
      changedMark: 'змяніў голас',
      span: (span) => `⏱ ад першага да апошняга голасу: ${span}`,
      more: (count) => `…і яшчэ ${count}`,
      nobody: 'Ніхто не паспеў прагаласаваць.',
      notForTarget: 'Гэта галасаванне пра цябе.',
      noStanding: 'Галасуюць тыя, хто ўжо асвоіўся ў чаце.',
      knownBad: 'Твой голас тут не лічыцца.'
    }
  },

  report: {
    needReply: 'Зрабі /report адказам на паведамленне, якое хочаш зарэпорціць.',
    cantReportAdmin: 'Адмінаў рэпорціць нельга.',
    rateLimited: 'Зашмат рэпортаў. Пачакай некалькі хвілін.',
    accepted: 'Прыняў, дзякуй.',
    oneAtATime: 'Тут зайшло некалькі чалавек адразу. Адкажы на паведамленне таго, на каго скардзішся.'
  },

  botStats: {
    title: '🛡 <b>Што я ўжо зрабіў</b>',
    window: (days) => `За апошнія ${days} ${plural(days, 'дзень', 'дні', 'дзён')}:`,
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
    chatLastSpam: (ago) => `Апошні спам: ${ago} таму`,
    chatClean: '✨ За гэты час — ніводнага спаму.',
    unavailable: '📊 Лічбы зараз недаступныя, паспрабуй крыху пазней.',
    button: '📊 Мае лічбы'
  },

  stats: {
    title: '📊 <b>Твая статыстыка</b>',
    inChat: (count, chatTitle) => chatTitle ? `Паведамленняў у чаце ${chatTitle}: ${count}` : `Паведамленняў у гэтым чаце: ${count}`,
    global: (count) => `Паведамленняў усюды: ${count}`,
    reputation: (score, status) => `Рэпутацыя: ${score} (${status})`,
    repStatus: { trusted: 'даверны', neutral: 'нейтральны', suspicious: 'падазроны', restricted: 'абмежаваны' },
    bananCaught: (count) => `Бананаў злоўлена: ${count} 🍌`,
    openInPm: 'Статыстыка прыйдзе ў асабістыя.',
    openButton: '📊 Мая статыстыка'
  },

  top: {
    titleMessages: '🏆 <b>Самыя актыўныя ў чаце</b>',
    titleBanan: '🍌 <b>Топ па бананах</b>',
    empty: 'Пакуль няма статыстыкі.',
    messagesUnit: (count) => (count % 10 === 1 && count % 100 !== 11 ? 'паведамленне' : 'паведамленняў'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} вылецеў з чата.`,
    needReply: 'Зрабі /kick адказам на паведамленне таго, каго хочаш выгнаць.'
  },

  untrust: {
    success: (name) => `🔓 Знята давер з ${name}. Яго паведамленні зноў праходзяць праверку.`,
    needReply: 'Зрабі /untrust адказам на паведамленне таго, з каго хочаш зняць давер.',
    notTrusted: (name) => `${name} і так не ў спісе даверных.`
  },

  trust: {
    button: '✅ Давяраць',
    untrustButton: '🔓 Зняць давер',
    added: 'Дадаў у даверныя гэтага чата.',
    removed: 'Зняў давер.'
  },

  welcome: {
    enabled: '👋 Прывітанні ўключаны.',
    disabled: '👋 Прывітанні выключаны.',
    textSet: '✅ Тэкст прывітання захаваны. Падстаноўка %name% працуе.',
    gifSet: '✅ Гіфку для прывітання захавана.',
    usage: [
      '/welcome — уключыць/выключыць',
      '/welcome <тэкст з %name%> — задаць прывітанне',
      'адказ гіфкай на /welcome — задаць гіфку'
    ].join('\n'),
    limit: '⚠️ Дасягнуты ліміт — спачатку выдалі нешта ў наладах.',
    duplicate: 'ℹ️ Гэта ўжо дададзена.',
    tooLong: '⚠️ Тэкст занадта доўгі (макс. 1000 сімвалаў).',
    saveFailed: '⚠️ Не ўдалося захаваць.',
    surgeAlert: (count, riskCount) => `⚠️ Хуткія далучэнні · ${count} удзельнікаў · ${riskCount} маркераў рызыкі`,
    defaultGreeting: (name) => `👋 Вітаем, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Прывітанне навічкоў</b>\n\nСтан: ${state}\nТэкстаў: ${nTexts} · Гіфак: ${nGifs}\n\nКалі іх некалькі — бот штораз бярэ выпадковы.`,
      enable: '🔔 Уключыць',
      disable: '🔕 Выключыць',
      texts: (n) => `📝 Тэксты (${n})`,
      gifs: (n) => `🎞 Гіфкі (${n})`,
      preview: '👁 Прагляд',
      textsTitle: (n, max) => `📝 <b>Тэксты прывітання</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тэксты прывітання</b>\n\nПакуль пуста. Дадай першы — можна з <code>%name%</code> для імя навічка.',
      addText: '➕ Дадаць тэкст',
      gifsTitle: (n, max) => `🎞 <b>Гіфкі прывітання</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 гіфка #${i}`,
      gifsEmpty: '🎞 <b>Гіфкі прывітання</b>\n\nПакуль пуста. Дадай першую — дашлі гіфку, відэа ці фота.',
      addGif: '➕ Дадаць гіфку',
      promptText: '📝 Дашлі тэкст прывітання адным паведамленнем.\nМожна ўставіць <code>%name%</code> — падстаўлю імя навічка.\n\n/cancel — скасаваць.',
      promptGif: '🎞 Дашлі гіфку, відэа ці фота адным паведамленнем.\n\n/cancel — скасаваць.',
      added: '✅ Дададзена.',
      cancelled: '❌ Скасавана.',
      invalidGif: '⚠️ Гэта не медыя. Дашлі гіфку, відэа ці фота.',
      removed: '🗑 Выдалена.',
      removeMissing: 'Гэтага ўжо няма — абнавіў спіс.',
      expired: '⌛ Час выйшаў. Адкрый рэдактар яшчэ раз.',
      previewEmpty: 'Пакуль няма чаго паказаць — дадай тэкст ці гіфку.'
    }
  },

  extra: {
    saved: (name) => `✅ Захавана #${name}`,
    deleted: (name) => `🗑 Выдалена #${name}`,
    notFound: (name) => `Няма такога: #${name}`,
    usage: [
      '/extra назва (у адказ на паведамленне) — захаваю яго пад #назва',
      '/extra назва (без адказу) — выдаліць трыгер'
    ].join('\n'),
    listTitle: '📂 Захаваныя трыгеры:',
    listEmpty: 'Тут пакуль няма трыгераў.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Трыгеры</b> (${n})\n\nНапішы <code>#назва</code> ў чаце — бот дашле захаванае.\nМакс. спрацаванняў на паведамленне: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Трыгеры</b>\n\nПакуль пуста. Дадай першы — назва + тэкст ці медыя.',
      add: '➕ Дадаць трыгер',
      maxLabel: (n) => `Макс: ${n}`,
      promptName: '#️⃣ Увядзі назву трыгера (без #), адным словам.\n\n/cancel — скасаваць.',
      promptContent: (name) => `Цяпер дашлі змесціва для <code>#${name}</code> — тэкст ці медыя (гіфка/фота/відэа).\n\n/cancel — скасаваць.`,
      added: (name) => `✅ Трыгер #${name} захаваны.`,
      cancelled: '❌ Скасавана.',
      invalidName: '⚠️ Назва — адно слова без прабелаў (літары/лічбы/_).',
      removed: '🗑 Выдалена.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} атрымлівае банан на ${duration}`,
    lifted: (name) => `🍌 ${name} пазбаўляецца банана`,
    self: (name, duration) => `🍌 ${name} сам сябе забаніў на ${duration}. Паважаю`,
    needReply: 'Зрабі /banan адказам на паведамленне, або /banan без рэплая для сябе.',
    undoButton: '↩️ Скасаваць',
    units: { m: 'хв', h: 'гадз', d: 'дн' },
    show: (name) => `🍌 ${name} паказвае банан`
  },

  captcha: {
    prompt: (name) => `👋 ${name}, націсні кнопку і пішы далей. Гэта хуткая праверка, што ты не бот.`,
    button: '🙋 Я чалавек',
    passed: 'Гатова, пішы.',
    retry: 'Не ўдалося зняць абмежаванне. Натсні яшчэ раз.',
    notForYou: 'Гэтая кнопка не для цябе.'
  },

  settings: {
    openInPm: 'Налады даступныя ў асабістых паведамленнях.',
    openInPmButton: '⚙️ Адкрыць налады',
    title: '⚙️ <b>Налады антыспаму</b>',
    preset: 'Рэжым',
    presets: { soft: 'Мяккі', standard: 'Стандарт', strict: 'Строгі' },
    captcha: 'Капча для навічкоў',
    voting: 'Галасаванне супольнасці',
    enabled: 'Антыспам',
    banDatabase: 'Базы спамераў',
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
