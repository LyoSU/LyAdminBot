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
      `📊 Сейчас держу <b>${groupDigits(chats)}</b> ${plural(chats, 'чат', 'чата', 'чатов')}: ` +
      `<b>${groupDigits(spammers)}</b> ${plural(spammers, 'спамер заблокирован', 'спамера заблокировано', 'спамеров заблокировано')} за ${days} ${plural(days, 'день', 'дня', 'дней')}.`,
    groupHint: '🛡 Ловлю спам, баню мошенников.\n<code>/settings</code> для админов · <code>/help</code> команды',
    addToGroupButton: '➕ Добавить в группу',
    helpButton: '❓ Команды',
    langButton: '🌐 Язык'
  },

  helpText: [
    '🛡 <b>Что я умею</b>',
    'Ловлю спам и баню мошенников сам. Большинство действий — кнопками, не командами.',
    '',
    '<b>Всем:</b>',
    '/report — пожаловаться на спам (ответом)',
    '/stats — сколько спама я уже поймал',
    '/mystats — моя статистика · /top, /top_banan — рейтинги',
    '/lang — язык',
    '',
    '<b>Админам:</b>',
    '/settings — панель настроек (откроется в ЛС, дальше всё кнопками)',
    '/banan /kick /del — модерация ответом',
    '/check — карточка пользователя с кнопками (доверие и т.д.)',
    '/welcome — приветствие новичков · /extra, /extras — триггеры',
    '',
    'В каждом уведомлении есть ссылка <b>за что?</b> — там вся карточка решения. Админам ещё и <b>[✅ Не спам]</b>.'
  ].join('\n'),

  writeFailed: '⚠️ Не сохранил — попробуй ещё раз.',
  hiddenName: (userId) => `пользователь ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Группа: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Выбери язык:',
    saved: 'Готово, теперь по-русски',
    openInPm: 'Язык для себя выберешь в личных.',
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
    delete: '🧹 спам удалён',
    kick: '🚪 удалён из чата',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за что?',
    whyButton: '🤨 За что?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, отменил. Юзер разблокирован и теперь в доверенных этого чата.',
    overridePartial: 'Отменил, но не всё удалось применить. Попробуй ещё раз или проверь мои права.',
    overrideAlreadyDone: 'Уже отменено.',
    adminOnly: 'Только для админов этого чата.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` За сутки так осталось ${accounts} ${plural(accounts, 'аккаунт', 'аккаунта', 'аккаунтов')}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Спам удаляю, но самих спамеров убрать не могу — нет права «Блокировать пользователей».${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Спамеров блокирую, но их сообщения удалить не могу — нет права «Удалять сообщения».'
      }
      return `⚠️ Нашёл спам, но нет прав что-либо сделать. Дайте мне права «Удалять сообщения» и «Блокировать пользователей».${left}`
    }
  },

  reasons: {
    job_scam: 'похоже на мошенническую "вакансию"',
    crypto_scam: 'криптомошенничество',
    gambling_promo: 'реклама казино/ставок',
    adult_promo: 'реклама 18+',
    ad_network: 'продажа рекламы/размещений',
    flirt_bait: 'флирт-приманка',
    phishing: 'фишинговая ссылка',
    channel_promo: 'непрошеная реклама канала',
    guest_bot_promo: 'промо через гостевого бота',
    flood: 'флуд/массовая рассылка',
    prompt_injection: 'попытка обмануть модерацию',
    other_spam: 'спам',
    known_spam_signature: 'совпадение с подтверждённым спамом',
    semantic_spam_match: 'очень похоже на известный спам',
    velocity_exceeded: 'то же сообщение в нескольких чатах подряд',
    custom_deny: 'запрещено правилом чата',
    scam_flag_new: 'Telegram пометил аккаунт как мошеннический',
    external_ban_new: 'аккаунт в базах спамеров',
    shared_profile_photo: 'фото профиля ещё на нескольких аккаунтах — просим подтвердить',
    external_high_factor_new: 'аккаунт в базах спамеров',
    edit_injected_promo: 'в сообщение отредактирована реклама',
    edit_injected_invisibles: 'невидимые символы вставлены редактированием',
    private_invite_new: 'закрытое приглашение от нового аккаунта',
    identity_churn_promo: 'частая смена имени + реклама',
    nsfw_promo_profile: 'профиль сам является рекламой (откровенное медиа + канал в профиле)',
    hidden_url_new: 'скрытая ссылка от новичка',
    low_information: 'мало информации, наблюдаем',
    low_information_profile: 'мало информации, но профиль подозрительный — просим подтвердить',
    content_unconfirmed: 'подозрительный профиль, но содержание не подтверждено',
    admin_report: 'админ зарепортил как спам',
    community_vote: 'сообщество проголосовало: спам',
    forward_blacklist: 'переслано из известного спам-источника'
  },
  reasonFallback: 'подозрительная активность',

  why: {
    title: '🛡 Почему я вмешался',
    inChat: (chatTitle) => `в чате ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Очень похоже на спам · ${percent}%`,
      medium: (percent) => `🟠 Вероятно спам · ${percent}%`,
      low: (percent) => `🟡 Возможно спам · ${percent}%`
    },
    noticedTitle: 'Что я заметил:',
    externalBanEvidence: (sources, ago) => [
      'в спам-базах',
      ...(sources > 1 ? [`${sources} ${plural(sources, 'источник', 'источника', 'источников')}`] : []),
      ...(ago ? [`${ago} назад`] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'аккаунт в спам-базах',
      external_repeat_offender: 'несколько раз в спам-базах',
      fresh_external_ban: 'недавно попал в спам-базы',
      many_shared_chats: 'сразу во многих наших чатах',
      promo_in_bio: 'рекламная ссылка в био',
      private_invite_in_bio: 'приглашение в закрытый канал в био',
      contact_in_bio: 'контакт вне Telegram в био',
      personal_channel: 'канал привязан к профилю',
      promo_in_linked_channel: 'канал из профиля рекламирует сам себя',
      promo_in_message_link: 'ссылка ведёт на рекламный канал',
      restricted_for_spam: 'Telegram ограничил за спам',
      just_joined: 'только зашёл и сразу пишет',
      joined_during_surge: 'присоединился во время наплыва новых участников',
      scam_flag: 'Telegram пометил аккаунт как мошеннический',
      fake_flag: 'Telegram пометил аккаунт как фейковый',
      restricted_flag: 'аккаунт ограничен Telegram',
      sleeper_awakened: 'спящий аккаунт внезапно ожил',
      fresh_account: 'аккаунт может быть совсем новым',
      new_globally: 'почти не писал в наших чатах',
      new_in_chat: 'почти не писал в этом чате',
      identity_churn_24h: 'частая смена имени / фото',
      avatar_recently_set: 'аватар поставлен на днях',
      prior_spam_detections: 'раньше уже ловили на спаме',
      unofficial_client_risk: 'отправлено из неофициального приложения',
      forward_hidden_user: 'переслано от скрытого аккаунта',
      forward_source_suspicious: 'переслано из подозрительного источника',
      hidden_url: 'замаскированная ссылка',
      external_url: 'внешняя ссылка',
      url_shortener: 'сокращённая ссылка',
      private_invite_link: 'закрытая пригласительная ссылка',
      bot_deeplink: 'ссылка-запуск бота',
      messenger_contact_link: 'контакт в другом мессенджере',
      many_url_buttons: 'несколько ссылок-кнопок',
      phone_number: 'номер телефона',
      cashtag: 'упоминание криптовалюты / тикера',
      long_text: 'длинный текст',
      invisible_in_word: 'невидимые символы внутри слов',
      mixed_script_word: 'смесь алфавитов в слове',
      greek_homoglyph_word: 'греческие буквы вместо похожих на них в слове',
      foreign_script: 'написано непривычной для чата письменностью',
      custom_emoji_heavy: 'несколько кастомных эмодзи',
      paid_media: 'платный медиаконтент',
      giveaway_media: 'розыгрыш',
      story_share: 'репост истории',
      unknown_media: 'нераспознанное вложение',
      guest_bot_delivery: 'доставлено через гостевого бота',
      edited_message: 'сообщение отредактировано',
      edit_injected_invisibles: 'невидимые символы вставлены редактированием',
      edit_injected_link: 'ссылка добавлена редактированием',
      moderation_flagged: 'NSFW в тексте или фото',
      sole_avatar_replaced: 'единственное фото профиля, поставленное недавно на старом аккаунте',
      avatar_shared_with_account: 'то же фото профиля ещё на одном аккаунте',
      avatar_shared_with_accounts: 'то же фото профиля на нескольких аккаунтах',
      nsfw_avatar: 'NSFW на аватарке',
      suggestive_profile_media: 'откровенное медиа в профиле (намёк)',
      nsfw_stories: 'NSFW в историях',
      nsfw_linked_channel: 'NSFW на аватарке канала из профиля',
      promo_in_name: 'реклама в имени аккаунта',
      invisible_in_name: 'невидимые символы в имени',
      signature_candidate_match: 'похоже на известный спам',
      vector_similar_spam: 'семантически близко к спаму',
      velocity_repeats: 'тот же текст повторяется',
      velocity_wave: 'тот же текст с нескольких аккаунтов',
      bot_mention: 'упоминание бота',
      sender_burst: 'серия сообщений от одного аккаунта',
      burst_grey_repeat: 'серия, где несколько сообщений уже выглядели подозрительно'
    },
    decidedBy: {
      custom_rule: 'правило чата',
      deterministic: 'детерминированное правило',
      signature: 'база сигнатур',
      vector: 'семантический поиск',
      forward: 'чёрный список источников форвардов',
      velocity: 'кросс-чатовая скорость',
      moderation: 'модерация контента',
      llm: 'ИИ-анализ',
      llm_cached: 'ИИ-анализ (кеш)',
      session: 'анализ серии сообщений',
      burst: 'анализ серии от одного аккаунта',
      score: 'сумма сигналов',
      abstain: 'воздержался',
      error: 'ошибка'
    },
    expired: 'Это решение уже устарело — деталей не осталось.'
  },

  profile: {
    title: '👤 Профиль',
    openButton: '👤 Профиль',
    accountAge: (age) => `аккаунт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) =>
      `${messages} ${plural(messages, 'сообщение', 'сообщения', 'сообщений')} · ${chats} ${plural(chats, 'чат', 'чата', 'чатов')}`,
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'в спам-базах',
      ...(ago ? [`бан ${ago} назад`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'нарушение', 'нарушения', 'нарушений')}`] : [])
    ].join(' · '),
    justJoined: (ago) => `в чате всего ${ago}`,
    promoInBio: 'промо в био',
    personalChannel: 'привязанный канал',
    unknownAge: 'возраст неизвестен',
    neverSeen: 'впервые',
    units: { now: 'только что', m: 'м', h: 'ч', d: 'д', mo: 'мес', y: 'г' },
    checkNeedReply: 'Ответьте командой /check на сообщение пользователя.',
    notFound: 'Не удалось получить профиль.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Это спам?</b> Сообщение от ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Это спам?</b> Сообщение от ${userLabel} — без текста, только ${what}.`
        : `🤔 <b>Это спам?</b> Сообщение от ${userLabel} — без текста.`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'фото', sticker: 'стикер', video: 'видео',
      voice: 'аудио', file: 'файл', other: 'вложение'
    },
    redacted: { link: '[ссылка]', mention: '[@упоминание]', invite: '[приглашение]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голос засчитан.',
    enforcement: {
      done: 'Убрал.',
      deletedOnly: 'Убрал, но замолчать не заставил — не хватает прав.',
      mutedOnly: 'Замолчать заставил, а сообщение убрать не удалось.',
      failed: '⚠️ Ни убрать, ни ограничить не удалось — не хватает прав.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      (who ? `🗑 Сообщество решило: сообщение от ${who} — спам.` : '🗑 Сообщество решило: спам.')
      + (enforcement ? ` ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      (who ? `👌 Сообщество решило: сообщение от ${who} — не спам.` : '👌 Сообщество решило: не спам.')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Голосование уже закрыто.',
    voters: {
      button: '👥 Кто голосовал',
      title: (spam, ham) => `👥 <b>Голосование</b> · спам ${spam} : ${ham} норм`,
      spamGroup: '🗑 Спам',
      hamGroup: '👌 Норм',
      adminMark: 'админ',
      changedMark: 'изменил голос',
      span: (span) => `⏱ от первого до последнего голоса: ${span}`,
      more: (count) => `…и ещё ${count}`,
      nobody: 'Никто не успел проголосовать.',
      notForTarget: 'Это голосование о тебе.',
      noStanding: 'Голосуют те, кто уже освоился в чате.',
      knownBad: 'Твой голос здесь не считается.'
    }
  },

  report: {
    needReply: 'Сделай /report ответом на сообщение, которое хочешь зарепортить.',
    cantReportAdmin: 'Админов репортить нельзя.',
    rateLimited: 'Слишком много репортов. Подожди пару минут.',
    accepted: 'Принял, спасибо.',
    oneAtATime: 'Тут зашло несколько человек сразу. Ответь на сообщение того, на кого жалуешься.'
  },

  botStats: {
    title: '🛡 <b>Что я уже сделал</b>',
    window: (days) => `За последние ${days} ${plural(days, 'день', 'дня', 'дней')}:`,
    checked: (count) => `📬 <b>${groupDigits(count)}</b> ${plural(count, 'проверенное сообщение', 'проверенных сообщения', 'проверенных сообщений')}`,
    spammers: (count) => `🚫 <b>${groupDigits(count)}</b> ${plural(count, 'спамер заблокирован', 'спамера заблокировано', 'спамеров заблокировано')}`,
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
    chatLastSpam: (ago) => `Последний спам: ${ago} назад`,
    chatClean: '✨ За это время — ни одного спама.',
    unavailable: '📊 Цифры сейчас недоступны, попробуй чуть позже.',
    button: '📊 Мои цифры'
  },

  stats: {
    title: '📊 <b>Твоя статистика</b>',
    inChat: (count, chatTitle) => chatTitle ? `Сообщений в чате ${chatTitle}: ${count}` : `Сообщений в этом чате: ${count}`,
    global: (count) => `Сообщений всего: ${count}`,
    reputation: (score, status) => `Репутация: ${score} (${status})`,
    repStatus: { trusted: 'доверенный', neutral: 'нейтральный', suspicious: 'подозрительный', restricted: 'ограниченный' },
    bananCaught: (count) => `Бананов поймано: ${count} 🍌`,
    openInPm: 'Статистика придёт в личку.',
    openButton: '📊 Моя статистика'
  },

  top: {
    titleMessages: '🏆 <b>Самые активные в чате</b>',
    titleBanan: '🍌 <b>Топ по бананам</b>',
    empty: 'Пока нет статистики.',
    messagesUnit: (count) => (count % 10 === 1 && count % 100 !== 11 ? 'сообщение' : 'сообщений'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} вылетел из чата.`,
    needReply: 'Ответь командой /kick на сообщение того, кого хочешь выгнать.'
  },

  untrust: {
    success: (name) => `🔓 Снято доверие с ${name}. Его сообщения снова проходят проверку.`,
    needReply: 'Ответь командой /untrust на сообщение того, с кого хочешь снять доверие.',
    notTrusted: (name) => `${name} и так не в списке доверенных.`
  },

  trust: {
    button: '✅ Доверять',
    untrustButton: '🔓 Снять доверие',
    added: 'Добавил в доверенные этого чата.',
    removed: 'Снял доверие.'
  },

  welcome: {
    enabled: '👋 Приветствия включены.',
    disabled: '👋 Приветствия выключены.',
    textSet: '✅ Текст приветствия сохранён. Подстановка %name% работает.',
    gifSet: '✅ Гифка для приветствия сохранена.',
    usage: [
      '/welcome — включить/выключить',
      '/welcome <текст с %name%> — задать приветствие',
      'ответь гифкой на /welcome — задать гифку'
    ].join('\n'),
    limit: '⚠️ Достигнут лимит — сначала удали что-то в настройках.',
    duplicate: 'ℹ️ Это уже добавлено.',
    tooLong: '⚠️ Текст слишком длинный (макс. 1000 символов).',
    saveFailed: '⚠️ Не удалось сохранить.',
    surgeAlert: (count, riskCount) => `⚠️ Быстрые вступления · ${count} участников · ${riskCount} маркеров риска`,
    defaultGreeting: (name) => `👋 Добро пожаловать, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Приветствие новичков</b>\n\nСостояние: ${state}\nТекстов: ${nTexts} · Гифок: ${nGifs}\n\nЕсли их несколько — бот каждый раз берёт случайный.`,
      enable: '🔔 Включить',
      disable: '🔕 Выключить',
      texts: (n) => `📝 Тексты (${n})`,
      gifs: (n) => `🎞 Гифки (${n})`,
      preview: '👁 Предпросмотр',
      textsTitle: (n, max) => `📝 <b>Тексты приветствия</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тексты приветствия</b>\n\nПока пусто. Добавь первый — можно с <code>%name%</code> для имени новичка.',
      addText: '➕ Добавить текст',
      gifsTitle: (n, max) => `🎞 <b>Гифки приветствия</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 гифка #${i}`,
      gifsEmpty: '🎞 <b>Гифки приветствия</b>\n\nПока пусто. Добавь первую — пришли гифку, видео или фото.',
      addGif: '➕ Добавить гифку',
      promptText: '📝 Пришли текст приветствия одним сообщением.\nМожно вставить <code>%name%</code> — подставлю имя новичка.\n\n/cancel — отмена.',
      promptGif: '🎞 Пришли гифку, видео или фото одним сообщением.\n\n/cancel — отмена.',
      added: '✅ Добавлено.',
      cancelled: '❌ Отменено.',
      invalidGif: '⚠️ Это не медиа. Пришли гифку, видео или фото.',
      removed: '🗑 Удалено.',
      removeMissing: 'Этого уже нет — обновил список.',
      expired: '⌛ Время вышло. Открой редактор ещё раз.',
      previewEmpty: 'Пока нечего показать — добавь текст или гифку.'
    }
  },

  extra: {
    saved: (name) => `✅ Сохранил #${name}`,
    deleted: (name) => `🗑 Удалил #${name}`,
    notFound: (name) => `Нет такого: #${name}`,
    usage: [
      '/extra имя (в ответ на сообщение) — сохраню под #имя',
      '/extra имя (без ответа) — удалит триггер'
    ].join('\n'),
    listTitle: '📂 Сохранённые триггеры:',
    listEmpty: 'Здесь пока нет триггеров.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Триггеры</b> (${n})\n\nНапиши <code>#название</code> в чате — бот пришлёт сохранённое.\nМакс. срабатываний на сообщение: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Триггеры</b>\n\nПока пусто. Добавь первый — название + текст или медиа.',
      add: '➕ Добавить триггер',
      maxLabel: (n) => `Макс: ${n}`,
      promptName: '#️⃣ Введи название триггера (без #), одним словом.\n\n/cancel — отмена.',
      promptContent: (name) => `Теперь пришли содержимое для <code>#${name}</code> — текст или медиа (гифка/фото/видео).\n\n/cancel — отмена.`,
      added: (name) => `✅ Триггер #${name} сохранён.`,
      cancelled: '❌ Отменено.',
      invalidName: '⚠️ Название — одно слово без пробелов (буквы/цифры/_).',
      removed: '🗑 Удалено.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} получает банан на ${duration}`,
    lifted: (name) => `🍌 ${name} лишается банана`,
    self: (name, duration) => `🍌 ${name} сам себя забанил на ${duration}. Уважаю`,
    needReply: 'Сделай /banan ответом на сообщение, или /banan без реплая для себя.',
    undoButton: '↩️ Отменить',
    units: { m: 'мин', h: 'ч', d: 'дн' },
    show: (name) => `🍌 ${name} показывает банан`
  },

  captcha: {
    prompt: (name) => `👋 ${name}, жми кнопку и пиши дальше. Это быстрая проверка, что ты не бот.`,
    button: '🙋 Я человек',
    passed: 'Готово, пиши.',
    retry: 'Не удалось снять ограничение. Нажми ещё раз.',
    notForYou: 'Эта кнопка не для тебя.'
  },

  settings: {
    openInPm: 'Настройки доступны в личных сообщениях.',
    openInPmButton: '⚙️ Открыть настройки',
    title: '⚙️ <b>Настройки антиспама</b>',
    preset: 'Режим',
    presets: { soft: 'Мягкий', standard: 'Стандарт', strict: 'Строгий' },
    captcha: 'Капча для новичков',
    voting: 'Голосование сообщества',
    enabled: 'Антиспам',
    banDatabase: 'Базы спамеров',
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
