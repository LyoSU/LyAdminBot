import type { Locale } from '../locale.js'

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
    groupHint: '🛡 Лаўлю спам, баню махляроў.\n<code>/settings</code> для адмінаў · <code>/help</code> каманды',
    addToGroupButton: '➕ Дадаць у групу',
    helpButton: '❓ Каманды',
    langButton: '🌐 Мова'
  },

  helpText: [
    '🛡 <b>Каманды</b>',
    '/report — скарга на спам (у адказ)',
    '/settings — антыспам для адмінаў (адкрыецца ў ПП)',
    '/lang — мова',
    '',
    'Спам зношу сам. Пад кожным дзеяннем ёсць <b>[🤨 За што?]</b> з тлумачэннем',
    'і <b>[✅ Не спам]</b> для адмінаў: скасоўвае рашэнне і вучыць мяне.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Выберы мову:',
    saved: 'Гатова, цяпер па-беларуску'
  },

  commands: {
    start: 'Пачаць працу з ботам',
    help: 'Дапамога і каманды',
    lang: 'Выбраць мову',
    mystats: 'Мая статыстыка',
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
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyButton: '🤨 За што?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, скасаваў. Юзер разблакаваны і цяпер у даверных гэтага чата.',
    overrideAlreadyDone: 'Ужо скасавана.',
    adminOnly: 'Толькі для адмінаў гэтага чата.',
    missingRights: '⚠️ Знайшоў спам, але не маю праў яго прыбраць. Дайце мне правы выдаляць паведамленні і баніць карыстальнікаў.'
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
    private_invite_new: 'закрытае запрашэнне ад новага акаўнта',
    identity_churn_promo: 'частая змена імя + рэклама',
    hidden_url_new: 'схаваная спасылка ад навічка',
    low_information: 'недастаткова інфармацыі, назіраем',
    admin_report: 'адмін зарэпорціў як спам',
    community_vote: 'супольнасць прагаласавала: спам',
    forward_blacklist: 'пераслана з вядомай спам-крыніцы'
  },
  reasonFallback: 'падазроная актыўнасць',

  why: {
    title: '🛡 Чаму я ўмяшаўся',
    confidence: {
      high: (percent) => `🔴 Вельмі падобна на спам · ${percent}%`,
      medium: (percent) => `🟠 Імаверна спам · ${percent}%`,
      low: (percent) => `🟡 Магчыма спам · ${percent}%`
    },
    reasonLine: (reason) => `Прычына: ${reason}`,
    noticedTitle: 'Што я заўважыў:',
    signalLabels: {
      external_ban: 'акаўнт у спам-базах',
      external_repeat_offender: 'некалькі разоў у спам-базах',
      fresh_external_ban: 'нядаўна трапіў у спам-базы',
      many_shared_chats: 'адразу ў многіх нашых чатах',
      promo_in_bio: 'рэклама або кантакт у біо',
      personal_channel: 'канал прывязаны да профілю',
      restricted_for_spam: 'Telegram абмежаваў за спам',
      just_joined: 'толькі зайшоў і адразу піша',
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
      promo_bot: 'рэкламны бот',
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
      custom_emoji_heavy: 'шмат кастамных эмодзі',
      paid_media: 'платны медыякантэнт',
      giveaway_media: 'розыгрыш',
      story_share: 'пашыраная сторыс',
      unknown_media: 'нераспазнанае ўкладанне',
      guest_bot_delivery: 'дастаўлена праз гасцявога бота',
      edited_message: 'паведамленне адрэдагавана',
      edit_injected_promo: 'рэклама ўстаўлена рэдагаваннем'
    },
    messageTitle: 'Паведамленне:',
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
      score: 'сума сігналаў',
      abstain: 'устрыманне',
      error: 'памылка'
    },
    expired: 'Гэтае рашэнне ўжо састарэла — дэталяў не засталося.'
  },

  profile: {
    title: '👤 Профіль',
    accountAge: (age) => `акаўнт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) => `${messages} паведамленняў · ${chats} нашых чатаў`,
    reputation: (status) => `рэпутацыя: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'у спам-базах',
      ...(ago ? [`бан ${ago} таму`] : []),
      ...(offenses > 1 ? [`${offenses} парушэнняў`] : [])
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
    prompt: (userLabel, textPreview) => `🤔 <b>Гэта спам?</b> Паведамленне ад ${userLabel}:\n\n"${textPreview}"`,
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голас залічаны.',
    resolvedSpam: '🗑 Супольнасць вырашыла: спам. Прыбраў.',
    resolvedHam: '👌 Супольнасць вырашыла: не спам.',
    alreadyEnded: 'Галасаванне ўжо закрыта.'
  },

  report: {
    needReply: 'Зрабі /report адказам на паведамленне, якое хочаш зарэпорціць.',
    cantReportAdmin: 'Адмінаў рэпорціць нельга.',
    rateLimited: 'Зашмат рэпортаў. Пачакай некалькі хвілін.',
    accepted: 'Прыняў, дзякуй.'
  },

  stats: {
    title: '📊 <b>Твая статыстыка</b>',
    inChat: (count) => `Паведамленняў у гэтым чаце: ${count}`,
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
    defaultGreeting: (name) => `👋 Вітаем, ${name}!`
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
    listEmpty: 'Тут пакуль няма трыгераў.'
  },

  banan: {
    success: (name, duration) => `🍌 ${name} атрымлівае банан на ${duration}`,
    lifted: (name) => `🍌 ${name} пазбаўляецца банана`,
    self: (name, duration) => `🍌 ${name} сам сябе забаніў на ${duration}. Паважаю`,
    needReply: 'Зрабі /banan адказам на паведамленне, або /banan без рэплая для сябе.',
    undoButton: '↩️ Скасаваць',
    units: { m: 'хв', h: 'гадз', d: 'дн' }
  },

  captcha: {
    prompt: (name) => `👋 ${name}, націсні кнопку і пішы далей. Гэта хуткая праверка, што ты не бот.`,
    button: '🙋 Я чалавек',
    passed: 'Гатова, пішы.',
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
    language: 'Мова бота ў чаце',
    languageSaved: 'Мову чата абноўлена',
    on: 'Уключана',
    off: 'Выключана',
    back: '‹ Назад'
  }
}
