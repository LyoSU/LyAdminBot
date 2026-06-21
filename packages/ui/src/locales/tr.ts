import type { Locale } from '../locale.js'

export const tr: Locale = {
  languageName: 'Türkçe',

  start: {
    privateCard: (name) => [
      `Selam, <b>${name}</b>! 👋`,
      '',
      '🛡 <b>Gruplar için anti-spam.</b>',
      'Spam yakalarım, dolandırıcıları yasaklarım, reklamları temizlerim.',
      '',
      'Beni bir gruba ekle → yönetici yetkisi ver → tamamdır.'
    ].join('\n'),
    groupHint: '🛡 Spam yakalarım ve dolandırıcıları yasaklarım.\n<code>/settings</code> yöneticiler için · <code>/help</code> komutlar',
    addToGroupButton: '➕ Gruba ekle',
    helpButton: '❓ Komutlar',
    langButton: '🌐 Dil'
  },

  helpText: [
    '🛡 <b>Komutlar</b>',
    '/report — spam bildir (yanıt olarak)',
    '/settings — yöneticiler için anti-spam (PM’de açılır)',
    '/lang — dil',
    '',
    'Spam’i kendim temizlerim. Her işlemde nedeniyle birlikte <b>[🤨 Neden?]</b>',
    've yöneticiler için <b>[✅ Spam değil]</b> var: işlemi geri alır ve bana öğretir.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Bir dil seç:',
    saved: 'Tamam, Türkçe olsun'
  },

  commands: {
    start: 'Botu kullanmaya başla',
    help: 'Yardım ve komutlar',
    lang: 'Dil seç',
    mystats: 'İstatistiklerim',
    report: 'Spam bildir (yanıt)',
    settings: 'Anti-spam ayarları (yöneticiler)',
    banan: 'Yanıtla sustur (/banan 5m)',
    kick: 'Üyeyi at (yanıt)',
    del: 'Mesajı sil (yanıt)',
    untrust: 'Güveni geri al (yanıt)',
    check: 'Profili görüntüle (yanıt)',
    top: 'En aktif üyeler',
    topBanan: 'Muz sıralaması',
    extras: 'Kayıtlı tetikleyiciler',
    welcome: 'Yeni üye karşılamaları',
    ping: 'Botun çalıştığını kontrol et'
  },

  actions: {
    captcha: '👋 kontrol ediliyor',
    delete: '🧹 spam temizlendi',
    mute: '🔇 susturuldu',
    ban: '🔨 yasaklandı'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyButton: '🤨 Neden?',
    notSpamButton: '✅ Spam değil',
    overrideDone: 'Tamam, geri alındı. Kullanıcı geri döndü ve artık bu sohbette güveniliyor.',
    overrideAlreadyDone: 'Zaten geri alınmış.',
    adminOnly: 'Yalnızca sohbet yöneticileri.',
    missingRights: '⚠️ Spam yakaladım ama temizlemek için yetkim yok. Lütfen bana mesaj silme ve kullanıcı yasaklama yetkisi ver.'
  },

  reasons: {
    job_scam: 'iş dolandırıcılığına benziyor',
    crypto_scam: 'kripto dolandırıcılığı',
    gambling_promo: 'kumarhane/bahis reklamı',
    adult_promo: 'yetişkin içerik reklamı',
    ad_network: 'reklam yerleştirme teklifi',
    flirt_bait: 'flört tuzağı',
    phishing: 'oltalama bağlantısı',
    channel_promo: 'istenmeyen kanal reklamı',
    guest_bot_promo: 'misafir bot üzerinden reklam',
    flood: 'flood / toplu gönderim',
    prompt_injection: 'moderasyonu ele geçirme girişimi',
    other_spam: 'spam',
    known_spam_signature: 'doğrulanmış spam ile eşleşiyor',
    semantic_spam_match: 'bilinen spam’e çok benziyor',
    velocity_exceeded: 'aynı mesaj birden çok sohbette',
    custom_deny: 'bir sohbet kuralıyla engellendi',
    scam_flag_new: 'Telegram hesabı dolandırıcı olarak işaretledi',
    external_ban_new: 'hesap spam veritabanlarında',
    external_high_factor_new: 'hesap spam veritabanlarında',
    edit_injected_promo: 'mesaj, reklam eklemek için düzenlendi',
    private_invite_new: 'yeni bir hesaptan özel davet',
    identity_churn_promo: 'sık ad değişikliği + reklam içeriği',
    hidden_url_new: 'yeni gelen birinden aldatıcı bağlantı',
    low_information: 'yeterli bilgi yok, izleniyor',
    admin_report: 'bir yönetici bunu spam olarak bildirdi',
    community_vote: 'topluluk oyladı: spam',
    forward_blacklist: 'bilinen bir spam kaynağından iletildi'
  },
  reasonFallback: 'şüpheli etkinlik',

  why: {
    title: '🛡 Neden işlem yaptım',
    confidence: {
      high: (percent) => `🔴 Büyük olasılıkla spam · ${percent}%`,
      medium: (percent) => `🟠 Muhtemelen spam · ${percent}%`,
      low: (percent) => `🟡 Spam olabilir · ${percent}%`
    },
    reasonLine: (reason) => `Neden: ${reason}`,
    noticedTitle: 'Fark ettiklerim:',
    signalLabels: {
      external_ban: 'hesap spam veritabanlarında',
      external_repeat_offender: 'spam veritabanlarında birden fazla kez listelenmiş',
      fresh_external_ban: 'kısa süre önce spam veritabanlarına eklenmiş',
      many_shared_chats: 'aynı anda birçok sohbetimizde',
      promo_in_bio: 'biyografide reklam veya iletişim bilgisi',
      personal_channel: 'profilde bağlı bir kanal',
      restricted_for_spam: 'Telegram spam nedeniyle kısıtladı',
      just_joined: 'katılır katılmaz hemen yazdı',
      scam_flag: 'Telegram hesabı dolandırıcı olarak işaretledi',
      fake_flag: 'Telegram hesabı sahte olarak işaretledi',
      restricted_flag: 'hesap Telegram tarafından kısıtlanmış',
      sleeper_awakened: 'uykudaki bir hesap aniden aktif oldu',
      fresh_account: 'tamamen yeni bir hesap',
      new_globally: 'Telegram’da yeni',
      new_in_chat: 'bu sohbetteki ilk mesaj',
      identity_churn_24h: 'sık ad / fotoğraf değişikliği',
      avatar_recently_set: 'avatar yeni ayarlandı',
      prior_spam_detections: 'daha önce spam yaparken yakalandı',
      low_reputation: 'düşük itibar',
      unofficial_client_risk: 'resmi olmayan bir uygulamadan gönderildi',
      promo_bot: 'bir reklam botu',
      forward_hidden_user: 'gizli bir hesaptan iletildi',
      forward_source_suspicious: 'şüpheli bir kaynaktan iletildi',
      hidden_url: 'gizlenmiş bir bağlantı',
      external_url: 'harici bir bağlantı',
      url_shortener: 'kısaltılmış bir bağlantı',
      private_invite_link: 'özel bir davet bağlantısı',
      bot_deeplink: 'bot başlatma bağlantısı',
      messenger_contact_link: 'başka bir mesajlaşma uygulamasındaki bir iletişim',
      many_url_buttons: 'çok sayıda bağlantı düğmesi',
      phone_number: 'bir telefon numarası',
      cashtag: 'kripto / hisse senedi sembolü',
      long_text: 'alışılmadık derecede uzun bir gönderi',
      invisible_in_word: 'kelimelerin içinde gizli görünmez karakterler',
      mixed_script_word: 'bir kelimenin içinde karışık alfabeler',
      custom_emoji_heavy: 'çok sayıda özel emoji',
      paid_media: 'ücretli medya içeriği',
      giveaway_media: 'bir çekiliş',
      story_share: 'paylaşılan bir hikaye',
      unknown_media: 'tanınmayan bir ek',
      guest_bot_delivery: 'bir misafir bot üzerinden teslim edildi',
      edited_message: 'mesaj düzenlendi',
      edit_injected_promo: 'düzenlemeyle eklenen reklam'
    },
    messageTitle: 'Mesaj:',
    decidedBy: {
      custom_rule: 'sohbet kuralı',
      deterministic: 'kesin kural',
      signature: 'imza veritabanı',
      vector: 'anlamsal arama',
      forward: 'iletim kaynağı kara listesi',
      velocity: 'sohbetler arası hız',
      moderation: 'içerik moderasyonu',
      llm: 'yapay zeka analizi',
      llm_cached: 'yapay zeka analizi (önbellekten)',
      session: 'mesaj serisi analizi',
      score: 'sinyal puanı',
      abstain: 'çekimser kalındı',
      error: 'hata'
    },
    expired: 'Bu kararın süresi doldu — ayrıntı kalmadı.'
  },

  profile: {
    title: '👤 Profil',
    accountAge: (age) => `hesap ${age}`,
    firstSeen: (seen) => `burada ${seen}`,
    activity: (messages, chats) => `${messages} mesaj · sohbetlerimizin ${chats} tanesinde`,
    reputation: (status) => `itibar: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'spam veritabanlarında',
      ...(ago ? [`${ago} önce yasaklandı`] : []),
      ...(offenses > 1 ? [`${offenses} ihlal`] : [])
    ].join(' · '),
    justJoined: (ago) => `sohbete katılalı yalnızca ${ago}`,
    promoInBio: 'biyografide reklam',
    personalChannel: 'bağlı kanal',
    unknownAge: 'yaş bilinmiyor',
    neverSeen: 'ilk kez',
    units: { now: 'şimdi', m: 'dk', h: 'sa', d: 'g', mo: 'ay', y: 'yıl' },
    checkNeedReply: 'Bir kullanıcının mesajına /check ile yanıt ver.',
    notFound: 'Profil alınamadı.'
  },

  vote: {
    prompt: (userLabel, textPreview) => `🤔 <b>Bu spam mı?</b> ${userLabel} adlı kullanıcıdan mesaj:\n\n"${textPreview}"`,
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `👌 Sorun yok (${count})`,
    counted: 'Oy sayıldı.',
    resolvedSpam: '🗑 Topluluk spam diyor. Kaldırıldı.',
    resolvedHam: '👌 Topluluk sorun olmadığını söylüyor.',
    alreadyEnded: 'Bu oylama zaten kapandı.'
  },

  report: {
    needReply: 'Bildirmek istediğin mesaja yanıt olarak /report kullan.',
    cantReportAdmin: 'Yöneticiler bildirilemez.',
    rateLimited: 'Çok fazla bildirim. Birkaç dakika bekle.',
    accepted: 'Anlaşıldı, teşekkürler.'
  },

  stats: {
    title: '📊 <b>İstatistiklerin</b>',
    inChat: (count) => `Bu sohbetteki mesajlar: ${count}`,
    global: (count) => `Her yerdeki mesajlar: ${count}`,
    reputation: (score, status) => `İtibar: ${score} (${status})`,
    repStatus: { trusted: 'güvenilir', neutral: 'nötr', suspicious: 'şüpheli', restricted: 'kısıtlı' },
    bananCaught: (count) => `Yakalanan muzlar: ${count} 🍌`,
    openInPm: 'İstatistikler PM’ine yolda.',
    openButton: '📊 İstatistiklerim'
  },

  top: {
    titleMessages: '🏆 <b>Sohbette en aktif</b>',
    titleBanan: '🍌 <b>Muz sıralaması</b>',
    empty: 'Henüz istatistik yok.',
    messagesUnit: () => 'mesaj',
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} sohbetten çıkarıldı.`,
    needReply: 'Atmak istediğin kişinin mesajına /kick ile yanıt ver.'
  },

  untrust: {
    success: (name) => `🔓 ${name} için güven geri alındı. Mesajları yeniden kontrollerden geçecek.`,
    needReply: 'Güvenini geri almak istediğin kişinin mesajına /untrust ile yanıt ver.',
    notTrusted: (name) => `${name} zaten güvenilir listesinde değildi.`
  },

  welcome: {
    enabled: '👋 Karşılama mesajları açık.',
    disabled: '👋 Karşılama mesajları kapalı.',
    textSet: '✅ Karşılama metni kaydedildi. %name% yerine geçirilir.',
    gifSet: '✅ Karşılama gif’i kaydedildi.',
    usage: [
      '/welcome — aç/kapat',
      '/welcome <%name% içeren metin> — karşılamayı ayarla',
      'bir gif’e /welcome ile yanıt ver — gif’i ayarla'
    ].join('\n'),
    defaultGreeting: (name) => `👋 Hoş geldin, ${name}!`
  },

  extra: {
    saved: (name) => `✅ Kaydedildi #${name}`,
    deleted: (name) => `🗑 Silindi #${name}`,
    notFound: (name) => `Böyle bir tetikleyici yok: #${name}`,
    usage: [
      '/extra ad (bir mesaja yanıt vererek) — #ad altına kaydeder',
      '/extra ad (yanıt yok) — tetikleyiciyi siler'
    ].join('\n'),
    listTitle: '📂 Kayıtlı tetikleyiciler:',
    listEmpty: 'Burada henüz tetikleyici yok.'
  },

  banan: {
    success: (name, duration) => `🍌 ${name} ${duration} boyunca muzu yedi`,
    lifted: (name) => `🍌 ${name} muzu kaybetti`,
    self: (name, duration) => `🍌 ${name} kendini ${duration} boyunca muzladı. Saygılar`,
    needReply: 'Yanıt olarak /banan kullan veya kendini muzlamak için sade /banan yaz.',
    undoButton: '↩️ Geri al',
    units: { m: 'dk', h: 'sa', d: 'g' }
  },

  captcha: {
    prompt: (name) => `👋 ${name}, sohbete devam etmek için düğmeye dokun. Bot olmadığını gösteren hızlı bir kontrol.`,
    button: '🙋 Ben insanım',
    passed: 'Tamam, devam edebilirsin.',
    notForYou: 'Bu düğme senin için değil.'
  },

  settings: {
    openInPm: 'Ayarlar özel mesajlarda mevcuttur.',
    openInPmButton: '⚙️ Ayarları aç',
    title: '⚙️ <b>Anti-spam ayarları</b>',
    preset: 'Mod',
    presets: { soft: 'Yumuşak', standard: 'Standart', strict: 'Sıkı' },
    captcha: 'Yeni gelenler için captcha',
    voting: 'Topluluk oylaması',
    enabled: 'Anti-spam',
    banDatabase: 'Spam veritabanları',
    language: 'Bu sohbette bot dili',
    languageSaved: 'Sohbet dili güncellendi',
    on: 'Açık',
    off: 'Kapalı',
    back: '‹ Geri'
  }
}
