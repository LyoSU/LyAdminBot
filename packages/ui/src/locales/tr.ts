import type { Locale } from '../locale.js'
import { decimal1, groupDigits } from '../format.js'

/** Turkish number typography: thousands by point, decimals by comma. */
const n = (v: number): string => groupDigits(v, '.')

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
    groupHint: '🛡 Spam yakalarım ve dolandırıcıları yasaklarım.\n<code>/settings</code> yöneticiler için · <code>/help</code> komutlar',
    addToGroupButton: '➕ Gruba ekle',
    helpButton: '❓ Komutlar',
    langButton: '🌐 Dil'
  },

  helpText: [
    '🛡 <b>Neler yapabilirim</b>',
    'Spam’i yakalar, dolandırıcıları kendim banlarım. Çoğu işlem komut değil, butonla.',
    '',
    '<b>Herkes:</b>',
    '/report — spam bildir (yanıt olarak)',
    '/stats — ne kadar spam engelledim',
    '/mystats — istatistiğim · /top, /top_banan — sıralamalar',
    '/lang — dil',
    '',
    '<b>Yöneticiler:</b>',
    '/settings — ayarlar paneli (PM’de açılır, gerisi butonlarla)',
    '/banan /kick /del — yanıt olarak moderasyon',
    '/check — butonlu kullanıcı kartı (güven vb.)',
    '/welcome — yeni üye karşılama · /extra, /extras — tetikleyiciler',
    '',
    'Her bildirimde tam karar kartına giden bir <b>neden?</b> bağlantısı var. Yöneticiler ayrıca <b>[✅ Spam değil]</b> görür.'
  ].join('\n'),

  writeFailed: '⚠️ Kaydedilmedi — tekrar dene.',
  hiddenName: (userId) => `kullanıcı ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Grup: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Bir dil seç:',
    saved: 'Tamam, Türkçe olsun',
    openInPm: 'Kendi dilini benimle özelden seç.',
    openButton: '🌐 Dil seç'
  },

  commands: {
    start: 'Botu kullanmaya başla',
    help: 'Yardım ve komutlar',
    lang: 'Dil seç',
    mystats: 'İstatistiklerim',
    stats: 'Ne kadar spam engelledim',
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
    kick: '🚪 sohbetten çıkarıldı',
    mute: '🔇 susturuldu',
    ban: '🔨 yasaklandı'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'neden?',
    whyButton: '🤨 Neden?',
    notSpamButton: '✅ Spam değil',
    overrideDone: 'Tamam, geri alındı. Kullanıcı geri döndü ve artık bu sohbette güveniliyor.',
    overridePartial: 'Geri aldım, ama her şey uygulanamadı. Tekrar dene veya yetkilerimi kontrol et.',
    overrideAlreadyDone: 'Zaten geri alınmış.',
    adminOnly: 'Yalnızca sohbet yöneticileri.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` Bu yüzden bugün ${accounts} hesap sohbette kaldı.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ Spam mesajları siliyorum ama spam gönderenleri çıkaramıyorum — "Kullanıcıları engelle" yetkim yok.${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ Spam gönderenleri engelleyebiliyorum ama mesajlarını silemiyorum — "Mesajları sil" yetkim yok.'
      }
      return `⚠️ Spam yakaladım ama hiçbir şey yapmaya yetkim yok. Lütfen bana "Mesajları sil" ve "Kullanıcıları engelle" yetkilerini ver.${left}`
    }
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
    shared_profile_photo: 'aynı profil fotoğrafı başka hesaplarda da var',
    external_high_factor_new: 'hesap spam veritabanlarında',
    edit_injected_promo: 'mesaj, reklam eklemek için düzenlendi',
    edit_injected_invisibles: 'düzenlemeyle görünmez karakter eklendi',
    private_invite_new: 'yeni bir hesaptan özel davet',
    identity_churn_promo: 'sık ad değişikliği + reklam içeriği',
    nsfw_promo_profile: 'profilin kendisi bir reklam (müstehcen içerik + bağlı kanal)',
    hidden_url_new: 'yeni gelen birinden aldatıcı bağlantı',
    low_information: 'yeterli bilgi yok, izleniyor',
    low_information_profile: 'yargılamak için az bilgi, şüpheli profil — doğrulama istendi',
    content_unconfirmed: 'şüpheli profil, mesaj içeriği doğrulanmadı',
    admin_report: 'bir yönetici bunu spam olarak bildirdi',
    community_vote: 'topluluk oyladı: spam',
    forward_blacklist: 'bilinen bir spam kaynağından iletildi'
  },
  reasonFallback: 'şüpheli etkinlik',

  why: {
    title: '🛡 Neden işlem yaptım',
    inChat: (chatTitle) => `${chatTitle} sohbetinde`,
    confidence: {
      high: (percent) => `🔴 Büyük olasılıkla spam · ${percent}%`,
      medium: (percent) => `🟠 Muhtemelen spam · ${percent}%`,
      low: (percent) => `🟡 Spam olabilir · ${percent}%`
    },
    noticedTitle: 'Fark ettiklerim:',
    externalBanEvidence: (sources, ago) => [
      'spam veritabanlarında',
      ...(sources > 1 ? [`${sources} kaynak`] : []),
      ...(ago ? [`${ago} önce`] : [])
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
      promo_in_linked_channel: 'profildeki kanalın kendisi bir reklam',
      promo_in_message_link: 'bağlantı bir reklam kanalına gidiyor',
      restricted_for_spam: 'Telegram spam nedeniyle kısıtladı',
      just_joined: 'katılır katılmaz hemen yazdı',
      joined_during_surge: 'yeni üye akını sırasında katıldı',
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
      greek_homoglyph_word: 'bir kelimede benzerlerinin yerine geçen Yunan harfleri',
      foreign_script: 'bu sohbette kullanılmayan bir yazı sistemi',
      custom_emoji_heavy: 'çok sayıda özel emoji',
      paid_media: 'ücretli medya içeriği',
      giveaway_media: 'bir çekiliş',
      story_share: 'paylaşılan bir hikaye',
      unknown_media: 'tanınmayan bir ek',
      guest_bot_delivery: 'bir misafir bot üzerinden teslim edildi',
      edited_message: 'mesaj düzenlendi',
      edit_injected_invisibles: 'düzenlemeyle görünmez karakter eklendi',
      edit_injected_link: 'düzenlemeyle bağlantı eklendi',
      moderation_flagged: 'metin veya fotoğrafta NSFW',
      sole_avatar_replaced: 'eski bir hesapta yeni konulmuş tek profil fotoğrafı',
      avatar_shared_with_account: 'aynı profil fotoğrafı başka bir hesapta',
      avatar_shared_with_accounts: 'aynı profil fotoğrafı birkaç hesapta',
      nsfw_avatar: 'NSFW profil fotoğrafı',
      suggestive_profile_media: 'müstehcene yakın profil içeriği',
      nsfw_stories: 'NSFW hikaye',
      nsfw_linked_channel: 'kanal fotoğrafında NSFW',
      promo_in_name: 'hesap adında reklam',
      invisible_in_name: 'adda görünmez karakterler',
      signature_candidate_match: 'bilinen spama benziyor',
      vector_similar_spam: 'anlamca spama yakın',
      velocity_repeats: 'aynı metin tekrar tekrar gönderildi',
      velocity_wave: 'aynı metin birkaç hesaptan',
      bot_mention: 'bot bahsi',
      sender_burst: 'tek hesaptan gelen mesaj dizisi',
      burst_grey_repeat: 'birkaç mesajı zaten şüpheli görünen dizi'
    },
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
      burst: 'tek gönderenin dizisinin analizi',
      score: 'sinyal puanı',
      abstain: 'çekimser kalındı',
      error: 'hata'
    },
    expired: 'Bu kararın süresi doldu — ayrıntı kalmadı.'
  },

  profile: {
    title: '👤 Profil',
    openButton: '👤 Profil',
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
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Bu spam mı?</b> ${userLabel} adlı kullanıcıdan mesaj`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Bu spam mı?</b> ${userLabel} kişisinden gelen mesajda metin yok, yalnızca ${what} var.`
        : `🤔 <b>Bu spam mı?</b> ${userLabel} kişisinden gelen mesajda metin yok.`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'fotoğraf', sticker: 'çıkartma', video: 'video',
      voice: 'sesli mesaj', file: 'dosya', other: 'ek'
    },
    redacted: { link: '[bağlantı]', mention: '[@kullanıcı]', invite: '[davet]' },
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `👌 Sorun yok (${count})`,
    counted: 'Oy sayıldı.',
    enforcement: {
      done: 'Kaldırıldı.',
      deletedOnly: 'Kaldırıldı, ama yazarı susturamadım — yetki yok.',
      mutedOnly: 'Yazarı susturdum, ama mesajı kaldıramadım.',
      failed: '⚠️ Ne kaldırabildim ne kısıtlayabildim — yetki yok.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      (who ? `🗑 Topluluk ${who} kişisinin mesajına spam dedi.` : '🗑 Topluluk spam diyor.')
      + (enforcement ? ` ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      (who ? `👌 Topluluk ${who} kişisinin mesajında sorun görmedi.` : '👌 Topluluk sorun olmadığını söylüyor.')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'Bu oylama zaten kapandı.',
    voters: {
      button: '👥 Kim oy verdi',
      title: (spam, ham) => `👥 <b>Oylama</b> · spam ${spam} : ${ham} temiz`,
      spamGroup: '🗑 Spam',
      hamGroup: '👌 Temiz',
      adminMark: 'yönetici',
      changedMark: 'oyunu değiştirdi',
      span: (span) => `⏱ ilk oydan son oya: ${span}`,
      more: (count) => `…ve ${count} kişi daha`,
      nobody: 'Kimse zamanında oy vermedi.',
      notForTarget: 'Bu oylama seninle ilgili.',
      noStanding: 'Oy verme, sohbete yerleşmiş üyeler içindir.',
      knownBad: 'Oyun burada sayılmıyor.'
    }
  },

  report: {
    needReply: 'Bildirmek istediğin mesaja yanıt olarak /report kullan.',
    cantReportAdmin: 'Yöneticiler bildirilemez.',
    rateLimited: 'Çok fazla bildirim. Birkaç dakika bekle.',
    accepted: 'Anlaşıldı, teşekkürler.',
    oneAtATime: 'O satırda birden fazla kişi katıldı. Kastettiğin kişinin mesajına yanıt ver.'
  },

  botStats: {
    title: '🛡 <b>Şimdiye kadar ne yaptım</b>',
    window: (days) => `Son ${days} günde:`,
    checked: (count) => `📬 <b>${n(count)}</b> mesaj kontrol edildi`,
    spammers: (count) => `🚫 <b>${n(count)}</b> spam hesabı engellendi`,
    chats: (count) => `💬 <b>${n(count)}</b> sohbet koruma altında`,
    speed: (ms) => `⚡ karar <b>${n(ms)} ms</b> içinde`,
    quiet: (percent) => `Mesajların <b>%${decimal1(percent)}</b> kadarına hiç dokunmadım. Spam yoksa sesim çıkmaz.`,
    reasonsTitle: '<b>En çok yakaladıklarım:</b>',
    reasonLine: (name, count) => `• ${name} — ${n(count)}`,
    memory: (signatures) => `🧠 Hafızamda ${n(signatures)} spam imzası var`,
    corrections: (percent) => `✅ Yöneticiler kararlarımın %${decimal1(percent)} kadarını geri aldı`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> · son ${days} gün`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${n(checked)} kontrol · 🚫 ${n(spammers)} spam hesabı · 🧹 ${n(deletes)} silindi`,
    chatLastSpam: (ago) => `Son spam: ${ago} önce`,
    chatClean: '✨ Bu süre boyunca tek bir spam yok.',
    unavailable: '📊 Sayılara şu an ulaşamıyorum, biraz sonra tekrar dene.',
    button: '📊 Rakamlarım'
  },

  stats: {
    title: '📊 <b>İstatistiklerin</b>',
    inChat: (count, chatTitle) => chatTitle ? `${chatTitle} sohbetindeki mesajlar: ${count}` : `Bu sohbetteki mesajlar: ${count}`,
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

  trust: {
    button: '✅ Güven',
    untrustButton: '🔓 Güveni kaldır',
    added: 'Bu sohbetin güvenilir listesine eklendi.',
    removed: 'Güven kaldırıldı.'
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
    limit: '⚠️ Limite ulaşıldı — önce ayarlardan bir şey sil.',
    duplicate: 'ℹ️ Zaten eklendi.',
    tooLong: '⚠️ Metin çok uzun (en fazla 1000 karakter).',
    saveFailed: '⚠️ Kaydedilemedi.',
    surgeAlert: (count, riskCount) => `⚠️ Hızlı katılım · ${count} üye · ${riskCount} risk işareti`,
    defaultGreeting: (name) => `👋 Hoş geldin, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Yeni üye karşılaması</b>\n\nDurum: ${state}\nMetin: ${nTexts} · Gif: ${nGifs}\n\nBirden fazlaysa bot her seferinde rastgele birini seçer.`,
      enable: '🔔 Aç',
      disable: '🔕 Kapat',
      texts: (n) => `📝 Metinler (${n})`,
      gifs: (n) => `🎞 Gifler (${n})`,
      preview: '👁 Önizle',
      textsTitle: (n, max) => `📝 <b>Karşılama metinleri</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Karşılama metinleri</b>\n\nHenüz boş. İlkini ekle — yeni üyenin adı için <code>%name%</code> kullanabilirsin.',
      addText: '➕ Metin ekle',
      gifsTitle: (n, max) => `🎞 <b>Karşılama gifleri</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 gif #${i}`,
      gifsEmpty: '🎞 <b>Karşılama gifleri</b>\n\nHenüz boş. İlkini ekle — bir gif, video veya fotoğraf gönder.',
      addGif: '➕ Gif ekle',
      promptText: '📝 Karşılama metnini tek mesajda gönder.\n<code>%name%</code> ekleyebilirsin — yeni üyenin adını koyarım.\n\nİptal için /cancel.',
      promptGif: '🎞 Bir gif, video veya fotoğraf tek mesajda gönder.\n\nİptal için /cancel.',
      added: '✅ Eklendi.',
      cancelled: '❌ İptal edildi.',
      invalidGif: '⚠️ Bu bir medya değil. Bir gif, video veya fotoğraf gönder.',
      removed: '🗑 Silindi.',
      removeMissing: 'O zaten yok — listeyi yeniledim.',
      expired: '⌛ Süre doldu. Düzenleyiciyi yeniden aç.',
      previewEmpty: 'Gösterilecek bir şey yok — metin veya gif ekle.'
    }
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
    listEmpty: 'Burada henüz tetikleyici yok.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Tetikleyiciler</b> (${n})\n\nSohbette <code>#ad</code> yaz, bot kayıtlıyı gönderir.\nMesaj başına en fazla: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Tetikleyiciler</b>\n\nHenüz boş. İlkini ekle — ad + metin veya medya.',
      add: '➕ Tetikleyici ekle',
      maxLabel: (n) => `Maks: ${n}`,
      promptName: '#️⃣ Tetikleyici adını (# olmadan) tek kelime gönder.\n\nİptal için /cancel.',
      promptContent: (name) => `Şimdi <code>#${name}</code> için içeriği gönder — metin veya medya (gif/foto/video).\n\nİptal için /cancel.`,
      added: (name) => `✅ #${name} tetikleyicisi kaydedildi.`,
      cancelled: '❌ İptal edildi.',
      invalidName: '⚠️ Ad tek kelime olmalı, boşluksuz (harf/rakam/_).',
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
    prompt: (name) => `👋 ${name}, sohbete devam etmek için düğmeye dokun. Bot olmadığını gösteren hızlı bir kontrol.`,
    button: '🙋 Ben insanım',
    passed: 'Tamam, devam edebilirsin.',
    retry: 'Kısıtlama kaldırılamadı. Tekrar dokun.',
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
