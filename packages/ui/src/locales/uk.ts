import type { Locale } from '../locale.js'

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
    '🛡 <b>Що я вмію</b>',
    'Ловлю спам і баню шахраїв сам. Більшість дій — кнопками, не командами.',
    '',
    '<b>Усім:</b>',
    '/report — скарга на спам (у відповідь)',
    '/mystats — моя статистика · /top, /top_banan — рейтинги',
    '/lang — мова',
    '',
    '<b>Адмінам:</b>',
    '/settings — панель налаштувань (у ПП, далі все кнопками)',
    '/banan /kick /del — модерація у відповідь',
    '/check — картка користувача з кнопками (довіра тощо)',
    '/welcome — привітання новачків · /extra, /extras — тригери',
    '',
    'У кожному сповіщенні є посилання <b>за що?</b> — там уся картка рішення. Адмінам ще й <b>[✅ Не спам]</b>.'
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
    kick: '🚪 вилучено з чату',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за що?',
    whyButton: '🤨 За що?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Ок, скасував. Юзер розблокований і тепер у довірених цього чату.',
    overridePartial: 'Скасував, але не все вдалося застосувати. Спробуй ще раз або перевір мої права.',
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
    edit_injected_invisibles: 'невидимі символи вставлено редагуванням',
    private_invite_new: 'закрите запрошення від нового акаунта',
    identity_churn_promo: 'часта зміна імені + реклама',
    nsfw_promo_profile: 'профіль сам є рекламою (відверте медіа + канал у профілі)',
    hidden_url_new: 'приховане посилання від новачка',
    low_information: 'недостатньо інформації, спостерігаємо',
    low_information_profile: 'мало інформації, але профіль підозрілий — просимо підтвердити',
    content_unconfirmed: 'підозрілий профіль, але зміст не підтверджено',
    admin_report: 'адмін репортнув як спам',
    community_vote: 'спільнота проголосувала: спам',
    forward_blacklist: 'переслано з відомого спам-джерела'
  },
  reasonFallback: 'підозріла активність',

  why: {
    title: '🛡 Чому я втрутився',
    inChat: (chatTitle) => `у чаті ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Дуже схоже на спам · ${percent}%`,
      medium: (percent) => `🟠 Імовірно спам · ${percent}%`,
      low: (percent) => `🟡 Можливо спам · ${percent}%`
    },
    noticedTitle: 'Що я помітив:',
    signalLabels: {
      external_ban: 'акаунт у спам-базах',
      external_repeat_offender: 'кілька разів у спам-базах',
      fresh_external_ban: 'нещодавно потрапив у спам-бази',
      many_shared_chats: 'одразу в багатьох наших чатах',
      promo_in_bio: 'рекламне посилання в біо',
      private_invite_in_bio: 'запрошення до закритого каналу в біо',
      contact_in_bio: 'контакт поза Telegram у біо',
      personal_channel: 'канал прив’язаний до профілю',
      promo_in_linked_channel: 'канал з профілю рекламує сам себе',
      promo_in_message_link: 'посилання веде на рекламний канал',
      restricted_for_spam: 'Telegram обмежив за спам',
      just_joined: 'щойно зайшов і одразу пише',
      joined_during_surge: 'приєднався під час напливу нових учасників',
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
      foreign_script: 'написано незвичним для чату письмом',
      custom_emoji_heavy: 'багато кастомних емодзі',
      paid_media: 'платний медіаконтент',
      giveaway_media: 'розіграш',
      story_share: 'поширена сторіс',
      unknown_media: 'нерозпізнане вкладення',
      guest_bot_delivery: 'доставлено через гостьового бота',
      edited_message: 'повідомлення відредаговано',
      edit_injected_invisibles: 'невидимі символи вставлено редагуванням',
      edit_injected_link: 'посилання додано редагуванням',
      moderation_flagged: 'NSFW у тексті або фото',
      nsfw_avatar: 'NSFW на аватарці',
      suggestive_profile_media: 'відверте медіа в профілі (натяк)',
      nsfw_stories: 'NSFW у сторіс',
      nsfw_linked_channel: 'NSFW на аватарці каналу з профілю',
      promo_in_name: 'реклама в імені акаунта',
      invisible_in_name: 'невидимі символи в імені',
      signature_candidate_match: 'схоже на відомий спам',
      vector_similar_spam: 'семантично близьке до спаму',
      velocity_repeats: 'той самий текст повторюється',
      velocity_wave: 'той самий текст із кількох акаунтів',
      bot_mention: 'згадка бота',
      sender_burst: 'серія повідомлень від одного акаунта',
      burst_grey_repeat: 'серія, де кілька повідомлень уже виглядали підозріло'
    },
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
      burst: 'аналіз серії від одного акаунта',
      score: 'сума сигналів',
      abstain: 'утримання',
      error: 'помилка'
    },
    expired: 'Це рішення вже застаріло — деталей не лишилось.'
  },

  profile: {
    title: '👤 Профіль',
    openButton: '👤 Профіль',
    accountAge: (age) => `акаунт ${age}`,
    firstSeen: (seen) => `у нас ${seen}`,
    activity: (messages, chats) =>
      `${messages} ${plural(messages, 'повідомлення', 'повідомлення', 'повідомлень')} · ${chats} ${plural(chats, 'чат', 'чати', 'чатів')}`,
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'у спам-базах',
      ...(ago ? [`бан ${ago} тому`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'порушення', 'порушення', 'порушень')}`] : [])
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
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Це спам?</b> Повідомлення від ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n<pre>${textPreview}</pre>`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Це спам?</b> Повідомлення від ${userLabel} — без тексту, лише ${what}.`
        : `🤔 <b>Це спам?</b> Повідомлення від ${userLabel} — без тексту.`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'світлина', sticker: 'стікер', video: 'відео',
      voice: 'аудіо', file: 'файл', other: 'вкладення'
    },
    redacted: { link: '[посилання]', mention: '[@згадка]', invite: '[запрошення]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `👌 Норм (${count})`,
    counted: 'Голос зараховано.',
    enforcement: {
      done: 'Прибрав.',
      deletedOnly: 'Прибрав, але замовкнути не змусив — бракує прав.',
      mutedOnly: 'Замовкнути змусив, а повідомлення прибрати не вдалося.',
      failed: '⚠️ Ні прибрати, ні обмежити не вдалося — бракує прав.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      (who ? `🗑 Спільнота вирішила: повідомлення від ${who} — спам.` : '🗑 Спільнота вирішила: спам.')
      + (enforcement ? ` ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      (who ? `👌 Спільнота вирішила: повідомлення від ${who} — не спам.` : '👌 Спільнота вирішила: не спам.')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Голосування вже закрите.',
    voters: {
      button: '👥 Хто голосував',
      title: (spam, ham) => `👥 <b>Голосування</b> · спам ${spam} : ${ham} норм`,
      spamGroup: '🗑 Спам',
      hamGroup: '👌 Норм',
      adminMark: 'адмін',
      changedMark: 'змінив голос',
      span: (span) => `⏱ від першого до останнього голосу: ${span}`,
      more: (count) => `…і ще ${count}`,
      nobody: 'Ніхто не встиг проголосувати.',
      notForTarget: 'Це голосування про тебе.',
      noStanding: 'Голосують ті, хто вже освоївся в чаті.',
      knownBad: 'Твій голос тут не рахується.'
    }
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

  trust: {
    button: '✅ Довіряти',
    untrustButton: '🔓 Зняти довіру',
    added: 'Додав у довірені цього чату.',
    removed: 'Зняв довіру.'
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
    limit: '⚠️ Досягнуто ліміту — спершу видали щось у налаштуваннях.',
    duplicate: 'ℹ️ Це вже додано.',
    tooLong: '⚠️ Текст задовгий (макс. 1000 символів).',
    saveFailed: '⚠️ Не вдалося зберегти.',
    surgeAlert: (count, riskCount) => `⚠️ Швидкі вступи · ${count} учасників · ${riskCount} маркерів ризику`,
    defaultGreeting: (name) => `👋 Вітаємо, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Привітання новачків</b>\n\nСтан: ${state}\nТекстів: ${nTexts} · Гіфок: ${nGifs}\n\nЯкщо є кілька — бот щоразу обирає випадковий.`,
      enable: '🔔 Увімкнути',
      disable: '🔕 Вимкнути',
      texts: (n) => `📝 Тексти (${n})`,
      gifs: (n) => `🎞 Гіфки (${n})`,
      preview: '👁 Переглянути',
      textsTitle: (n, max) => `📝 <b>Тексти привітання</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тексти привітання</b>\n\nПоки порожньо. Додай перший — можна з <code>%name%</code> для імені новачка.',
      addText: '➕ Додати текст',
      gifsTitle: (n, max) => `🎞 <b>Гіфки привітання</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 гіфка #${i}`,
      gifsEmpty: '🎞 <b>Гіфки привітання</b>\n\nПоки порожньо. Додай першу — надішли гіфку, відео чи фото.',
      addGif: '➕ Додати гіфку',
      promptText: '📝 Надішли текст привітання одним повідомленням.\nМожна вставити <code>%name%</code> — підставлю ім’я новачка.\n\n/cancel — скасувати.',
      promptGif: '🎞 Надішли гіфку, відео або фото одним повідомленням.\n\n/cancel — скасувати.',
      added: '✅ Додано.',
      cancelled: '❌ Скасовано.',
      invalidGif: '⚠️ Це не медіа. Надішли гіфку, відео або фото.',
      removed: '🗑 Видалено.',
      previewEmpty: 'Поки нема що показати — додай текст або гіфку.'
    }
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
    listEmpty: 'Тут поки нема тригерів.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Тригери</b> (${n})\n\nНапиши <code>#назва</code> в чаті — бот надішле збережене.\nМакс. спрацювань на повідомлення: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Тригери</b>\n\nПоки порожньо. Додай перший — назва + текст або медіа.',
      add: '➕ Додати тригер',
      maxLabel: (n) => `Макс: ${n}`,
      promptName: '#️⃣ Введи назву тригера (без #), одним словом.\n\n/cancel — скасувати.',
      promptContent: (name) => `Тепер надішли вміст для <code>#${name}</code> — текст або медіа (гіфка/фото/відео).\n\n/cancel — скасувати.`,
      added: (name) => `✅ Тригер #${name} збережено.`,
      cancelled: '❌ Скасовано.',
      invalidName: '⚠️ Назва має бути одним словом без пробілів (літери/цифри/_).',
      removed: '🗑 Видалено.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} отримує банан на ${duration}`,
    lifted: (name) => `🍌 ${name} позбавляється банана`,
    self: (name, duration) => `🍌 ${name} сам себе забанив на ${duration}. Поважаю`,
    needReply: 'Зроби /banan відповіддю на повідомлення, або /banan без реплая для себе.',
    undoButton: '↩️ Скасувати',
    units: { m: 'хв', h: 'год', d: 'дн' },
    show: (name) => `🍌 ${name} показує банан`
  },

  captcha: {
    prompt: (name) => `👋 ${name}, тисни кнопку і пиши далі. Це швидка перевірка, що ти не бот.`,
    button: '🙋 Я людина',
    passed: 'Готово, пиши.',
    retry: 'Не вдалося зняти обмеження. Тисни ще раз.',
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
    banan: 'Тривалість банана',
    language: 'Мова бота в чаті',
    languageSaved: 'Мову чату оновлено',
    welcome: '👋 Привітання',
    extras: '#️⃣ Тригери',
    on: 'Увімкнено',
    off: 'Вимкнено',
    back: '‹ Назад'
  }
}
