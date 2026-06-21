import type { Locale } from '../locale.js'

export const uk: Locale = {
  languageName: 'Українська',

  start: {
    privateCard: (name) => [
      `Привіт, <b>${name}</b>! 👋`,
      '',
      '🛡 <b>Антиспам для груп.</b>',
      'Ловлю спам, баню шахраїв, чищу рекламу.',
      '',
      'Додай у групу → дай права адміна → готово.'
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

  commands: {
    start: 'Почати роботу з ботом',
    help: 'Допомога і команди',
    lang: 'Вибрати мову',
    mystats: 'Моя статистика',
    report: 'Поскаржитись на спам (у відповідь)',
    settings: 'Налаштування антиспаму (адміни)',
    banan: 'Мут у відповідь (/banan 5m)',
    kick: 'Вигнати користувача (у відповідь)',
    del: 'Видалити повідомлення (у відповідь)',
    untrust: 'Зняти довіру (у відповідь)',
    check: 'Перевірити профіль (у відповідь)',
    top: 'Топ активних учасників',
    topBanan: 'Топ за бананами',
    extras: 'Збережені тригери',
    welcome: 'Привітання новачків',
    ping: 'Перевірити, чи бот живий'
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
    title: '🛡 Чому я втрутився',
    confidence: {
      high: (percent) => `🔴 Дуже схоже на спам · ${percent}%`,
      medium: (percent) => `🟠 Імовірно спам · ${percent}%`,
      low: (percent) => `🟡 Можливо спам · ${percent}%`
    },
    reasonLine: (reason) => `Причина: ${reason}`,
    noticedTitle: 'Що я помітив:',
    signalLabels: {
      external_ban: 'акаунт у спам-базах',
      external_repeat_offender: 'кілька разів у спам-базах',
      fresh_external_ban: 'нещодавно потрапив у спам-бази',
      many_shared_chats: 'одразу в багатьох наших чатах',
      promo_in_bio: 'реклама або контакт у біо',
      personal_channel: 'канал прив’язаний до профілю',
      restricted_for_spam: 'Telegram обмежив за спам',
      just_joined: 'щойно зайшов і одразу пише',
      scam_flag: 'Telegram позначив акаунт як шахрайський',
      fake_flag: 'Telegram позначив акаунт як фейковий',
      restricted_flag: 'акаунт обмежений Telegram',
      sleeper_awakened: 'сплячий акаунт раптом ожив',
      fresh_account: 'щойно створений акаунт',
      new_globally: 'новачок у Telegram',
      new_in_chat: 'перше повідомлення в цьому чаті',
      identity_churn_24h: 'часта зміна імені / фото',
      avatar_recently_set: 'аватар поставлено щойно',
      prior_spam_detections: 'раніше вже ловили на спамі',
      low_reputation: 'низька репутація',
      unofficial_client_risk: 'надіслано з неофіційного застосунку',
      promo_bot: 'рекламний бот',
      forward_hidden_user: 'переслано від прихованого акаунта',
      forward_source_suspicious: 'переслано з підозрілого джерела',
      hidden_url: 'замасковане посилання',
      external_url: 'зовнішнє посилання',
      url_shortener: 'скорочене посилання',
      private_invite_link: 'закрите запрошувальне посилання',
      bot_deeplink: 'посилання-запуск бота',
      messenger_contact_link: 'контакт в іншому месенджері',
      many_url_buttons: 'багато посилань-кнопок',
      phone_number: 'номер телефону',
      cashtag: 'згадка криптовалюти / тікера',
      long_text: 'незвично довгий текст',
      invisible_in_word: 'невидимі символи всередині слів',
      mixed_script_word: 'мішанина алфавітів у слові',
      custom_emoji_heavy: 'багато кастомних емодзі',
      paid_media: 'платний медіаконтент',
      giveaway_media: 'розіграш',
      story_share: 'поширена сторіс',
      unknown_media: 'нерозпізнане вкладення',
      guest_bot_delivery: 'доставлено через гостьового бота',
      edited_message: 'повідомлення відредаговано',
      edit_injected_promo: 'рекламу вставлено редагуванням'
    },
    messageTitle: 'Повідомлення:',
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
    expired: 'Це рішення вже застаріло — деталей не лишилось.'
  },

  profile: {
    title: '👤 Профіль',
    accountAge: (age) => `акаунт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) => `${messages} повідомлень · ${chats} наших чатів`,
    reputation: (status) => `репутація: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'у спам-базах',
      ...(ago ? [`бан ${ago} тому`] : []),
      ...(offenses > 1 ? [`${offenses} порушень`] : [])
    ].join(' · '),
    justJoined: (ago) => `у чаті лише ${ago}`,
    promoInBio: 'промо в біо',
    personalChannel: 'лінкований канал',
    unknownAge: 'вік невідомий',
    neverSeen: 'вперше',
    units: { now: 'щойно', m: 'хв', h: 'год', d: 'д', mo: 'міс', y: 'р' },
    checkNeedReply: 'Відповідайте командою /check на повідомлення користувача.',
    notFound: 'Не вдалося отримати профіль.'
  },

  vote: {
    prompt: (userLabel, textPreview) => `🤔 <b>Це спам?</b> Повідомлення від ${userLabel}:\n\n"${textPreview}"`,
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
    title: '📊 <b>Твоя статистика</b>',
    inChat: (count) => `Повідомлень у цьому чаті: ${count}`,
    global: (count) => `Повідомлень всюди: ${count}`,
    reputation: (score, status) => `Репутація: ${score} (${status})`,
    repStatus: { trusted: 'довірений', neutral: 'нейтральний', suspicious: 'підозрілий', restricted: 'обмежений' },
    bananCaught: (count) => `Бананів зловлено: ${count} 🍌`,
    openInPm: 'Статистика прийде в особисті.',
    openButton: '📊 Моя статистика'
  },

  top: {
    titleMessages: '🏆 <b>Найактивніші в чаті</b>',
    titleBanan: '🍌 <b>Топ за бананами</b>',
    empty: 'Поки нема статистики.',
    messagesUnit: (count) => (count % 10 === 1 && count % 100 !== 11 ? 'повідомлення' : 'повідомлень'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} вилетів із чату.`,
    needReply: 'Зроби /kick відповіддю на повідомлення того, кого хочеш вигнати.'
  },

  untrust: {
    success: (name) => `🔓 Знято довіру з ${name}. Його повідомлення знову проходять перевірку.`,
    needReply: 'Зроби /untrust відповіддю на повідомлення того, з кого хочеш зняти довіру.',
    notTrusted: (name) => `${name} і так не у списку довірених.`
  },

  welcome: {
    enabled: '👋 Вітання увімкнено.',
    disabled: '👋 Вітання вимкнено.',
    textSet: '✅ Текст вітання збережено. Підстановка %name% працює.',
    gifSet: '✅ Гіфку для вітання збережено.',
    usage: [
      '/welcome — увімкнути/вимкнути',
      '/welcome <текст з %name%> — задати привітання',
      'відповідь гіфкою на /welcome — задати гіфку'
    ].join('\n'),
    defaultGreeting: (name) => `👋 Вітаємо, ${name}!`
  },

  extra: {
    saved: (name) => `✅ Збережено #${name}`,
    deleted: (name) => `🗑 Видалено #${name}`,
    notFound: (name) => `Нема такого: #${name}`,
    usage: [
      '/extra назва (у відповідь на повідомлення) — збережу його під #назва',
      '/extra назва (без відповіді) — видалить тригер'
    ].join('\n'),
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
    title: '⚙️ <b>Налаштування антиспаму</b>',
    preset: 'Режим',
    presets: { soft: 'М’який', standard: 'Стандарт', strict: 'Суворий' },
    captcha: 'Капча для новачків',
    voting: 'Голосування спільноти',
    enabled: 'Антиспам',
    banDatabase: 'Бази спамерів',
    language: 'Мова бота в чаті',
    languageSaved: 'Мову чату оновлено',
    on: 'Увімкнено',
    off: 'Вимкнено',
    back: '‹ Назад'
  }
}
