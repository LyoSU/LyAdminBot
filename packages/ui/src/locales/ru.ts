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
 * "только что" is already a point in time: "только что назад" is not Russian.
 * Every "<span> назад" in this file goes through here, so a span under a
 * minute reads as itself wherever an elapsed time is printed.
 */
const NOW = 'только что'
const ago = (span: string): string => (span === NOW ? NOW : `${span} назад`)

/** First-seen placeholder: the profile line reads it as a phrase, not a span. */
const NEVER_SEEN = 'впервые'

export const ru: Locale = {
  languageName: 'Русский',

  start: {
    privateCard: (name) => [
      `Привет, <b>${name}</b>! 👋`,
      '',
      '🛡 <b>Антиспам для групп.</b>',
      'Ловлю спам, баню мошенников, чищу рекламу.',
      '',
      'Добавь в группу → дай права админа → готово.'
    ].join('\n'),
    liveProof: (chats, spammers, days) =>
      `📊 Сейчас защищаю <b>${groupDigits(chats)}</b> ${plural(chats, 'чат', 'чата', 'чатов')}: ` +
      `<b>${groupDigits(spammers)}</b> ${plural(spammers, 'спамер заблокирован', 'спамера заблокированы', 'спамеров заблокировано')} за ${days} ${plural(days, 'день', 'дня', 'дней')}.`,
    groupHint: '🛡 Ловлю спам, баню мошенников.\n<code>/settings</code> для админов · <code>/stats</code> цифры · <code>/help</code> команды',
    addToGroupButton: '➕ Добавить в группу',
    helpButton: '❓ Команды',
    langButton: '🌐 Язык'
  },
  arrivals: {
    button: '👥 Новые участники',
    title: '👥 <b>Кто пришёл в чат за неделю</b>',
    empty: 'За неделю бот не заметил в этом чате новых участников.',
    silent: 'молчит',
    spoke: (count) => `сообщений: ${count}`,
    suspect: 'вход вместе со спамером',
    outcomes: {
      removed: 'убрано из чата',
      banned_on_record: 'забанено по спам-базам',
      banned_carried: 'забанено в другом чате за спам',
      banned_by_admin: 'забанено админом',
      gated: 'на проверке'
    },
    footer: '⚠️ — вход вместе со спамером и похожий профиль. «🚫 N» банит участника под номером N.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Забанить всех, кто молчит (${count})`,
    confirmAll: (count) => `Забанить <b>${count}</b> ${plural(count, 'новичка, который ещё ничего не написал', 'новичков, которые ещё ничего не написали', 'новичков, которые ещё ничего не написали')}?`,
    confirmYes: '🚫 Да, забанить',
    cancel: 'Отмена',
    banned: (count) => `Забанено: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>Вместе со спамером ${plural(count, 'пришёл', 'пришли', 'пришло')} ещё ${count} ${plural(count, 'похожий новичок', 'похожих новичка', 'похожих новичков')}</b>\nСпамер: ${spammer}`,
    hint: 'Похожий профиль, вход в то же время, ни одного сообщения. Бот никого не ограничивал — решает админ.',
    banButton: (count) => `🚫 Забанить ${count}`,
    keepButton: 'Оставить',
    banned: (done, total, admin) => `🚫 Забанено ${done} из ${total} ${plural(total, 'новичка', 'новичков', 'новичков')}, пришедших вместе со спамером · ${admin}`,
    kept: (admin) => `✅ Новички оставлены · ${admin}`,
    expired: 'Эта карточка уже неактуальна.'
  },

  chatActions: {
    button: '🧾 Последние действия',
    title: '🧾 <b>Последние действия бота в чате</b>',
    empty: 'Пока пусто: в этом чате бот ещё ничего не делал.',
    footer: '«За что?» открывает доказательства и кнопку «Не спам», если бот ошибся.'
  },

  ownRestrictions: {
    title: '🧾 <b>Мои решения о тебе</b>',
    ago,
    endsIn: (span) => `истечёт через ${span}`,
    ended: 'уже истекло',
    permanent: 'без срока',
    overturned: '↩️ отменено',
    unknownChat: 'чат без названия',
    footer: [
      'Это автоматические решения бота, а не администраторов.',
      'Если я ошибся — напиши админу того чата: админ может отменить это одним нажатием.',
      'Временные ограничения снимаются сами.'
    ].join('\n'),
    whyButton: (n) => `За что? · ${n}`
  },

  helpText: [
    '🛡 <b>Что я умею</b>',
    'Ловлю спам и баню мошенников сам. Большинство действий — кнопками, не командами.',
    '',
    '<b>Всем:</b>',
    '/report — пожаловаться на спам (ответом, или /report @ник либо id)',
    '/stats — сколько спама я уже поймал',
    '/mystats — моя статистика · /top, /top_banan — рейтинги',
    '/lang — язык',
    '',
    '<b>Админам:</b>',
    '/settings — панель настроек (откроется в ЛС, дальше всё кнопками)',
    '/banan /kick /del — модерация ответом',
    '/check — карточка пользователя с кнопкой доверия · /untrust — снять доверие',
    '/welcome — приветствие новичков · /extra, /extras — триггеры',
    '',
    'В каждом уведомлении есть ссылка <b>за что?</b> — там вся карточка решения. Админам ещё и кнопка <b>«✅ Не спам»</b>: отменяет решение и добавляет человека в доверенные этого чата.'
  ].join('\n'),

  writeFailed: '⚠️ Не сохранил — попробуй ещё раз.',
  hiddenName: (userId) => `пользователь ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Группа: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Выбери язык:',
    saved: 'Готово, теперь по-русски',
    openInPm: 'Свой язык выберешь в личном чате с ботом — жми кнопку.',
    openButton: '🌐 Выбрать язык'
  },

  commands: {
    start: 'Начать работу с ботом',
    help: 'Помощь и команды',
    lang: 'Выбрать язык',
    mystats: 'Моя статистика',
    stats: 'Сколько спама я уже поймал',
    report: 'Пожаловаться на спам (ответом)',
    settings: 'Настройки антиспама (админы)',
    banan: 'Мут ответом (/banan 5m)',
    kick: 'Выгнать участника (ответом)',
    del: 'Удалить сообщение (ответом)',
    untrust: 'Снять доверие (ответом)',
    check: 'Проверить профиль (ответом)',
    top: 'Топ активных участников',
    topBanan: 'Топ по бананам',
    extras: 'Сохранённые триггеры',
    welcome: 'Приветствие новичков',
    ping: 'Проверить, жив ли бот'
  },

  actions: {
    captcha: '👋 проверка',
    delete: '🧹 сообщение удалено',
    kick: '🚪 выгнали из чата',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за что?',
    whyButton: 'ℹ️ За что?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Отменено: ограничение снято, аккаунт теперь в доверенных этого чата.',
    overridePartial: '⚠️ Отменено не полностью: не удалось снять ограничение или добавить в доверенные. Проверь мои права и нажми ещё раз.',
    overrideAlreadyDone: 'Уже отменено.',
    adminOnly: 'Только для админов этого чата.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` За сутки не удалось убрать ${accounts} ${plural(accounts, 'аккаунт', 'аккаунта', 'аккаунтов')}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Спам удаляю, но самих спамеров убрать не могу — нет права «Блокировать пользователей».${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Спамеров блокирую, но не могу удалять их сообщения — нет права «Удалять сообщения».'
      }
      return `⚠️ Нашёл спам, но ничего не могу сделать — нет прав «Удалять сообщения» и «Блокировать пользователей».${left}`
    }
  },

  reasons: {
    job_scam: 'похоже на мошенническое предложение работы',
    crypto_scam: 'криптомошенничество',
    gambling_promo: 'реклама казино или ставок',
    adult_promo: 'реклама 18+',
    ad_network: 'продажа рекламы и размещений',
    flirt_bait: 'флирт-приманка',
    phishing: 'фишинговая ссылка',
    channel_promo: 'непрошеная реклама канала',
    guest_bot_promo: 'реклама через бота, вызванного упоминанием',
    flood: 'флуд или массовая рассылка',
    prompt_injection: 'попытка обойти антиспам-проверку',
    other_spam: 'спам',
    known_spam_signature: 'совпадение с подтверждённым спамом',
    semantic_spam_match: 'очень похоже на известный спам',
    velocity_exceeded: 'то же сообщение в нескольких чатах подряд',
    custom_deny: 'запрещено правилом чата',
    scam_flag_new: 'Telegram пометил аккаунт как мошеннический',
    external_ban_new: 'аккаунт в спам-базах',
    shared_profile_photo: 'то же фото профиля ещё на нескольких аккаунтах',
    external_high_factor_new: 'аккаунт в спам-базах',
    edit_injected_promo: 'реклама добавлена при редактировании',
    edit_injected_invisibles: 'невидимые символы добавлены при редактировании',
    private_invite_new: 'приглашение в закрытый чат от нового аккаунта',
    identity_churn_promo: 'частая смена имени и реклама',
    nsfw_promo_profile: 'профиль работает как реклама: откровенные фото или видео и канал в профиле',
    hidden_url_new: 'скрытая ссылка от новичка',
    low_information: 'недостаточно информации — пока только наблюдение',
    low_information_profile: 'мало текста, но профиль подозрительный',
    low_information_profile_unreachable: 'профиль подозрительный, но проверку отправить не удалось — пока только наблюдение',
    reported_unreachable: 'на аккаунт пожаловались, а проверку отправить не удалось — ограничен на час',
    profile_farm_unreachable: 'реклама прямо в фото профиля, а проверку отправить не удалось — ограничен на час',
    content_unconfirmed: 'профиль подозрительный, но сам текст как спам не подтверждён',
    admin_report: 'жалоба админа: спам',
    trusted_report: 'жалоба доверенного участника: спам',
    community_vote: 'сообщество проголосовало: спам',
    forward_blacklist: 'переслано из известного спам-источника',
    record_ban_elsewhere: 'аккаунт уже забанен в другом чате по спам-базам или пометке Telegram — здесь забанен ещё до первого сообщения',
    content_ban_elsewhere: 'аккаунт забанен в другом чате за спам — здесь забанен ещё до первого сообщения',
    listed_arrival: 'при входе: аккаунт в спам-базах или помечен Telegram',
    arrival_look: 'новичок молчит, а профиль похож на спам-сеть',
    arrived_with_spammer: 'вход вместе со спамером, похожий профиль — забанил админ',
    admin_arrival_ban: 'забанено админом из списка новых участников'
  },
  reasonFallback: 'подозрительная активность',

  why: {
    title: '🛡 Бот только наблюдает',
    inChat: (chatTitle) => `в чате ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Очень похоже на спам · оценка бота ${percent}%`,
      medium: (percent) => `🟠 Вероятно спам · оценка бота ${percent}%`,
      low: (percent) => `🟡 Возможно спам · оценка бота ${percent}%`
    },
    noticedTitle: 'Что я заметил:',
    profileReuseEvidence: (accounts) =>
      `то же фото профиля ещё на ${accounts} ${plural(accounts, 'аккаунте', 'аккаунтах', 'аккаунтах')}`,
    // The pipeline writes the model's 0..1 score; the card shows percents.
    profileMediaEvidence: (score) => `откровенное фото в профиле · оценка ${Math.round(Number(score) * 100)}%`,
    externalBanEvidence: (sources, when) => [
      'в спам-базах',
      ...(sources > 1 ? [`${sources} ${plural(sources, 'источник', 'источника', 'источников')}`] : []),
      ...(when ? [ago(when)] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'аккаунт в спам-базах',
      external_repeat_offender: 'несколько раз в спам-базах',
      fresh_external_ban: 'недавно в спам-базах',
      many_shared_chats: 'сразу во многих наших чатах',
      promo_in_bio: 'рекламная ссылка в био',
      private_invite_in_bio: 'приглашение в закрытый канал в био',
      contact_in_bio: 'контакт вне Telegram в био',
      personal_channel: 'канал привязан к профилю',
      promo_in_linked_channel: 'в канале из профиля — реклама',
      promo_in_message_link: 'ссылка ведёт на рекламный канал',
      restricted_for_spam: 'Telegram ограничил за спам',
      just_joined: 'пишет сразу после входа в чат',
      joined_during_surge: 'вход во время наплыва новых участников',
      arrived_with_spammer: 'вход в чат вместе со спамером, похожий профиль',
      scam_flag: 'Telegram пометил аккаунт как мошеннический',
      fake_flag: 'Telegram пометил аккаунт как фейковый',
      restricted_flag: 'аккаунт ограничен Telegram',
      sleeper_awakened: 'давно неактивный аккаунт вдруг начал писать',
      fresh_account: 'возможно, аккаунт совсем новый',
      new_globally: 'новый в наших чатах',
      new_in_chat: 'новый в этом чате',
      identity_churn_24h: 'частая смена имени или фото профиля',
      avatar_recently_set: 'фото профиля поставлено на днях',
      prior_spam_detections: 'от аккаунта уже был спам раньше',
      unofficial_client_risk: 'отправлено из неофициального приложения',
      forward_hidden_user: 'переслано от автора, который скрыл свой профиль',
      forward_source_suspicious: 'переслано из подозрительного источника',
      hidden_url: 'замаскированная ссылка',
      external_url: 'внешняя ссылка',
      url_shortener: 'сокращённая ссылка',
      private_invite_link: 'приглашение в закрытый чат',
      bot_deeplink: 'ссылка, которая запускает бота',
      messenger_contact_link: 'контакт в другом мессенджере',
      many_url_buttons: 'несколько кнопок со ссылками',
      phone_number: 'номер телефона',
      cashtag: 'упоминание монеты или акции со знаком $',
      long_text: 'длинный текст',
      invisible_in_word: 'невидимые символы внутри слов',
      mixed_script_word: 'буквы разных алфавитов в одном слове',
      greek_homoglyph_word: 'греческие буквы-двойники в слове',
      foreign_script: 'написано непривычной для чата письменностью',
      custom_emoji_heavy: 'много премиум-эмодзи',
      paid_media: 'платный медиаконтент',
      giveaway_media: 'розыгрыш',
      story_share: 'пересланная история',
      unknown_media: 'нераспознанное вложение',
      guest_bot_delivery: 'отправлено через бота, вызванного упоминанием',
      edited_message: 'сообщение отредактировано',
      edit_injected_invisibles: 'невидимые символы добавлены при редактировании',
      edit_injected_link: 'ссылка добавлена при редактировании',
      moderation_flagged: '18+ в тексте или фото',
      sole_avatar_replaced: 'старый аккаунт, единственное фото профиля поставлено недавно',
      avatar_shared_with_account: 'то же фото профиля ещё на одном аккаунте',
      avatar_shared_with_accounts: 'то же фото профиля на нескольких аккаунтах',
      nsfw_avatar: '18+ в фото профиля',
      suggestive_profile_media: 'полуоткровенное фото или видео в профиле',
      nsfw_stories: '18+ в историях',
      nsfw_linked_channel: '18+ в фото канала из профиля',
      promo_in_name: 'реклама в имени аккаунта',
      invisible_in_name: 'невидимые символы в имени',
      signature_candidate_match: 'похоже на известный спам',
      vector_similar_spam: 'по смыслу похоже на известный спам',
      velocity_repeats: 'тот же текст повторяется',
      velocity_wave: 'тот же текст с нескольких аккаунтов',
      bot_mention: 'упоминание бота',
      sender_burst: 'серия сообщений от одного аккаунта',
      burst_grey_repeat: 'несколько сообщений серии уже выглядели подозрительно'
    },
    decidedBy: {
      custom_rule: 'правило чата',
      deterministic: 'жёсткое правило',
      signature: 'база сигнатур',
      vector: 'семантический поиск',
      forward: 'чёрный список источников пересылки',
      velocity: 'рассылка по нескольким чатам',
      moderation: 'модерация контента',
      llm: 'ИИ-анализ',
      llm_cached: 'ИИ-анализ (кеш)',
      session: 'анализ серии сообщений',
      burst: 'анализ серии от одного аккаунта',
      score: 'сумма сигналов',
      abstain: 'без решения',
      error: 'ошибка',
      join_screen: 'проверка при входе',
      captcha_ignored: 'проверку проигнорировали'
    },
    expired: 'Детали этого решения больше не хранятся.',
    appeal: 'Если это ошибка — напиши админу этого чата: админ может отменить решение.'
  },

  profile: {
    title: '👤 Профиль',
    openButton: '👤 Профиль',
    accountAge: (age) => `аккаунт ${age}`,
    // "известен боту <span>" agrees with the "аккаунт" that opens the line; a span
    // under a minute is a first sighting too, and "известен боту только что" is not.
    firstSeen: (seen) => (seen === NEVER_SEEN || seen === NOW ? 'бот видит впервые' : `известен боту ${seen}`),
    activity: (messages, chats) =>
      [
        ...(messages === null ? [] : [`${messages} ${plural(messages, 'сообщение', 'сообщения', 'сообщений')}`]),
        `${chats} ${plural(chats, 'чат', 'чата', 'чатов')}`
      ].join(' · '),
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (when, offenses) => [
      'в спам-базах',
      ...(when ? [`бан ${ago(when)}`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'нарушение', 'нарушения', 'нарушений')}`] : [])
    ].join(' · '),
    justJoined: (span) => (span === NOW ? 'в чате только что' : `в чате всего ${span}`),
    promoInBio: 'реклама в био',
    personalChannel: 'привязанный канал',
    unknownAge: 'неизвестного возраста',
    neverSeen: NEVER_SEEN,
    units: { now: NOW, m: 'мин', h: 'ч', d: 'д', mo: 'мес', y: 'г' },
    checkNeedReply: 'Сделай /check ответом на сообщение пользователя.',
    notFound: 'Не удалось получить профиль.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Это спам?</b> Автор: ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Это спам?</b> Автор: ${userLabel} · без текста, только ${what}`
        : `🤔 <b>Это спам?</b> Автор: ${userLabel} · без текста`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'фото', sticker: 'стикер', video: 'видео',
      voice: 'голосовое или аудио', file: 'файл', other: 'вложение'
    },
    redacted: { link: '[ссылка]', mention: '[@упоминание]', invite: '[приглашение]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `✅ Не спам (${count})`,
    counted: 'Голос засчитан.',
    enforcement: {
      done: 'Сообщение удалено, автор ограничен.',
      deletedOnly: 'Сообщение удалено, но ограничить автора не удалось.',
      mutedOnly: 'Автор ограничен, но удалить сообщение не удалось.',
      failed: '⚠️ Не удалось ни удалить сообщение, ни ограничить автора.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      // The name follows a "·", never "от": a display name cannot be declined.
      '🗑 Сообщество решило: спам' + (who ? ` · ${who}` : '')
      + (enforcement ? `. ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      '✅ Сообщество решило: не спам' + (who ? ` · ${who}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Голосование уже закрыто.',
    voters: {
      button: '👥 Кто голосовал',
      title: (spam, ham) => `👥 <b>Голосование</b> · спам ${spam} : ${ham} не спам`,
      spamGroup: '🗑 Спам',
      hamGroup: '✅ Не спам',
      adminMark: 'админ',
      changedMark: 'голос изменён',
      span: (span) => (span === NOW ? '⏱ все голоса — меньше чем за минуту' : `⏱ от первого до последнего голоса: ${span}`),
      more: (count) => `…и ещё ${count}`,
      nobody: 'Никто не успел проголосовать.',
      notForTarget: 'Это голосование о тебе: в нём ты не голосуешь и не видишь, кто голосовал.',
      noStanding: 'Голос не засчитан: голосуют те, кто в чате не меньше недели и написал здесь от 10 сообщений (или от 50 во всех чатах с ботом), либо кто в чате больше года.',
      knownBad: 'Голос не засчитан: с этого аккаунта уже приходил спам.'
    }
  },

  report: {
    needReply: 'Сделай /report ответом на сообщение или укажи человека: /report @ник, /report 123456789, либо выбери его через @ из списка.',
    notFound: (who) => `Не нашёл в этом чате: ${who}. Ответь на сообщение этого человека или выбери его через @ из списка.`,
    notInChat: 'Этого человека уже нет в чате.',
    cantReportAdmin: 'На админов жаловаться нельзя.',
    rateLimited: 'Слишком много жалоб. Подожди пару минут.',
    accepted: 'Жалобу принял, спасибо.',
    oneAtATime: 'Это сообщение о входе нескольких человек. Ответь на сообщение того, на кого жалуешься.',
    voteClosed: 'Голосование по этому сообщению уже закрыто. Решить может админ.',
    channelSender: 'Это написано от имени канала. Заблокировать канал может только админ.'
  },

  botStats: {
    title: '🛡 <b>Что я уже сделал</b>',
    window: (days) => `За ${plural(days, 'последний', 'последние', 'последние')} ${days} ${plural(days, 'день', 'дня', 'дней')}:`,
    checked: (count) => `📬 <b>${groupDigits(count)}</b> ${plural(count, 'проверенное сообщение', 'проверенных сообщения', 'проверенных сообщений')}`,
    spammers: (count) => `🚫 <b>${groupDigits(count)}</b> ${plural(count, 'спамер заблокирован', 'спамера заблокированы', 'спамеров заблокировано')}`,
    chats: (count) => `💬 <b>${groupDigits(count)}</b> ${plural(count, 'чат под защитой', 'чата под защитой', 'чатов под защитой')}`,
    speed: (ms) => `⚡ решение за <b>${groupDigits(ms)} мс</b>`,
    quiet: (percent) => `<b>${decimal1(percent)}%</b> сообщений я не тронул. Пока спама нет, меня не слышно.`,
    reasonsTitle: '<b>Чаще всего ловлю:</b>',
    reasonLine: (name, count) => `• ${name} — ${groupDigits(count)}`,
    memory: (signatures) => `🧠 В памяти ${groupDigits(signatures)} ${plural(signatures, 'сигнатура', 'сигнатуры', 'сигнатур')} спама`,
    corrections: (percent) => `✅ Админы отменили ${decimal1(percent)}% моих решений`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> за ${days} ${plural(days, 'день', 'дня', 'дней')}`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${groupDigits(checked)} проверено · 🚫 ${groupDigits(spammers)} ${plural(spammers, 'спамер', 'спамера', 'спамеров')} · 🧹 ${groupDigits(deletes)} удалено`,
    chatLastSpam: (span) => `Последний спам: ${ago(span)}`,
    chatClean: '✨ За это время бот не обнаружил спама.',
    unavailable: '📊 Цифры сейчас недоступны, попробуй чуть позже.',
    button: '📊 Статистика бота'
  },

  stats: {
    title: '📊 <b>Твоя статистика</b>',
    inChat: (count, chatTitle) => chatTitle ? `Сообщений в чате ${chatTitle}: ${count}` : `Сообщений в этом чате: ${count}`,
    global: (count) => `Сообщений всего: ${count}`,
    reputation: (score, status) => `Репутация: ${score} (${status})`,
    repStatus: { trusted: 'надёжный', neutral: 'нейтральный', suspicious: 'подозрительный', restricted: 'ограниченный' },
    bananCaught: (count) => `Бананов поймано: ${count} 🍌`,
    openInPm: 'Твоя статистика — в личном чате с ботом, жми кнопку.',
    openButton: '📊 Моя статистика'
  },

  top: {
    titleMessages: '🏆 <b>Самые активные в чате</b>',
    titleBanan: '🍌 <b>Топ по бананам</b>',
    empty: 'Пока нет статистики.',
    messagesUnit: (count) => plural(count, 'сообщение', 'сообщения', 'сообщений'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} больше не в чате.`,
    needReply: 'Ответь командой /kick на сообщение того, кого хочешь выгнать.'
  },

  untrust: {
    success: (name) => `🔓 Доверие снято: ${name}. Сообщения снова проходят проверку.`,
    needReply: 'Ответь командой /untrust на сообщение того, с кого хочешь снять доверие.',
    notTrusted: (name) => `ℹ️ ${name} не в списке доверенных — снимать нечего.`
  },

  trust: {
    button: '✅ Доверять',
    untrustButton: '🔓 Снять доверие',
    added: 'Добавил в доверенные этого чата.',
    removed: 'Снял доверие.',
    grantedBy: (who, span, via) =>
      `✅ Доверие от ${who}, ${ago(span)}` +
      (via === 'override' ? ' · отмена решения бота' : via === 'vote' ? ' · голос админа' : ''),
    grantUnknown: '✅ Есть доверие · от кого и когда — не записано'
  },

  welcome: {
    enabled: '👋 Приветствия включены.',
    disabled: '👋 Приветствия выключены.',
    textSet: '✅ Текст приветствия сохранён. Подстановка %name% работает.',
    gifSet: '✅ Медиа для приветствия сохранено.',
    usage: [
      '/welcome — включить/выключить',
      '/welcome <текст с %name%> — задать приветствие',
      'ответь гифкой на /welcome — задать гифку'
    ].join('\n'),
    limit: '⚠️ Больше добавить нельзя: лимит исчерпан. Сначала удали что-то в настройках.',
    duplicate: 'ℹ️ Это уже добавлено.',
    tooLong: '⚠️ Текст слишком длинный (макс. 1000 символов).',
    saveFailed: '⚠️ Не удалось сохранить.',
    surgeAlert: (count, riskCount) => `⚠️ Наплыв новичков: ${count} ${plural(count, 'участник', 'участника', 'участников')}, из них ${riskCount} — с подозрительным профилем`,
    defaultGreeting: (name) => `👋 Добро пожаловать, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Приветствие новичков</b>\n\nСостояние: ${state}\nТекстов: ${nTexts} · Гифок: ${nGifs}\n\nЕсли их несколько — бот каждый раз берёт случайный.`,
      enable: '🔔 Включить',
      disable: '🔕 Выключить',
      texts: (n) => `📝 Тексты (${n})`,
      gifs: (n) => `🎞 Медиа (${n})`,
      preview: '👁 Предпросмотр',
      textsTitle: (n, max) => `📝 <b>Тексты приветствия</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тексты приветствия</b>\n\nПока пусто. Добавь первый — можно с <code>%name%</code> для имени новичка.',
      addText: '➕ Добавить текст',
      gifsTitle: (n, max) => `🎞 <b>Медиа для приветствия</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 медиа #${i}`,
      gifsEmpty: '🎞 <b>Медиа для приветствия</b>\n\nПока пусто. Пришли гифку, видео или фото.',
      addGif: '➕ Добавить медиа',
      promptText: '📝 Пришли текст приветствия одним сообщением.\nМожно вставить <code>%name%</code> — подставлю имя новичка.\n\n/cancel — отмена.',
      promptGif: '🎞 Пришли гифку, видео или фото одним сообщением.\n\n/cancel — отмена.',
      added: '✅ Добавлено.',
      cancelled: '↩️ Отменено.',
      invalidGif: '⚠️ Здесь нужна гифка, видео или фото — пришли что-то одно.',
      removed: '🗑 Удалено.',
      removeMissing: 'Этого уже нет — обновил список.',
      expired: '⌛ Время вышло. Открой редактор ещё раз.',
      previewEmpty: 'Пока нечего показать — добавь текст, гифку, видео или фото.'
    }
  },

  extra: {
    saved: (name) => `✅ Сохранил #${name}`,
    deleted: (name) => `🗑 Удалил #${name}`,
    notFound: (name) => `Такого триггера нет: #${name}`,
    usage: [
      '/extra имя (в ответ на сообщение) — сохраню это сообщение под #имя',
      '/extra имя (без ответа) — удалю триггер'
    ].join('\n'),
    listTitle: '📂 Сохранённые триггеры:',
    listEmpty: 'Здесь пока нет триггеров.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Триггеры</b> (${n})\n\nНапиши <code>#название</code> в чате — бот пришлёт сохранённый ответ.\nЛимит ответов на одно сообщение: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Триггеры</b>\n\nПока пусто. Добавь первый — название + текст или медиа.',
      add: '➕ Добавить триггер',
      maxLabel: (n) => `Лимит: ${n}`,
      promptName: '#️⃣ Введи название триггера (без #), одним словом.\n\n/cancel — отмена.',
      promptContent: (name) => `Теперь пришли, чем бот будет отвечать на <code>#${name}</code>: текст, гифку, фото или видео.\n\n/cancel — отмена.`,
      added: (name) => `✅ Триггер #${name} сохранён.`,
      cancelled: '↩️ Отменено.',
      invalidName: '⚠️ Название — одно слово: буквы, цифры или _, без пробелов.',
      removed: '🗑 Удалено.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} получает банан на ${duration}`,
    lifted: (name) => `🍌 ${name} больше без банана`,
    self: (name, duration) => `🍌 ${name} берёт себе банан на ${duration}. Уважаю`,
    needReply: 'Сделай /banan ответом на сообщение, или /banan без реплая для себя.',
    undoButton: '↩️ Отменить',
    units: { m: 'мин', h: 'ч', d: 'дн' },
    show: (name) => `🍌 ${name} показывает банан`
  },

  captcha: {
    prompt: (name, minutes) =>
      `👋 ${name}, ${minutes === undefined ? 'жми кнопку' : `нажми кнопку в течение ${minutes} мин`} и пиши дальше. Это быстрая проверка, что ты не бот.`,
    button: '🙋 Я человек',
    passed: 'Готово, пиши.',
    retry: 'Не удалось снять ограничение. Нажми ещё раз.',
    notForYou: 'Эта кнопка для другого участника.'
  },

  settings: {
    openInPm: 'Настройки — в личном чате с ботом, жми кнопку.',
    openInPmButton: '⚙️ Открыть настройки',
    title: '⚙️ <b>Настройки антиспама</b>',
    preset: 'Режим',
    presets: { soft: 'Мягкий', standard: 'Стандартный', strict: 'Строгий' },
    captcha: 'Капча для новичков',
    voting: 'Голосование сообщества',
    enabled: 'Антиспам',
    banDatabase: 'Спам-базы',
    quiet: 'Тихий режим',
    quietHint: '🤫 Уведомления об уверенных действиях приходят без звука и кнопок и исчезают через 5 с. Всё, что сделал бот, — в «🧾 Последние действия». Голосования и неуверенные решения показываются как обычно.',
    banan: 'Длительность банана',
    language: 'Язык бота в чате',
    languageSaved: 'Язык чата обновлён',
    welcome: '👋 Приветствие',
    extras: '#️⃣ Триггеры',
    on: 'Включено',
    off: 'Выключено',
    back: '‹ Назад'
  }
}
