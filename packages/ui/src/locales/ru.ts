import type { Locale } from '../locale.js'

export const ru: Locale = {
  languageName: 'Русский',

  start: {
    privateCard: (name) => [
      `Привет, <b>${name}</b>! 👋`,
      '',
      '🛡 Антиспам для групп.',
      'Ловлю спам, баню мошенников, чищу рекламу.',
      '',
      'Добавь в группу → дай права админа → готово.'
    ].join('\n'),
    groupHint: '🛡 Ловлю спам, баню мошенников.\n<code>/settings</code> для админов · <code>/help</code> команды',
    addToGroupButton: '➕ Добавить в группу',
    helpButton: '❓ Команды',
    langButton: '🌐 Язык'
  },

  helpText: [
    '🛡 <b>Команды</b>',
    '/report — пожаловаться на спам (ответом)',
    '/settings — антиспам для админов (откроется в ЛС)',
    '/lang — язык',
    '',
    'Спам сношу сам. Под каждым действием есть <b>[🤨 За что?]</b> с причиной',
    'и <b>[✅ Не спам]</b> для админов: отменяет решение и учит меня.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Выбери язык:',
    saved: 'Готово, теперь по-русски'
  },

  actions: {
    captcha: '👋 проверка',
    delete: '🧹 спам удалён',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyButton: '🤨 За что?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, отменил. Юзер разблокирован и теперь в доверенных этого чата.',
    overrideAlreadyDone: 'Уже отменено.',
    adminOnly: 'Только для админов этого чата.',
    missingRights: '⚠️ Нашёл спам, но нет прав его убрать. Дайте мне права удалять сообщения и банить пользователей.'
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
    external_high_factor_new: 'аккаунт в базах спамеров',
    edit_injected_promo: 'в сообщение отредактирована реклама',
    private_invite_new: 'закрытое приглашение от нового аккаунта',
    identity_churn_promo: 'частая смена имени + реклама',
    hidden_url_new: 'скрытая ссылка от новичка',
    low_information: 'мало информации, наблюдаем',
    admin_report: 'админ зарепортил как спам',
    community_vote: 'сообщество проголосовало: спам',
    forward_blacklist: 'переслано из известного спам-источника'
  },
  reasonFallback: 'подозрительная активность',

  why: {
    title: '🛡 Почему я вмешался',
    confidence: {
      high: (percent) => `🔴 Очень похоже на спам · ${percent}%`,
      medium: (percent) => `🟠 Вероятно спам · ${percent}%`,
      low: (percent) => `🟡 Возможно спам · ${percent}%`
    },
    reasonLine: (reason) => `Причина: ${reason}`,
    noticedTitle: 'Что я заметил:',
    signalLabels: {
      external_ban: 'аккаунт в спам-базах',
      external_high_spam_factor: 'высокий спам-фактор в базах',
      scam_flag: 'Telegram пометил аккаунт как мошеннический',
      fake_flag: 'Telegram пометил аккаунт как фейковый',
      restricted_flag: 'аккаунт ограничен Telegram',
      sleeper_awakened: 'спящий аккаунт внезапно ожил',
      fresh_account: 'только что созданный аккаунт',
      new_globally: 'новичок в Telegram',
      new_in_chat: 'первое сообщение в этом чате',
      identity_churn_24h: 'частая смена имени / фото',
      avatar_recently_set: 'аватар поставлен только что',
      prior_spam_detections: 'раньше уже ловили на спаме',
      low_reputation: 'низкая репутация',
      unofficial_client_risk: 'отправлено из неофициального приложения',
      promo_bot: 'рекламный бот',
      forward_hidden_user: 'переслано от скрытого аккаунта',
      forward_source_suspicious: 'переслано из подозрительного источника',
      hidden_url: 'замаскированная ссылка',
      external_url: 'внешняя ссылка',
      url_shortener: 'сокращённая ссылка',
      private_invite_link: 'закрытая пригласительная ссылка',
      bot_deeplink: 'ссылка-запуск бота',
      messenger_contact_link: 'контакт в другом мессенджере',
      many_url_buttons: 'много ссылок-кнопок',
      phone_number: 'номер телефона',
      cashtag: 'упоминание криптовалюты / тикера',
      long_text: 'необычно длинный текст',
      invisible_in_word: 'невидимые символы внутри слов',
      mixed_script_word: 'смесь алфавитов в слове',
      custom_emoji_heavy: 'много кастомных эмодзи',
      paid_media: 'платный медиаконтент',
      giveaway_media: 'розыгрыш',
      story_share: 'репост истории',
      unknown_media: 'нераспознанное вложение',
      guest_bot_delivery: 'доставлено через гостевого бота',
      edited_message: 'сообщение отредактировано',
      edit_injected_promo: 'реклама вставлена редактированием'
    },
    messageTitle: 'Сообщение:',
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
      score: 'сумма сигналов',
      abstain: 'воздержался',
      error: 'ошибка'
    },
    expired: 'Это решение уже устарело — деталей не осталось.'
  },

  profile: {
    title: '👤 Профиль',
    accountAge: (age) => `аккаунт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) => `${messages} сообщений · ${chats} наших чатов`,
    reputation: (status) => `репутация: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'в спам-базах',
      ...(ago ? [`бан ${ago} назад`] : []),
      ...(offenses > 1 ? [`${offenses} нарушений`] : [])
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
    prompt: (userLabel, textPreview) => `🤔 Это спам? Сообщение от ${userLabel}:\n\n"${textPreview}"`,
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голос засчитан.',
    resolvedSpam: '🗑 Сообщество решило: спам. Убрал.',
    resolvedHam: '👌 Сообщество решило: не спам.',
    alreadyEnded: 'Голосование уже закрыто.'
  },

  report: {
    needReply: 'Сделай /report ответом на сообщение, которое хочешь зарепортить.',
    cantReportAdmin: 'Админов репортить нельзя.',
    rateLimited: 'Слишком много репортов. Подожди пару минут.',
    accepted: 'Принял, спасибо.'
  },

  stats: {
    title: '📊 Твоя статистика',
    inChat: (count) => `Сообщений в этом чате: ${count}`,
    global: (count) => `Сообщений всего: ${count}`,
    reputation: (score, status) => `Репутация: ${score} (${status})`,
    repStatus: { trusted: 'доверенный', neutral: 'нейтральный', suspicious: 'подозрительный', restricted: 'ограниченный' },
    bananCaught: (count) => `Бананов поймано: ${count} 🍌`,
    openInPm: 'Статистика придёт в личку.',
    openButton: '📊 Моя статистика'
  },

  top: {
    titleMessages: '🏆 Самые активные в чате',
    titleBanan: '🍌 Топ по бананам',
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

  welcome: {
    enabled: '👋 Приветствия включены.',
    disabled: '👋 Приветствия выключены.',
    textSet: '✅ Текст приветствия сохранён. Подстановка %name% работает.',
    gifSet: '✅ Гифка для приветствия сохранена.',
    usage: '/welcome — включить/выключить. /welcome текст с %name% — задать приветствие. Ответ гифкой на /welcome — задать гифку.',
    defaultGreeting: (name) => `👋 Добро пожаловать, ${name}!`
  },

  extra: {
    saved: (name) => `✅ Сохранил #${name}`,
    deleted: (name) => `🗑 Удалил #${name}`,
    notFound: (name) => `Нет такого: #${name}`,
    usage: 'Ответь на сообщение командой /extra имя — сохраню под #имя. /extra имя без ответа — удалит.',
    listTitle: '📂 Сохранённые триггеры:',
    listEmpty: 'Здесь пока нет триггеров.'
  },

  banan: {
    success: (name, duration) => `🍌 ${name} получает банан на ${duration}`,
    lifted: (name) => `🍌 ${name} лишается банана`,
    self: (name, duration) => `🍌 ${name} сам себя забанил на ${duration}. Уважаю`,
    needReply: 'Сделай /banan ответом на сообщение, или /banan без реплая для себя.',
    undoButton: '↩️ Отменить',
    units: { m: 'мин', h: 'ч', d: 'дн' }
  },

  captcha: {
    prompt: (name) => `👋 ${name}, жми кнопку и пиши дальше. Это быстрая проверка, что ты не бот.`,
    button: '🙋 Я человек',
    passed: 'Готово, пиши.',
    notForYou: 'Эта кнопка не для тебя.'
  },

  settings: {
    openInPm: 'Настройки доступны в личных сообщениях.',
    openInPmButton: '⚙️ Открыть настройки',
    title: 'Настройки антиспама',
    preset: 'Режим',
    presets: { soft: 'Мягкий', standard: 'Стандарт', strict: 'Строгий' },
    captcha: 'Капча для новичков',
    voting: 'Голосование сообщества',
    enabled: 'Антиспам',
    on: 'Включено',
    off: 'Выключено',
    back: '‹ Назад'
  }
}
