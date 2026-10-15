import type { Locale } from '../locale.js'
import { decimal1, groupDigits } from '../format.js'

/** Turkish number typography: thousands by point, decimals by comma. */
const n = (v: number): string => groupDigits(v, '.')

/**
 * "şimdi" is already a point in time: "şimdi önce" is not Turkish. Every
 * "<span> önce" in this file goes through here, so a span under a minute
 * reads "az önce" wherever an elapsed time is printed.
 */
const NOW = 'şimdi'
const ago = (span: string): string => (span === NOW ? 'az önce' : `${span} önce`)

/** First-seen placeholder: the profile line reads it as a phrase, not a span. */
const NEVER_SEEN = 'ilk kez'

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
    liveProof: (chats, spammers, days) =>
      `📊 Şu anda <b>${n(chats)}</b> sohbeti koruyorum: ${days} günde <b>${n(spammers)}</b> spam hesabını engelledim.`,
    groupHint: '🛡 Spam yakalarım ve dolandırıcıları yasaklarım.\n<code>/settings</code> yöneticiler için · <code>/stats</code> sayılar · <code>/help</code> komutlar',
    addToGroupButton: '➕ Gruba ekle',
    helpButton: '❓ Komutlar',
    langButton: '🌐 Dil'
  },
  arrivals: {
    button: '👥 Yeni üyeler',
    title: '👥 <b>Bu hafta sohbete kim katıldı</b>',
    empty: 'Bot bu hafta bu sohbette yeni üye fark etmedi.',
    silent: 'sessiz',
    spoke: (count) => `mesaj: ${count}`,
    suspect: 'bir spamcıyla birlikte katıldı',
    outcomes: {
      removed: 'çıkarıldı',
      banned_on_record: 'spam veritabanları nedeniyle yasaklandı',
      banned_carried: 'başka bir sohbette spam nedeniyle yasaklandı',
      banned_by_admin: 'yönetici yasakladı',
      gated: 'kontrol ediliyor'
    },
    footer: '⚠️ — bir spamcıyla birlikte katıldı ve ona benziyor. "🚫 N", N numaralı kişiyi yasaklar.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Hâlâ sessiz olan herkesi yasakla (${count})`,
    confirmAll: (count) => `Henüz hiçbir şey yazmamış <b>${count}</b> yeni üye yasaklansın mı?`,
    confirmYes: '🚫 Evet, yasakla',
    cancel: 'İptal',
    banned: (count) => `Yasaklandı: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>Spamcı ${spammer} ile birlikte ${count} benzer yeni üye katıldı</b>`,
    hint: 'Benzer profiller, aynı anda katıldılar, henüz bir şey yazmadılar. Bot kimseyi kısıtlamadı — karar yöneticinin.',
    banButton: (count) => `🚫 ${count} kişiyi yasakla`,
    keepButton: 'Kalsınlar',
    banned: (done, total, admin) => `🚫 Spamcıyla katılan ${total} yeni üyeden ${done} kişi yasaklandı · ${admin}`,
    kept: (admin) => `✅ Yeni üyeler sohbette kalıyor · ${admin}`,
    expired: 'Bu kart artık güncel değil.'
  },

  chatActions: {
    button: '🧾 Son işlemler',
    title: '🧾 <b>Botun bu sohbetteki son işlemleri</b>',
    empty: 'Henüz boş: bot bu sohbette henüz hiçbir işlem yapmadı.',
    footer: '“Neden?” kanıtı ve, bot yanıldıysa, “Spam değil” düğmesini gösterir.'
  },

  ownRestrictions: {
    title: '🧾 <b>Senin hakkında aldığım kararlar</b>',
    ago,
    endsIn: (span) => `${span} sonra biter`,
    ended: 'süresi doldu',
    permanent: 'süresiz',
    overturned: '↩️ geri alındı',
    unknownChat: 'adsız sohbet',
    footer: [
      'Bunlar yöneticilerin değil, botun otomatik kararlarıdır.',
      'Yanıldıysam o sohbetin bir yöneticisine yaz: yönetici bunu tek dokunuşla geri alabilir.',
      'Süreli kısıtlamalar kendiliğinden kalkar.'
    ].join('\n'),
    whyButton: (n) => `Neden? · ${n}`
  },

  helpText: [
    '🛡 <b>Neler yapabilirim</b>',
    'Spamı yakalar, dolandırıcıları kendim yasaklarım. Çoğu işlem komutla değil, düğmelerle yapılır.',
    '',
    '<b>Herkes:</b>',
    '/report — spam şikâyeti (yanıt olarak ya da /report @kullanıcı veya id)',
    '/stats — şimdiye kadar ne kadar spam yakaladım',
    '/mystats — istatistiğim · /top, /top_banan — sıralamalar',
    '/lang — dil',
    '',
    '<b>Yöneticiler:</b>',
    '/settings — ayarlar paneli (özel sohbette açılır, gerisi düğmelerle)',
    '/banan /kick /del — yanıt olarak moderasyon',
    '/check — güven düğmeli kullanıcı kartı · /untrust — güveni kaldır',
    '/welcome — yeni üye karşılama · /extra, /extras — tetikleyiciler',
    '',
    'Her bildirimde tam karar kartına giden bir <b>neden?</b> bağlantısı var. Yöneticiler ayrıca <b>“✅ Spam değil”</b> düğmesini görür: kararı geri alır ve kişiyi bu sohbetin güvenilir listesine ekler.'
  ].join('\n'),

  writeFailed: '⚠️ Kaydedilmedi — tekrar dene.',
  hiddenName: (userId) => `kullanıcı ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Grup: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Bir dil seç:',
    saved: 'Tamam, Türkçe olsun',
    openInPm: 'Kendi dilini botla özel sohbette seçebilirsin — düğmeye dokun.',
    openButton: '🌐 Dil seç'
  },

  commands: {
    start: 'Botu kullanmaya başla',
    help: 'Yardım ve komutlar',
    lang: 'Dil seç',
    mystats: 'İstatistiklerim',
    stats: 'Şimdiye kadar ne kadar spam yakaladım',
    report: 'Spam şikâyeti (yanıt)',
    settings: 'Anti-spam ayarları (yöneticiler)',
    banan: 'Yanıt olarak sustur (/banan 5m)',
    kick: 'Üyeyi at (yanıt)',
    del: 'Mesajı sil (yanıt)',
    untrust: 'Güveni kaldır (yanıt)',
    check: 'Profili görüntüle (yanıt)',
    top: 'En aktif üyeler',
    topBanan: 'Muz sıralaması',
    extras: 'Kayıtlı tetikleyiciler',
    welcome: 'Yeni üye karşılamaları',
    ping: 'Botun çalıştığını kontrol et'
  },

  actions: {
    captcha: '👋 kontrol ediliyor',
    delete: '🧹 mesaj silindi',
    kick: '🚪 sohbetten atıldı',
    mute: '🔇 susturuldu',
    ban: '🔨 yasaklandı'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'neden?',
    whyButton: 'ℹ️ Neden?',
    notSpamButton: '✅ Spam değil',
    overrideDone: 'Geri alındı: kısıtlama kaldırıldı, hesap artık bu sohbetin güvenilir listesinde.',
    overridePartial: '⚠️ Tamamen geri alınamadı: kısıtlama kaldırılamadı ya da güvenilir listesine eklenemedi. Yetkilerimi kontrol et ve tekrar dokun.',
    overrideAlreadyDone: 'Zaten geri alınmış.',
    adminOnly: 'Yalnızca sohbet yöneticileri.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` Son bir günde ${accounts} hesabı çıkaramadım.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Spam mesajları siliyorum ama spam gönderenleri çıkaramıyorum — "Kullanıcıları engelle" yetkim yok.${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Spam gönderenleri engelleyebiliyorum ama mesajlarını silemiyorum — "Mesajları sil" yetkim yok.'
      }
      return `⚠️ Spam yakaladım ama hiçbir şey yapamıyorum — "Mesajları sil" ve "Kullanıcıları engelle" yetkilerim yok.${left}`
    }
  },

  reasons: {
    job_scam: 'dolandırıcı bir iş teklifine benziyor',
    crypto_scam: 'kripto dolandırıcılığı',
    gambling_promo: 'kumarhane veya bahis reklamı',
    adult_promo: '18+ içerik reklamı',
    ad_network: 'reklam ve reklam yeri satışı',
    flirt_bait: 'flört tuzağı',
    phishing: 'oltalama bağlantısı',
    channel_promo: 'istenmeyen kanal reklamı',
    guest_bot_promo: 'bahsedilerek çağrılan bir bot üzerinden reklam',
    flood: 'flood veya toplu gönderim',
    prompt_injection: 'anti-spam kontrolünü atlatma girişimi',
    other_spam: 'spam',
    known_spam_signature: 'doğrulanmış spam ile eşleşiyor',
    semantic_spam_match: 'bilinen spama çok benziyor',
    velocity_exceeded: 'aynı mesaj birden çok sohbette',
    custom_deny: 'bir sohbet kuralıyla engellendi',
    scam_flag_new: 'Telegram bu hesabı dolandırıcı olarak işaretledi',
    external_ban_new: 'hesap spam veritabanlarında',
    shared_profile_photo: 'aynı profil fotoğrafı başka birkaç hesapta da var',
    external_high_factor_new: 'hesap spam veritabanlarında',
    edit_injected_promo: 'düzenleme sırasında reklam eklendi',
    edit_injected_invisibles: 'düzenleme sırasında görünmez karakter eklendi',
    private_invite_new: 'yeni bir hesaptan özel sohbete davet',
    identity_churn_promo: 'sık ad değişikliği ve reklam',
    nsfw_promo_profile: 'profil reklam gibi çalışıyor: müstehcen fotoğraf veya video ve profilde bir kanal',
    hidden_url_new: 'yeni gelen birinden aldatıcı bağlantı',
    low_information: 'yeterli bilgi yok — şimdilik yalnızca izleniyor',
    low_information_profile: 'metin az, ama profil şüpheli',
    low_information_profile_unreachable: 'profil şüpheli, ama doğrulama gönderilemedi — şimdilik yalnızca izleniyor',
    reported_unreachable: 'hesap şikâyet edildi ve doğrulama gönderilemedi — bir saatliğine kısıtlandı',
    profile_farm_unreachable: 'reklam doğrudan profil fotoğrafında, doğrulama da gönderilemedi — bir saatliğine kısıtlandı',
    content_unconfirmed: 'profil şüpheli, ama metnin kendisi spam olarak doğrulanmadı',
    admin_report: 'yönetici şikâyeti: spam',
    trusted_report: 'güvenilir üye şikâyeti: spam',
    community_vote: 'topluluk oyladı: spam',
    forward_blacklist: 'bilinen bir spam kaynağından iletildi',
    record_ban_elsewhere: 'hesap spam veritabanları veya Telegram işareti nedeniyle başka bir sohbette zaten yasaklandı — burada ilk mesajından önce yasaklandı',
    content_ban_elsewhere: 'hesap başka bir sohbette spam nedeniyle yasaklandı — burada ilk mesajından önce yasaklandı',
    listed_arrival: 'girişte: hesap spam veritabanlarında ya da Telegram onu işaretlemiş',
    arrival_look: 'sessiz yeni üyenin profili bir spam ağına benziyor',
    arrived_with_spammer: 'bir spamcıyla birlikte katıldı ve ona benziyor — yönetici yasakladı',
    admin_arrival_ban: 'yönetici yeni üyeler listesinden yasakladı'
  },
  reasonFallback: 'şüpheli etkinlik',

  why: {
    title: '🛡 Bot yalnızca izliyor',
    inChat: (chatTitle) => `${chatTitle} sohbetinde`,
    confidence: {
      high: (percent) => `🔴 Büyük olasılıkla spam · botun tahmini %${percent}`,
      medium: (percent) => `🟠 Muhtemelen spam · botun tahmini %${percent}`,
      low: (percent) => `🟡 Spam olabilir · botun tahmini %${percent}`
    },
    noticedTitle: 'Fark ettiklerim:',
    profileReuseEvidence: (accounts) => `aynı profil fotoğrafı ${accounts} hesapta daha`,
    // The pipeline writes the model's 0..1 score; the card shows percents.
    profileMediaEvidence: (score) => `müstehcen profil fotoğrafı · puan %${Math.round(Number(score) * 100)}`,
    externalBanEvidence: (sources, when) => [
      'spam veritabanlarında',
      ...(sources > 1 ? [`${sources} kaynak`] : []),
      ...(when ? [ago(when)] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'hesap spam veritabanlarında',
      external_repeat_offender: 'spam veritabanlarında birden fazla kez listelenmiş',
      fresh_external_ban: 'kısa süre önce spam veritabanlarına eklenmiş',
      many_shared_chats: 'aynı anda birçok sohbetimizde',
      promo_in_bio: 'biyografide reklam bağlantısı',
      private_invite_in_bio: 'biyografide özel kanal davetiyesi',
      contact_in_bio: 'biyografide Telegram dışı iletişim bilgisi',
      personal_channel: 'profilde bağlı bir kanal',
      promo_in_linked_channel: 'profildeki kanalda reklam var',
      promo_in_message_link: 'bağlantı bir reklam kanalına gidiyor',
      restricted_for_spam: 'Telegram bu hesabı spam nedeniyle kısıtladı',
      just_joined: 'katılır katılmaz hemen yazdı',
      joined_during_surge: 'yeni üye akını sırasında katıldı',
      arrived_with_spammer: 'bir spamcıyla birlikte katıldı ve ona benziyor',
      scam_flag: 'Telegram bu hesabı dolandırıcı olarak işaretledi',
      fake_flag: 'Telegram bu hesabı sahte olarak işaretledi',
      restricted_flag: 'Telegram bu hesabı kısıtlamış',
      sleeper_awakened: 'uzun süredir sessiz bir hesap aniden yazmaya başladı',
      fresh_account: 'hesap çok yeni olabilir',
      new_globally: 'sohbetlerimizde yeni',
      new_in_chat: 'bu sohbette yeni',
      identity_churn_24h: 'sık ad veya profil fotoğrafı değişikliği',
      avatar_recently_set: 'profil fotoğrafı son günlerde konuldu',
      prior_spam_detections: 'bu hesaptan daha önce de spam geldi',
      unofficial_client_risk: 'resmi olmayan bir uygulamadan gönderildi',
      forward_hidden_user: 'profilini gizleyen birinden iletildi',
      forward_source_suspicious: 'şüpheli bir kaynaktan iletildi',
      hidden_url: 'gizlenmiş bir bağlantı',
      external_url: 'harici bir bağlantı',
      url_shortener: 'kısaltılmış bir bağlantı',
      private_invite_link: 'özel bir sohbete davet',
      bot_deeplink: 'bir botu başlatan bağlantı',
      messenger_contact_link: 'başka bir mesajlaşma uygulamasında iletişim bağlantısı',
      many_url_buttons: 'bağlantılı birkaç düğme',
      phone_number: 'bir telefon numarası',
      cashtag: '$ ile coin veya hisse adı',
      long_text: 'uzun metin',
      invisible_in_word: 'kelimelerin içinde gizli görünmez karakterler',
      mixed_script_word: 'tek kelimede farklı alfabelerden harfler',
      greek_homoglyph_word: 'kelimede Latin harflerine benzeyen Yunan harfleri',
      foreign_script: 'bu sohbette kullanılmayan bir yazı sistemi',
      custom_emoji_heavy: 'çok sayıda premium emoji',
      paid_media: 'ücretli medya içeriği',
      giveaway_media: 'bir çekiliş',
      story_share: 'iletilmiş bir hikâye',
      unknown_media: 'tanınmayan bir ek',
      guest_bot_delivery: 'bahsedilerek çağrılan bir bot üzerinden gönderildi',
      edited_message: 'mesaj düzenlendi',
      edit_injected_invisibles: 'düzenleme sırasında görünmez karakter eklendi',
      edit_injected_link: 'düzenleme sırasında bağlantı eklendi',
      moderation_flagged: 'metin veya fotoğrafta 18+ içerik',
      sole_avatar_replaced: 'eski hesap, tek profil fotoğrafı yakın zamanda konuldu',
      avatar_shared_with_account: 'aynı profil fotoğrafı başka bir hesapta',
      avatar_shared_with_accounts: 'aynı profil fotoğrafı birkaç hesapta',
      nsfw_avatar: '18+ profil fotoğrafı',
      suggestive_profile_media: 'müstehcene yakın profil içeriği',
      nsfw_stories: 'hikâyelerde 18+ içerik',
      nsfw_linked_channel: 'profildeki kanalın fotoğrafında 18+ içerik',
      promo_in_name: 'hesap adında reklam',
      invisible_in_name: 'adında görünmez karakterler',
      signature_candidate_match: 'bilinen spama benziyor',
      vector_similar_spam: 'anlamca bilinen spama benziyor',
      velocity_repeats: 'aynı metin tekrar tekrar gönderildi',
      velocity_wave: 'aynı metin birkaç hesaptan',
      bot_mention: 'mesajda bir bottan bahsediliyor',
      sender_burst: 'tek hesaptan gelen mesaj dizisi',
      burst_grey_repeat: 'dizideki birkaç mesaj zaten şüpheli görünüyordu'
    },
    decidedBy: {
      custom_rule: 'sohbet kuralı',
      deterministic: 'kesin kural',
      signature: 'imza veritabanı',
      vector: 'anlamsal arama',
      forward: 'iletim kaynağı kara listesi',
      velocity: 'birkaç sohbete toplu gönderim',
      moderation: 'içerik moderasyonu',
      llm: 'yapay zeka analizi',
      llm_cached: 'yapay zeka analizi (önbellekten)',
      session: 'mesaj dizisi analizi',
      burst: 'tek hesaptan gelen mesaj dizisinin analizi',
      score: 'sinyal puanı',
      abstain: 'karar yok',
      error: 'hata',
      join_screen: 'katılım kontrolü',
      captcha_ignored: 'kontrol yok sayıldı'
    },
    expired: 'Bu kararın ayrıntıları artık saklanmıyor.',
    appeal: 'Bu bir hataysa bu sohbetin bir yöneticisine yaz — yönetici kararı geri alabilir.'
  },

  profile: {
    title: '👤 Profil',
    openButton: '👤 Profil',
    accountAge: (age) => `hesap ${age}`,
    // A span under a minute is a first sighting too, not a tenure.
    firstSeen: (seen) => (seen === NEVER_SEEN || seen === NOW ? 'bot ilk kez görüyor' : `bot ${seen} süredir tanıyor`),
    activity: (messages, chats) =>
      [
        ...(messages === null ? [] : [`${messages} mesaj`]),
        `${chats} sohbette`
      ].join(' · '),
    reputation: (status) => `itibar: ${status}`,
    premium: 'Premium',
    externalBan: (when, offenses) => [
      'spam veritabanlarında',
      ...(when ? [`${ago(when)} yasaklandı`] : []),
      ...(offenses > 1 ? [`${offenses} ihlal`] : [])
    ].join(' · '),
    justJoined: (span) => (span === NOW ? 'sohbete az önce katıldı' : `sohbete katılalı yalnızca ${span}`),
    promoInBio: 'biyografide reklam',
    personalChannel: 'bağlı kanal',
    unknownAge: 'yaşı bilinmiyor',
    neverSeen: NEVER_SEEN,
    units: { now: NOW, m: 'dk', h: 'sa', d: 'g', mo: 'ay', y: 'yıl' },
    checkNeedReply: 'Bir kullanıcının mesajına /check ile yanıt ver.',
    notFound: 'Profil alınamadı.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Bu spam mı?</b> Gönderen: ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Bu spam mı?</b> Gönderen: ${userLabel} · metin yok, yalnızca ${what}`
        : `🤔 <b>Bu spam mı?</b> Gönderen: ${userLabel} · metin yok`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'fotoğraf', sticker: 'çıkartma', video: 'video',
      voice: 'sesli mesaj veya ses kaydı', file: 'dosya', other: 'ek'
    },
    redacted: { link: '[bağlantı]', mention: '[@kullanıcı]', invite: '[davet]' },
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `✅ Spam değil (${count})`,
    counted: 'Oy sayıldı.',
    enforcement: {
      done: 'Mesaj silindi, yazar kısıtlandı.',
      deletedOnly: 'Mesaj silindi, ama yazar kısıtlanamadı.',
      mutedOnly: 'Yazar kısıtlandı, ama mesaj silinemedi.',
      failed: '⚠️ Ne mesaj silinebildi ne de yazar kısıtlanabildi.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      // The name follows a "·": a suffix cannot be attached to a display name.
      '🗑 Topluluk karar verdi: spam' + (who ? ` · ${who}` : '')
      + (enforcement ? `. ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      '✅ Topluluk karar verdi: spam değil' + (who ? ` · ${who}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Bu oylama zaten kapandı.',
    voters: {
      button: '👥 Kim oy verdi',
      title: (spam, ham) => `👥 <b>Oylama</b> · spam ${spam} : ${ham} spam değil`,
      spamGroup: '🗑 Spam',
      hamGroup: '✅ Spam değil',
      adminMark: 'yönetici',
      changedMark: 'oyunu değiştirdi',
      span: (span) => (span === NOW ? '⏱ tüm oylar bir dakikadan kısa sürede geldi' : `⏱ ilk oydan son oya: ${span}`),
      more: (count) => `…ve ${count} kişi daha`,
      nobody: 'Kimse zamanında oy vermedi.',
      notForTarget: 'Bu oylama seninle ilgili: bu oylamada oy veremez, kimin oy verdiğini de göremezsin.',
      noStanding: 'Oy sayılmadı: en az bir haftadır sohbette olup burada en az 10 mesaj (ya da botun sohbetlerinde en az 50 mesaj) yazanlar veya bir yıldan uzun süredir sohbette olanlar oy verebilir.',
      knownBad: 'Oy sayılmadı: bu hesaptan daha önce spam geldi.'
    }
  },

  report: {
    needReply: '/report komutunu bir mesaja yanıt olarak kullan ya da kişiyi belirt: /report @kullanıcı, /report 123456789 veya @ ile listeden seç.',
    notFound: (who) => `${who} kullanıcısını bu sohbette görmedim. Bu kişinin bir mesajına yanıt ver ya da @ ile listeden seç.`,
    notInChat: 'Bu kişi artık sohbette değil.',
    cantReportAdmin: 'Yöneticiler şikâyet edilemez.',
    rateLimited: 'Çok fazla şikâyet. Birkaç dakika bekle.',
    accepted: 'Şikâyetini aldım, teşekkürler.',
    oneAtATime: 'Bu, birden fazla kişinin katıldığını bildiren mesaj. Şikâyet ettiğin kişinin mesajına yanıt ver.',
    voteClosed: 'Bu mesajla ilgili oylama kapandı. Kararı bir yönetici verebilir.',
    channelSender: 'Bu bir kanal adına gönderildi. Kanalı yalnızca bir yönetici engelleyebilir.'
  },

  botStats: {
    title: '🛡 <b>Şimdiye kadar ne yaptım</b>',
    window: (days) => `Son ${days} günde:`,
    checked: (count) => `📬 <b>${n(count)}</b> mesaj kontrol edildi`,
    spammers: (count) => `🚫 <b>${n(count)}</b> spam hesabı engellendi`,
    chats: (count) => `💬 <b>${n(count)}</b> sohbet koruma altında`,
    speed: (ms) => `⚡ karar süresi: <b>${n(ms)} ms</b>`,
    quiet: (percent) => `Hiç dokunmadığım mesajlar: <b>%${decimal1(percent)}</b>. Spam yoksa sesim çıkmaz.`,
    reasonsTitle: '<b>En çok yakaladıklarım:</b>',
    reasonLine: (name, count) => `• ${name} — ${n(count)}`,
    memory: (signatures) => `🧠 Hafızamda ${n(signatures)} spam imzası var`,
    corrections: (percent) => `✅ Yöneticilerin geri aldığı kararlarım: %${decimal1(percent)}`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> · son ${days} gün`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${n(checked)} kontrol · 🚫 ${n(spammers)} spam hesabı · 🧹 ${n(deletes)} silindi`,
    chatLastSpam: (span) => `Son spam: ${ago(span)}`,
    chatClean: '✨ Bot bu süre boyunca spam tespit etmedi.',
    unavailable: '📊 Sayılara şu an ulaşamıyorum, biraz sonra tekrar dene.',
    button: '📊 Bot istatistikleri'
  },

  stats: {
    title: '📊 <b>İstatistiklerin</b>',
    inChat: (count, chatTitle) => chatTitle ? `${chatTitle} sohbetindeki mesajlar: ${count}` : `Bu sohbetteki mesajlar: ${count}`,
    global: (count) => `Tüm sohbetlerdeki mesajlar: ${count}`,
    reputation: (score, status) => `İtibar: ${score} (${status})`,
    repStatus: { trusted: 'olumlu', neutral: 'nötr', suspicious: 'şüpheli', restricted: 'kısıtlı' },
    bananCaught: (count) => `Yakalanan muzlar: ${count} 🍌`,
    openInPm: 'İstatistiklerin botla özel sohbette — düğmeye dokun.',
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
    success: (name) => `👋 ${name} sohbetten atıldı.`,
    needReply: 'Atmak istediğin kişinin mesajına /kick ile yanıt ver.'
  },

  untrust: {
    success: (name) => `🔓 Güven kaldırıldı: ${name}. Mesajları yine kontrol edilecek.`,
    needReply: 'Güvenini kaldırmak istediğin kişinin mesajına /untrust ile yanıt ver.',
    notTrusted: (name) => `ℹ️ ${name} güvenilir listesinde değil — kaldırılacak bir şey yok.`
  },

  trust: {
    button: '✅ Güven',
    untrustButton: '🔓 Güveni kaldır',
    added: 'Bu sohbetin güvenilir listesine eklendi.',
    removed: 'Güven kaldırıldı.',
    grantedBy: (who, span, via) =>
      `✅ Güven veren: ${who}, ${ago(span)}` +
      (via === 'override' ? ' · botun kararını geri aldı' : via === 'vote' ? ' · yönetici oyuyla' : ''),
    grantUnknown: '✅ Güvenilir · güveni kimin ne zaman verdiği kayıtlı değil'
  },

  welcome: {
    enabled: '👋 Karşılama mesajları açık.',
    disabled: '👋 Karşılama mesajları kapalı.',
    textSet: '✅ Karşılama metni kaydedildi. %name% yerine yeni üyenin adı yazılır.',
    gifSet: '✅ Karşılama medyası kaydedildi.',
    usage: [
      '/welcome — aç/kapat',
      '/welcome <%name% içeren metin> — karşılamayı ayarla',
      'bir GIF’e /welcome ile yanıt ver — GIF’i ayarla'
    ].join('\n'),
    limit: '⚠️ Daha fazla eklenemez: limit doldu. Önce ayarlardan bir şey sil.',
    duplicate: 'ℹ️ Zaten eklendi.',
    tooLong: '⚠️ Metin çok uzun (en fazla 1000 karakter).',
    saveFailed: '⚠️ Kaydedilemedi.',
    surgeAlert: (count, riskCount) => `⚠️ Yeni üye akını: ${count} üye, bunlardan ${riskCount} kişi şüpheli profilli`,
    defaultGreeting: (name) => `👋 Hoş geldin, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Yeni üye karşılaması</b>\n\nDurum: ${state}\nMetin: ${nTexts} · GIF: ${nGifs}\n\nBirden fazlaysa bot her seferinde rastgele birini seçer.`,
      enable: '🔔 Aç',
      disable: '🔕 Kapat',
      texts: (n) => `📝 Metinler (${n})`,
      gifs: (n) => `🎞 Medya (${n})`,
      preview: '👁 Önizle',
      textsTitle: (n, max) => `📝 <b>Karşılama metinleri</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Karşılama metinleri</b>\n\nHenüz boş. İlkini ekle — yeni üyenin adı için <code>%name%</code> kullanabilirsin.',
      addText: '➕ Metin ekle',
      gifsTitle: (n, max) => `🎞 <b>Karşılama medyası</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 medya #${i}`,
      gifsEmpty: '🎞 <b>Karşılama medyası</b>\n\nHenüz boş. Bir GIF, video veya fotoğraf gönder.',
      addGif: '➕ Medya ekle',
      promptText: '📝 Karşılama metnini tek mesajda gönder.\n<code>%name%</code> ekleyebilirsin — yeni üyenin adını koyarım.\n\nİptal için /cancel.',
      promptGif: '🎞 Bir GIF, video veya fotoğraf tek mesajda gönder.\n\nİptal için /cancel.',
      added: '✅ Eklendi.',
      cancelled: '↩️ İptal edildi.',
      invalidGif: '⚠️ Burada GIF, video veya fotoğraf gerekiyor — bunlardan birini gönder.',
      removed: '🗑 Silindi.',
      removeMissing: 'O zaten yok — listeyi yeniledim.',
      expired: '⌛ Süre doldu. Düzenleyiciyi yeniden aç.',
      previewEmpty: 'Gösterilecek bir şey yok — metin, GIF, video veya fotoğraf ekle.'
    }
  },

  extra: {
    saved: (name) => `✅ Kaydedildi: #${name}`,
    deleted: (name) => `🗑 Silindi: #${name}`,
    notFound: (name) => `Böyle bir tetikleyici yok: #${name}`,
    usage: [
      '/extra ad (bir mesaja yanıt vererek) — mesajı #ad adıyla kaydeder',
      '/extra ad (yanıt yok) — tetikleyiciyi siler'
    ].join('\n'),
    listTitle: '📂 Kayıtlı tetikleyiciler:',
    listEmpty: 'Burada henüz tetikleyici yok.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Tetikleyiciler</b> (${n})\n\nSohbette <code>#ad</code> yaz, bot kayıtlı yanıtı gönderir.\nLimit: mesaj başına en fazla ${max} yanıt.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Tetikleyiciler</b>\n\nHenüz boş. İlkini ekle — ad + metin veya medya.',
      add: '➕ Tetikleyici ekle',
      maxLabel: (n) => `Limit: ${n}`,
      promptName: '#️⃣ Tetikleyici adını (# olmadan) tek kelime gönder.\n\nİptal için /cancel.',
      promptContent: (name) => `Şimdi botun <code>#${name}</code> için vereceği yanıtı gönder: metin, GIF, fotoğraf veya video.\n\nİptal için /cancel.`,
      added: (name) => `✅ #${name} tetikleyicisi kaydedildi.`,
      cancelled: '↩️ İptal edildi.',
      invalidName: '⚠️ Ad tek kelime olmalı: harf, rakam veya _, boşluksuz.',
      removed: '🗑 Silindi.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} ${duration} boyunca muzu yedi`,
    lifted: (name) => `🍌 ${name} muzu kaybetti`,
    self: (name, duration) => `🍌 ${name} kendini ${duration} boyunca muzladı. Saygılar`,
    needReply: 'Yanıt olarak /banan kullan veya kendini muzlamak için sade /banan yaz.',
    undoButton: '↩️ Geri al',
    units: { m: 'dk', h: 'sa', d: 'g' },
    show: (name) => `🍌 ${name} muzu gösteriyor`
  },

  captcha: {
    prompt: (name, minutes) =>
      `👋 ${name}, sohbete devam etmek için ${minutes === undefined ? '' : `${minutes} dakika içinde `}düğmeye dokun. Bot olmadığını gösteren hızlı bir kontrol.`,
    button: '🙋 Ben insanım',
    passed: 'Tamam, devam edebilirsin.',
    retry: 'Kısıtlama kaldırılamadı. Tekrar dokun.',
    notForYou: 'Bu düğme başka bir üye için.'
  },

  settings: {
    openInPm: 'Ayarlar botla özel sohbette — düğmeye dokun.',
    openInPmButton: '⚙️ Ayarları aç',
    title: '⚙️ <b>Anti-spam ayarları</b>',
    preset: 'Mod',
    presets: { soft: 'Yumuşak', standard: 'Standart', strict: 'Sıkı' },
    captcha: 'Yeni gelenler için captcha',
    voting: 'Topluluk oylaması',
    enabled: 'Anti-spam',
    banDatabase: 'Spam veritabanları',
    quiet: 'Sessiz mod',
    quietHint: '🤫 Botun emin olduğu işlemlerin bildirimleri sessiz ve düğmesiz gelir, 5 sn sonra silinir. Yaptığı her şey “🧾 Son işlemler” altında. Oylamalar ve emin olunmayan kararlar her zamanki gibi gösterilir.',
    rightsMissing: ({ deleteBlocked, senderBlocked }) => {
      const missing = [...(deleteBlocked ? ['"Mesajları sil"'] : []), ...(senderBlocked ? ['"Kullanıcıları engelle"'] : [])]
      return (missing.length > 1 ? '⚠️ Eksik yetkiler: ' : '⚠️ Eksik yetki: ') + missing.join(', ')
    },
    banan: 'Banan süresi',
    language: 'Bu sohbette bot dili',
    languageSaved: 'Sohbet dili güncellendi',
    welcome: '👋 Karşılama',
    extras: '#️⃣ Tetikleyiciler',
    on: 'Açık',
    off: 'Kapalı',
    back: '‹ Geri'
  }
}
