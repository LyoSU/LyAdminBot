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
 * "щойно" is already a point in time: "щойно тому" is not Ukrainian. Every
 * "<span> тому" in this file goes through here, so a span under a minute reads
 * as itself wherever an elapsed time is printed.
 */
const NOW = 'щойно'
const ago = (span: string): string => (span === NOW ? NOW : `${span} тому`)

/** First-seen placeholder: the profile line reads it as a phrase, not a span. */
const NEVER_SEEN = 'уперше'

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
    liveProof: (chats, spammers, days) =>
      `📊 Зараз захищаю <b>${groupDigits(chats)}</b> ${plural(chats, 'чат', 'чати', 'чатів')}, ` +
      `за ${days} ${plural(days, 'день', 'дні', 'днів')} заблокував <b>${groupDigits(spammers)}</b> ${plural(spammers, 'спамера', 'спамерів', 'спамерів')}.`,
    groupHint: '🛡 Ловлю спам, баню шахраїв.\n<code>/settings</code> для адмінів · <code>/stats</code> цифри · <code>/help</code> команди',
    addToGroupButton: '➕ Додати в групу',
    helpButton: '❓ Команди',
    langButton: '🌐 Мова'
  },
  arrivals: {
    button: '👥 Нові учасники',
    title: '👥 <b>Хто прийшов у чат за тиждень</b>',
    empty: 'За тиждень бот не помітив у цьому чаті нових учасників.',
    silent: 'мовчить',
    spoke: (count) => `повідомлень: ${count}`,
    suspect: 'вхід разом зі спамером',
    outcomes: {
      removed: 'прибрано',
      banned_on_record: 'забанено за спам-базами',
      banned_carried: 'забанено в іншому чаті за спам',
      banned_by_admin: 'забанено адміном',
      gated: 'на перевірці'
    },
    footer: '⚠️ — вхід разом зі спамером і схожий профіль. «🚫 N» банить учасника під номером N.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Забанити всіх, хто мовчить (${count})`,
    confirmAll: (count) => `Забанити <b>${count}</b> ${plural(count, 'новачка, який досі нічого не написав', 'новачків, які досі нічого не написали', 'новачків, які досі нічого не написали')}?`,
    confirmYes: '🚫 Так, забанити',
    cancel: 'Скасувати',
    banned: (count) => `Забанено: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>Разом зі спамером ${plural(count, 'прийшов', 'прийшли', 'прийшло')} ще ${count} ${plural(count, 'схожий новачок', 'схожі новачки', 'схожих новачків')}</b>\nСпамер: ${spammer}`,
    hint: 'Схожий профіль, вхід у той самий час, жодного повідомлення. Бот нікого не обмежував — вирішує адмін.',
    banButton: (count) => `🚫 Забанити ${count}`,
    keepButton: 'Лишити',
    banned: (done, total, admin) => `🚫 Новачків, що прийшли разом зі спамером, забанено: ${done} з ${total} · ${admin}`,
    kept: (admin) => `✅ Новачки лишаються в чаті · ${admin}`,
    expired: 'Ця картка вже неактуальна.'
  },

  chatActions: {
    button: '🧾 Останні дії',
    title: '🧾 <b>Останні дії бота в чаті</b>',
    empty: 'Поки порожньо: у цьому чаті бот ще нічого не робив.',
    footer: '«За що?» відкриває доказ і кнопку «Не спам», якщо бот помилився.'
  },

  ownRestrictions: {
    title: '🧾 <b>Мої рішення про тебе</b>',
    ago,
    endsIn: (span) => `спливе через ${span}`,
    ended: 'вже спливло',
    permanent: 'без строку',
    overturned: '↩️ скасовано',
    unknownChat: 'чат без назви',
    footer: [
      'Це автоматичні рішення бота, не адміністраторів.',
      'Якщо я помилився — напиши адміну того чату: адмін може скасувати це одним дотиком.',
      'Обмеження на строк спливають самі.'
    ].join('\n'),
    whyButton: (n) => `За що? · ${n}`
  },

  helpText: [
    '🛡 <b>Що я вмію</b>',
    'Ловлю спам і баню шахраїв сам. Більшість дій — кнопками, не командами.',
    '',
    '<b>Усім:</b>',
    '/report — скарга на спам (у відповідь, або /report @нік чи id)',
    '/stats — скільки спаму я вже зловив',
    '/mystats — моя статистика · /top, /top_banan — рейтинги',
    '/lang — мова',
    '',
    '<b>Адмінам:</b>',
    '/settings — панель налаштувань (у ПП, далі все кнопками)',
    '/banan /kick /del — модерація у відповідь',
    '/check — картка користувача з кнопкою довіри · /untrust — зняти довіру',
    '/welcome — привітання новачків · /extra, /extras — тригери',
    '',
    'У кожному сповіщенні є посилання <b>за що?</b> — там уся картка рішення. Адмінам ще й <b>[✅ Не спам]</b>: скасовує рішення й додає людину в довірені чату.'
  ].join('\n'),

  writeFailed: '⚠️ Не зберіг — спробуй ще раз.',
  hiddenName: (userId) => `користувач ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Група: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Обери мову:',
    saved: 'Готово, тепер українською',
    openInPm: 'Свою мову вибереш у приватному чаті з ботом — тисни кнопку.',
    openButton: '🌐 Вибрати мову'
  },

  commands: {
    start: 'Почати роботу з ботом',
    help: 'Допомога і команди',
    lang: 'Вибрати мову',
    mystats: 'Моя статистика',
    stats: 'Скільки спаму я вже зловив',
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
    delete: '🧹 повідомлення видалено',
    kick: '🚪 вигнано з чату',
    mute: '🔇 мут',
    ban: '🔨 бан'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'за що?',
    whyButton: 'ℹ️ За що?',
    notSpamButton: '✅ Не спам',
    overrideDone: 'Скасовано: обмеження знято, акаунт тепер у довірених цього чату.',
    overridePartial: '⚠️ Скасовано не повністю: не вдалося зняти обмеження чи додати в довірені. Перевір мої права й натисни ще раз.',
    overrideAlreadyDone: 'Уже скасовано.',
    adminOnly: 'Тільки для адмінів цього чату.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` За добу так ${plural(accounts, 'лишився', 'лишилося', 'лишилося')} ${accounts} ${plural(accounts, 'акаунт', 'акаунти', 'акаунтів')}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Спам видаляю, але самих спамерів прибрати не можу — бракує права «Блокувати користувачів».${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Спамерів блокую, але їхні повідомлення видалити не можу — бракує права «Видаляти повідомлення».'
      }
      return `⚠️ Знайшов спам, але не маю прав нічого зробити. Дай мені права «Видаляти повідомлення» та «Блокувати користувачів».${left}`
    }
  },

  reasons: {
    job_scam: 'схоже на шахрайську пропозицію роботи',
    crypto_scam: 'криптошахрайство',
    gambling_promo: 'реклама казино чи ставок',
    adult_promo: 'реклама 18+',
    ad_network: 'продаж реклами й розміщень',
    flirt_bait: 'флірт-приманка',
    phishing: 'фішингове посилання',
    channel_promo: 'непрохана реклама каналу',
    guest_bot_promo: 'реклама через бота, викликаного згадкою',
    flood: 'флуд або масова розсилка',
    prompt_injection: 'спроба обійти антиспам-перевірку',
    other_spam: 'спам',
    known_spam_signature: 'збіг із підтвердженим спамом',
    semantic_spam_match: 'дуже схоже на відомий спам',
    velocity_exceeded: 'те саме повідомлення в кількох чатах поспіль',
    custom_deny: 'заборонено правилом чату',
    scam_flag_new: 'Telegram позначив акаунт як шахрайський',
    external_ban_new: 'акаунт у спам-базах',
    shared_profile_photo: 'те саме фото профілю ще на кількох акаунтах',
    external_high_factor_new: 'акаунт у спам-базах',
    edit_injected_promo: 'рекламу додано під час редагування',
    edit_injected_invisibles: 'невидимі символи додано під час редагування',
    private_invite_new: 'запрошення в закритий чат від нового акаунта',
    identity_churn_promo: 'часта зміна імені й реклама',
    nsfw_promo_profile: 'профіль працює як реклама: відверті фото чи відео й канал у профілі',
    hidden_url_new: 'приховане посилання від новачка',
    low_information: 'недостатньо інформації — поки лише спостереження',
    low_information_profile: 'мало тексту, але профіль підозрілий',
    low_information_profile_unreachable: 'профіль підозрілий, але перевірку надіслати не вдалося — поки лише спостереження',
    reported_unreachable: 'на акаунт поскаржилися, а перевірку надіслати не вдалося — обмежено на годину',
    profile_farm_unreachable: 'реклама прямо у фото профілю, а перевірку надіслати не вдалося — обмежено на годину',
    content_unconfirmed: 'профіль підозрілий, але сам текст спамом не підтверджено',
    admin_report: 'скарга адміна: спам',
    trusted_report: 'скарга довіреного учасника: спам',
    community_vote: 'спільнота проголосувала: спам',
    forward_blacklist: 'переслано з відомого спам-джерела',
    record_ban_elsewhere: 'акаунт уже забанено в іншому чаті через спам-бази чи позначку Telegram — тут забанено ще до першого повідомлення',
    content_ban_elsewhere: 'акаунт забанено в іншому чаті за спам — тут забанено ще до першого повідомлення',
    listed_arrival: 'на вході: акаунт у спам-базах або позначений Telegram',
    arrival_look: 'новачок мовчить, а профіль схожий на спам-мережу',
    arrived_with_spammer: 'вхід разом зі спамером, схожий профіль — забанив адмін',
    admin_arrival_ban: 'забанено адміном зі списку нових учасників'
  },
  reasonFallback: 'підозріла активність',

  why: {
    title: '🛡 Бот лише спостерігає',
    inChat: (chatTitle) => `у чаті ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Дуже схоже на спам · оцінка бота ${percent}%`,
      medium: (percent) => `🟠 Імовірно спам · оцінка бота ${percent}%`,
      low: (percent) => `🟡 Можливо спам · оцінка бота ${percent}%`
    },
    noticedTitle: 'Що я помітив:',
    profileReuseEvidence: (accounts) =>
      `те саме фото профілю ще на ${accounts} ${plural(accounts, 'акаунті', 'акаунтах', 'акаунтах')}`,
    profileMediaEvidence: (score) => `відверте фото в профілі · оцінка ${score}`,
    externalBanEvidence: (sources, when) => [
      'у спам-базах',
      ...(sources > 1 ? [`${sources} ${plural(sources, 'джерело', 'джерела', 'джерел')}`] : []),
      ...(when ? [ago(when)] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'акаунт у спам-базах',
      external_repeat_offender: 'кілька разів у спам-базах',
      fresh_external_ban: 'нещодавно в спам-базах',
      many_shared_chats: 'одразу в багатьох наших чатах',
      promo_in_bio: 'рекламне посилання в біо',
      private_invite_in_bio: 'запрошення до закритого каналу в біо',
      contact_in_bio: 'контакт поза Telegram у біо',
      personal_channel: 'канал прив’язаний до профілю',
      promo_in_linked_channel: 'у каналі з профілю — реклама',
      promo_in_message_link: 'посилання веде на рекламний канал',
      restricted_for_spam: 'Telegram обмежив за спам',
      just_joined: 'пише одразу після входу в чат',
      joined_during_surge: 'вхід під час напливу нових учасників',
      arrived_with_spammer: 'вхід у чат разом зі спамером, схожий профіль',
      scam_flag: 'Telegram позначив акаунт як шахрайський',
      fake_flag: 'Telegram позначив акаунт як фейковий',
      restricted_flag: 'акаунт обмежений Telegram',
      sleeper_awakened: 'давно неактивний акаунт раптом почав писати',
      fresh_account: 'акаунт може бути зовсім новий',
      new_globally: 'новий у наших чатах',
      new_in_chat: 'новий у цьому чаті',
      identity_churn_24h: 'часта зміна імені чи фото профілю',
      avatar_recently_set: 'фото профілю поставлено цими днями',
      prior_spam_detections: 'від акаунта вже був спам раніше',
      unofficial_client_risk: 'надіслано з неофіційного застосунку',
      forward_hidden_user: 'переслано від автора, який приховав свій профіль',
      forward_source_suspicious: 'переслано з підозрілого джерела',
      hidden_url: 'замасковане посилання',
      external_url: 'зовнішнє посилання',
      url_shortener: 'скорочене посилання',
      private_invite_link: 'запрошення в закритий чат',
      bot_deeplink: 'посилання, що запускає бота',
      messenger_contact_link: 'контакт в іншому месенджері',
      many_url_buttons: 'кілька кнопок із посиланнями',
      phone_number: 'номер телефону',
      cashtag: 'згадка монети чи акції через $',
      long_text: 'довгий текст',
      invisible_in_word: 'невидимі символи всередині слів',
      mixed_script_word: 'літери різних алфавітів в одному слові',
      greek_homoglyph_word: 'грецькі літери-двійники в слові',
      foreign_script: 'написано незвичним для чату письмом',
      custom_emoji_heavy: 'багато преміум-емодзі',
      paid_media: 'платний медіаконтент',
      giveaway_media: 'розіграш',
      story_share: 'переслана історія',
      unknown_media: 'нерозпізнане вкладення',
      guest_bot_delivery: 'надіслано через бота, викликаного згадкою',
      edited_message: 'повідомлення відредаговано',
      edit_injected_invisibles: 'невидимі символи додано під час редагування',
      edit_injected_link: 'посилання додано під час редагування',
      moderation_flagged: '18+ у тексті або фото',
      sole_avatar_replaced: 'старий акаунт, єдине фото профілю поставлено нещодавно',
      avatar_shared_with_account: 'те саме фото профілю ще на одному акаунті',
      avatar_shared_with_accounts: 'те саме фото профілю на кількох акаунтах',
      nsfw_avatar: '18+ у фото профілю',
      suggestive_profile_media: 'напіввідверте фото чи відео в профілі',
      nsfw_stories: '18+ в історіях',
      nsfw_linked_channel: '18+ у фото каналу з профілю',
      promo_in_name: 'реклама в імені акаунта',
      invisible_in_name: 'невидимі символи в імені',
      signature_candidate_match: 'схоже на відомий спам',
      vector_similar_spam: 'за змістом схоже на відомий спам',
      velocity_repeats: 'той самий текст повторюється',
      velocity_wave: 'той самий текст із кількох акаунтів',
      bot_mention: 'згадка бота',
      sender_burst: 'серія повідомлень від одного акаунта',
      burst_grey_repeat: 'кілька повідомлень серії вже виглядали підозріло'
    },
    decidedBy: {
      custom_rule: 'правило чату',
      deterministic: 'жорстке правило',
      signature: 'база сигнатур',
      vector: 'семантичний пошук',
      forward: 'чорний список джерел пересилання',
      velocity: 'розсилка по кількох чатах',
      moderation: 'модерація контенту',
      llm: 'ШІ-аналіз',
      llm_cached: 'ШІ-аналіз (кеш)',
      session: 'аналіз серії повідомлень',
      burst: 'аналіз серії від одного акаунта',
      score: 'сума сигналів',
      abstain: 'без рішення',
      error: 'помилка'
    },
    expired: 'Деталі цього рішення більше не зберігаються.',
    appeal: 'Якщо це помилка — напиши адміну цього чату: адмін може скасувати рішення.'
  },

  profile: {
    title: '👤 Профіль',
    openButton: '👤 Профіль',
    accountAge: (age) => `акаунт ${age}`,
    // "відомий боту <span>" agrees with the "акаунт" that opens the line; a span
    // under a minute is a first sighting too, and "відомий боту щойно" is not.
    firstSeen: (seen) => (seen === NEVER_SEEN || seen === NOW ? 'бот бачить уперше' : `відомий боту ${seen}`),
    activity: (messages, chats) =>
      [
        ...(messages === null ? [] : [`${messages} ${plural(messages, 'повідомлення', 'повідомлення', 'повідомлень')}`]),
        `${chats} ${plural(chats, 'чат', 'чати', 'чатів')}`
      ].join(' · '),
    reputation: (status) => `статус: ${status}`,
    premium: 'Premium',
    externalBan: (when, offenses) => [
      'у спам-базах',
      ...(when ? [`бан ${ago(when)}`] : []),
      ...(offenses > 1 ? [`${offenses} ${plural(offenses, 'порушення', 'порушення', 'порушень')}`] : [])
    ].join(' · '),
    justJoined: (span) => (span === NOW ? 'у чаті щойно' : `у чаті лише ${span}`),
    promoInBio: 'реклама в біо',
    personalChannel: 'прив’язаний канал',
    unknownAge: 'невідомого віку',
    neverSeen: NEVER_SEEN,
    units: { now: NOW, m: 'хв', h: 'год', d: 'д', mo: 'міс', y: 'р' },
    checkNeedReply: 'Зроби /check відповіддю на повідомлення користувача.',
    notFound: 'Не вдалося отримати профіль.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Це спам?</b> Автор: ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Це спам?</b> Автор: ${userLabel} · без тексту, лише ${what}`
        : `🤔 <b>Це спам?</b> Автор: ${userLabel} · без тексту`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'фото', sticker: 'стікер', video: 'відео',
      voice: 'голосове чи аудіо', file: 'файл', other: 'вкладення'
    },
    redacted: { link: '[посилання]', mention: '[@згадка]', invite: '[запрошення]' },
    spamButton: (count) => `🗑 Спам (${count})`,
    hamButton: (count) => `✅ Не спам (${count})`,
    counted: 'Голос зараховано.',
    enforcement: {
      done: 'Видалено, автора обмежено.',
      deletedOnly: 'Видалено, але обмежити автора не вдалося.',
      mutedOnly: 'Автора обмежено, але видалити повідомлення не вдалося.',
      failed: '⚠️ Не вдалося ні видалити повідомлення, ні обмежити автора.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      // The name follows a "·", never "від": a display name cannot be declined.
      '🗑 Спільнота вирішила: спам' + (who ? ` · ${who}` : '')
      + (enforcement ? `. ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      '✅ Спільнота вирішила: не спам' + (who ? ` · ${who}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Голосування вже закрите.',
    voters: {
      button: '👥 Хто голосував',
      title: (spam, ham) => `👥 <b>Голосування</b> · спам ${spam} : ${ham} не спам`,
      spamGroup: '🗑 Спам',
      hamGroup: '✅ Не спам',
      adminMark: 'адмін',
      changedMark: 'голос змінено',
      span: (span) => (span === NOW ? '⏱ усі голоси — менш ніж за хвилину' : `⏱ від першого до останнього голосу: ${span}`),
      more: (count) => `…і ще ${count}`,
      nobody: 'Ніхто не встиг проголосувати.',
      notForTarget: 'Це голосування про тебе: у ньому ти не голосуєш і не бачиш, хто голосував.',
      noStanding: 'Голос не зараховано: голосують ті, хто в чаті від тижня й написав тут від 10 повідомлень (або від 50 у чатах із ботом), чи хто в чаті понад рік.',
      knownBad: 'Голос не зараховано: з цього акаунта вже надходив спам.'
    }
  },

  report: {
    needReply: 'Зроби /report відповіддю на повідомлення або вкажи людину: /report @нік, /report 123456789, чи вибери її через @ зі списку.',
    notFound: (who) => `Не знайшов у цьому чаті: ${who}. Відповідай на повідомлення цієї людини або вибери її через @ зі списку.`,
    notInChat: 'Цієї людини вже немає в чаті.',
    cantReportAdmin: 'На адмінів скаржитися не можна.',
    rateLimited: 'Забагато скарг. Почекай кілька хвилин.',
    accepted: 'Прийняв, дякую.',
    oneAtATime: 'Тут зайшло кілька людей одразу. Відповідай на повідомлення того, на кого скаржишся.',
    voteClosed: 'Голосування за це повідомлення вже закрите. Вирішити може адмін.',
    channelSender: 'Це написано від імені каналу. Заблокувати канал може лише адмін.'
  },

  stats: {
    title: '📊 <b>Твоя статистика</b>',
    inChat: (count, chatTitle) => chatTitle ? `Повідомлень у чаті ${chatTitle}: ${count}` : `Повідомлень у цьому чаті: ${count}`,
    global: (count) => `Повідомлень у всіх чатах: ${count}`,
    reputation: (score, status) => `Репутація: ${score} (${status})`,
    repStatus: { trusted: 'надійний', neutral: 'нейтральний', suspicious: 'підозрілий', restricted: 'обмежений' },
    bananCaught: (count) => `Бананів отримано: ${count} 🍌`,
    openInPm: 'Твоя статистика — у приватному чаті з ботом, тисни кнопку.',
    openButton: '📊 Моя статистика'
  },

  botStats: {
    title: '🛡 <b>Що я вже зробив</b>',
    window: (days) => `За ${plural(days, 'останній', 'останні', 'останні')} ${days} ${plural(days, 'день', 'дні', 'днів')}:`,
    checked: (count) => `📬 перевірено <b>${groupDigits(count)}</b> ${plural(count, 'повідомлення', 'повідомлення', 'повідомлень')}`,
    spammers: (count) => `🚫 заблоковано <b>${groupDigits(count)}</b> ${plural(count, 'спамера', 'спамерів', 'спамерів')}`,
    chats: (count) => `💬 <b>${groupDigits(count)}</b> ${plural(count, 'чат під захистом', 'чати під захистом', 'чатів під захистом')}`,
    speed: (ms) => `⚡ рішення за <b>${groupDigits(ms)} мс</b>`,
    quiet: (percent) => `<b>${decimal1(percent)}%</b> повідомлень не торкнувся. Поки спаму немає, мене не чути.`,
    reasonsTitle: '<b>Найчастіше ловлю:</b>',
    reasonLine: (name, count) => `• ${name} — ${groupDigits(count)}`,
    memory: (signatures) => `🧠 У пам’яті ${groupDigits(signatures)} ${plural(signatures, 'сигнатура', 'сигнатури', 'сигнатур')} спаму`,
    corrections: (percent) => `✅ Адміни скасували ${decimal1(percent)}% моїх рішень`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> за ${days} ${plural(days, 'день', 'дні', 'днів')}`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${groupDigits(checked)} перевірено · 🚫 ${groupDigits(spammers)} ${plural(spammers, 'спамер', 'спамери', 'спамерів')} · 🧹 ${groupDigits(deletes)} видалено`,
    chatLastSpam: (span) => `Останній спам: ${ago(span)}`,
    chatClean: '✨ За цей час бот не виявив спаму.',
    unavailable: '📊 Цифри зараз недоступні, спробуй трохи пізніше.',
    button: '📊 Статистика бота'
  },

  top: {
    titleMessages: '🏆 <b>Найактивніші в чаті</b>',
    titleBanan: '🍌 <b>Топ за бананами</b>',
    empty: 'Поки нема статистики.',
    messagesUnit: (count) => plural(count, 'повідомлення', 'повідомлення', 'повідомлень'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} більше не в чаті.`,
    needReply: 'Зроби /kick відповіддю на повідомлення того, кого хочеш вигнати.'
  },

  untrust: {
    success: (name) => `🔓 Довіру знято: ${name}. Повідомлення знову проходять перевірку.`,
    needReply: 'Зроби /untrust відповіддю на повідомлення того, з кого хочеш зняти довіру.',
    notTrusted: (name) => `ℹ️ ${name} не в списку довірених — знімати нічого.`
  },

  trust: {
    button: '✅ Довіряти',
    untrustButton: '🔓 Зняти довіру',
    added: 'Додав у довірені цього чату.',
    removed: 'Зняв довіру.',
    grantedBy: (who, span, via) =>
      `✅ Довіра від ${who}, ${ago(span)}` +
      (via === 'override' ? ' · скасування рішення бота' : via === 'vote' ? ' · голос адміна' : ''),
    grantUnknown: '✅ Є довіра · від кого і коли — не записано'
  },

  welcome: {
    enabled: '👋 Привітання увімкнено.',
    disabled: '👋 Привітання вимкнено.',
    textSet: '✅ Текст привітання збережено. Підстановка %name% працює.',
    gifSet: '✅ Медіа для привітання збережено.',
    usage: [
      '/welcome — увімкнути/вимкнути',
      '/welcome <текст з %name%> — задати привітання',
      'відповідь гіфкою на /welcome — задати гіфку'
    ].join('\n'),
    limit: '⚠️ Більше додати не можна: ліміт вичерпано. Спершу видали щось у налаштуваннях.',
    duplicate: 'ℹ️ Це вже додано.',
    tooLong: '⚠️ Текст задовгий (макс. 1000 символів).',
    saveFailed: '⚠️ Не вдалося зберегти.',
    surgeAlert: (count, riskCount) => `⚠️ Наплив новачків: ${count} ${plural(count, 'учасник', 'учасники', 'учасників')}, з них ${riskCount} ${plural(riskCount, 'підозрілий', 'підозрілі', 'підозрілих')}`,
    defaultGreeting: (name) => `👋 Вітаємо, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Привітання новачків</b>\n\nСтан: ${state}\nТекстів: ${nTexts} · Гіфок: ${nGifs}\n\nЯкщо є кілька — бот щоразу обирає випадковий.`,
      enable: '🔔 Увімкнути',
      disable: '🔕 Вимкнути',
      texts: (n) => `📝 Тексти (${n})`,
      gifs: (n) => `🎞 Медіа (${n})`,
      preview: '👁 Переглянути',
      textsTitle: (n, max) => `📝 <b>Тексти привітання</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Тексти привітання</b>\n\nПоки порожньо. Додай перший — можна з <code>%name%</code> для імені новачка.',
      addText: '➕ Додати текст',
      gifsTitle: (n, max) => `🎞 <b>Медіа для привітання</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 медіа #${i}`,
      gifsEmpty: '🎞 <b>Медіа для привітання</b>\n\nПоки порожньо. Надішли гіфку, відео чи фото.',
      addGif: '➕ Додати медіа',
      promptText: '📝 Надішли текст привітання одним повідомленням.\nМожна вставити <code>%name%</code> — підставлю ім’я новачка.\n\n/cancel — скасувати.',
      promptGif: '🎞 Надішли гіфку, відео або фото одним повідомленням.\n\n/cancel — скасувати.',
      added: '✅ Додано.',
      cancelled: '↩️ Скасовано.',
      invalidGif: '⚠️ Тут потрібна гіфка, відео або фото — надішли одне з них.',
      removed: '🗑 Видалено.',
      removeMissing: 'Цього вже немає — оновив список.',
      expired: '⌛ Час вийшов. Відкрий редактор ще раз.',
      previewEmpty: 'Поки нема що показати — додай текст, гіфку, відео чи фото.'
    }
  },

  extra: {
    saved: (name) => `✅ Збережено #${name}`,
    deleted: (name) => `🗑 Видалено #${name}`,
    notFound: (name) => `Нема такого: #${name}`,
    usage: [
      '/extra назва (у відповідь на повідомлення) — збережу його під #назва',
      '/extra назва (без відповіді) — видалю тригер'
    ].join('\n'),
    listTitle: '📂 Збережені тригери:',
    listEmpty: 'Тут поки нема тригерів.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Тригери</b> (${n})\n\nНапиши <code>#назва</code> в чаті — бот надішле збережене.\nЛіміт: не більше ${max} відповідей на одне повідомлення.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Тригери</b>\n\nПоки порожньо. Додай перший — назва + текст або медіа.',
      add: '➕ Додати тригер',
      maxLabel: (n) => `Ліміт: ${n}`,
      promptName: '#️⃣ Введи назву тригера (без #), одним словом.\n\n/cancel — скасувати.',
      promptContent: (name) => `Тепер надішли, що бот відповідатиме на <code>#${name}</code>: текст, гіфку, фото чи відео.\n\n/cancel — скасувати.`,
      added: (name) => `✅ Тригер #${name} збережено.`,
      cancelled: '↩️ Скасовано.',
      invalidName: '⚠️ Назва — одне слово: літери, цифри або _, без пробілів.',
      removed: '🗑 Видалено.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} отримує банан на ${duration}`,
    lifted: (name) => `🍌 ${name} більше без банана`,
    self: (name, duration) => `🍌 ${name} бере собі банан на ${duration}. Поважаю`,
    needReply: 'Зроби /banan відповіддю на повідомлення, або /banan без реплая для себе.',
    undoButton: '↩️ Скасувати',
    units: { m: 'хв', h: 'год', d: 'дн' },
    show: (name) => `🍌 ${name} показує банан`
  },

  captcha: {
    prompt: (name, minutes) =>
      `👋 ${name}, натисни кнопку${minutes ? ` протягом ${minutes} хв` : ''} і пиши далі. Це швидка перевірка, що ти не бот.`,
    button: '🙋 Я людина',
    passed: 'Готово, пиши.',
    retry: 'Не вдалося зняти обмеження. Тисни ще раз.',
    notForYou: 'Ця кнопка для іншого учасника.'
  },

  settings: {
    openInPm: 'Налаштування — у приватному чаті з ботом, тисни кнопку.',
    openInPmButton: '⚙️ Відкрити налаштування',
    title: '⚙️ <b>Налаштування антиспаму</b>',
    preset: 'Режим',
    presets: { soft: 'М’який', standard: 'Стандартний', strict: 'Суворий' },
    captcha: 'Капча для новачків',
    voting: 'Голосування спільноти',
    enabled: 'Антиспам',
    banDatabase: 'Спам-бази',
    quiet: 'Тихий режим',
    quietHint: '🤫 Сповіщення про впевнені дії приходять без звуку й кнопок і зникають за 5 с. Усе, що бот зробив, — у «🧾 Останні дії». Голосування лишаються.',
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
