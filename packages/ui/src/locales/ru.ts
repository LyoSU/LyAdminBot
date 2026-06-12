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
    adminOnly: 'Только для админов этого чата.'
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
    title: 'Почему это решение',
    probability: (percent) => `Вероятность спама: ${percent}%`,
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
    evidenceTitle: 'Доказательство',
    signalsTitle: 'Сигналы',
    expired: 'Это решение уже устарело — деталей не осталось.'
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
