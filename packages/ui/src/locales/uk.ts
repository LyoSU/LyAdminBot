import type { Locale } from '../locale.js'

export const uk: Locale = {
  languageName: 'Українська',

  start: {
    privateCard: (name) => [
      `Йо, <b>${name}</b>! 👋`,
      '',
      '🛡 Антиспам для груп.',
      'Ловлю спам, баню шахраїв, чищу рекламу.',
      '',
      'Додай в групу → дай права адміна → готово.'
    ].join('\n'),
    groupHint: '🛡 Ловлю спам, баню шахраїв.\n<code>/settings</code> для адмінів · <code>/help</code> команди',
    addToGroupButton: '➕ Додати в групу',
    helpButton: '❓ Команди',
    langButton: '🌐 Мова'
  },

  helpText: [
    '🛡 <b>Команди</b>',
    '/report — скарга на спам (у відповідь)',
    '/settings — антиспам для адмінів (відкриється в ПП)',
    '/lang — мова',
    '',
    'Спам зношу сам. Під кожною дією є <b>[🤨 За що?]</b> з поясненням',
    'і <b>[✅ Не спам]</b> для адмінів: скасовує рішення і вчить мене.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Обери мову:',
    saved: 'Готово, тепер українською'
  },

  actions: {
    captcha: '👋 перевірка',
    delete: '🧹 спам видалено',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyButton: '🤨 За що?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, скасував. Юзер розблокований і тепер у довірених цього чату.',
    overrideAlreadyDone: 'Уже скасовано.',
    adminOnly: 'Тільки для адмінів цього чату.',
    missingRights: '⚠️ Знайшов спам, але не маю прав його прибрати. Дайте мені права видаляти повідомлення та банити користувачів.'
  },

  reasons: {
    job_scam: 'схоже на шахрайську "вакансію"',
    crypto_scam: 'криптошахрайство',
    gambling_promo: 'реклама казино/ставок',
    adult_promo: 'реклама 18+',
    ad_network: 'продаж реклами/розміщень',
    flirt_bait: 'флірт-приманка',
    phishing: 'фішингове посилання',
    channel_promo: 'непрохана реклама каналу',
    guest_bot_promo: 'промо через гостьового бота',
    flood: 'флуд/масова розсилка',
    prompt_injection: 'спроба обдурити модерацію',
    other_spam: 'спам',
    known_spam_signature: 'збіг із підтвердженим спамом',
    semantic_spam_match: 'дуже схоже на відомий спам',
    velocity_exceeded: 'те саме повідомлення в кількох чатах поспіль',
    custom_deny: 'заборонено правилом чату',
    scam_flag_new: 'Telegram позначив акаунт як шахрайський',
    external_ban_new: 'акаунт у базах спамерів',
    external_high_factor_new: 'акаунт у базах спамерів',
    edit_injected_promo: 'у повідомлення відредаговано рекламу',
    private_invite_new: 'закрите запрошення від нового акаунта',
    identity_churn_promo: 'часта зміна імені + реклама',
    hidden_url_new: 'приховане посилання від новачка',
    low_information: 'недостатньо інформації, спостерігаємо',
    admin_report: 'адмін репортнув як спам',
    community_vote: 'спільнота проголосувала: спам',
    forward_blacklist: 'переслано з відомого спам-джерела'
  },
  reasonFallback: 'підозріла активність',

  why: {
    title: 'Чому це рішення',
    probability: (percent) => `Імовірність спаму: ${percent}%`,
    decidedBy: {
      custom_rule: 'правило чату',
      deterministic: 'детерміноване правило',
      signature: 'база сигнатур',
      vector: 'семантичний пошук',
      forward: 'чорний список джерел форвардів',
      velocity: 'крос-чатова швидкість',
      moderation: 'модерація контенту',
      llm: 'ШІ-аналіз',
      llm_cached: 'ШІ-аналіз (кеш)',
      session: 'аналіз серії повідомлень',
      score: 'сума сигналів',
      abstain: 'утримання',
      error: 'помилка'
    },
    evidenceTitle: 'Доказ',
    signalsTitle: 'Сигнали',
    expired: 'Це рішення вже застаріло — деталей не лишилось.'
  },

  vote: {
    prompt: (userLabel, textPreview) => `🤔 Це спам? Повідомлення від ${userLabel}:\n\n"${textPreview}"`,
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голос зараховано.',
    resolvedSpam: '🗑 Спільнота вирішила: спам. Прибрав.',
    resolvedHam: '👌 Спільнота вирішила: не спам.',
    alreadyEnded: 'Голосування вже закрите.'
  },

  report: {
    needReply: 'Зроби /report відповіддю на повідомлення, яке хочеш репортнути.',
    cantReportAdmin: 'Адмінів репортити не можна.',
    rateLimited: 'Забагато репортів. Почекай кілька хвилин.',
    accepted: 'Прийняв, дякую.'
  },

  stats: {
    title: '📊 Твоя статистика',
    inChat: (count) => `Повідомлень у цьому чаті: ${count}`,
    global: (count) => `Повідомлень всюди: ${count}`,
    reputation: (score, status) => `Репутація: ${score} (${status})`,
    repStatus: { trusted: 'довірений', neutral: 'нейтральний', suspicious: 'підозрілий', restricted: 'обмежений' },
    bananCaught: (count) => `Бананів зловлено: ${count} 🍌`,
    openInPm: 'Статистика прийде в особисті.',
    openButton: '📊 Моя статистика'
  },

  top: {
    titleMessages: '🏆 Найактивніші в чаті',
    titleBanan: '🍌 Топ за бананами',
    empty: 'Поки нема статистики.',
    messagesUnit: (count) => (count % 10 === 1 && count % 100 !== 11 ? 'повідомлення' : 'повідомлень'),
    bananUnit: () => '🍌'
  },

  welcome: {
    enabled: '👋 Вітання увімкнено.',
    disabled: '👋 Вітання вимкнено.',
    textSet: '✅ Текст вітання збережено. Підстановка %name% працює.',
    gifSet: '✅ Гіфку для вітання збережено.',
    usage: '/welcome — увімкнути/вимкнути. /welcome текст з %name% — задати привітання. Відповідь гіфкою на /welcome — задати гіфку.',
    defaultGreeting: (name) => `👋 Вітаємо, ${name}!`
  },

  extra: {
    saved: (name) => `✅ Збережено #${name}`,
    deleted: (name) => `🗑 Видалено #${name}`,
    notFound: (name) => `Нема такого: #${name}`,
    usage: 'Відповідай на повідомлення командою /extra назва — збережу його під #назва. /extra назва без відповіді — видалить.',
    listTitle: '📂 Збережені тригери:',
    listEmpty: 'Тут поки нема тригерів.'
  },

  banan: {
    success: (name, duration) => `🍌 ${name} отримує банан на ${duration}`,
    lifted: (name) => `🍌 ${name} позбавляється банана`,
    self: (name, duration) => `🍌 ${name} сам себе забанив на ${duration}. Поважаю`,
    needReply: 'Зроби /banan відповіддю на повідомлення, або /banan без реплая для себе.',
    undoButton: '↩️ Скасувати',
    units: { m: 'хв', h: 'год', d: 'дн' }
  },

  captcha: {
    prompt: (name) => `👋 ${name}, тисни кнопку і пиши далі. Це швидка перевірка, що ти не бот.`,
    button: '🙋 Я людина',
    passed: 'Готово, пиши.',
    notForYou: 'Ця кнопка не для тебе.'
  },

  settings: {
    openInPm: 'Налаштування доступні в особистих повідомленнях.',
    openInPmButton: '⚙️ Відкрити налаштування',
    title: 'Налаштування антиспаму',
    preset: 'Режим',
    presets: { soft: 'М’який', standard: 'Стандарт', strict: 'Суворий' },
    captcha: 'Капча для новачків',
    voting: 'Голосування спільноти',
    enabled: 'Антиспам',
    on: 'Увімкнено',
    off: 'Вимкнено',
    back: '‹ Назад'
  }
}
