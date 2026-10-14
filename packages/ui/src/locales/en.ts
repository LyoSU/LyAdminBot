import type { Locale } from '../locale.js'
import { decimal1, groupDigits } from '../format.js'

/** English number typography: thousands by comma, decimals by point. */
const n = (v: number): string => groupDigits(v, ',')
const s = (v: number): string => (v === 1 ? '' : 's')

/**
 * "now" is already a point in time: "now ago" is not English. Every
 * "<span> ago" in this file goes through here, so a span under a minute reads
 * "just now" wherever an elapsed time is printed.
 */
const NOW = 'now'
const ago = (span: string): string => (span === NOW ? 'just now' : `${span} ago`)

export const en: Locale = {
  languageName: 'English',

  start: {
    privateCard: (name) => [
      `Hey, <b>${name}</b>! 👋`,
      '',
      '🛡 <b>Anti-spam for groups.</b>',
      'I catch spam, ban scammers, clean up ads.',
      '',
      'Add me to a group → grant admin rights → done.'
    ].join('\n'),
    liveProof: (chats, spammers, days) =>
      `📊 Right now I guard <b>${n(chats)}</b> chat${s(chats)}: <b>${n(spammers)}</b> spammer${s(spammers)} blocked in ${days} day${s(days)}.`,
    groupHint: '🛡 I catch spam and ban scammers.\n<code>/settings</code> for admins · <code>/help</code> commands',
    addToGroupButton: '➕ Add to group',
    helpButton: '❓ Commands',
    langButton: '🌐 Language'
  },
  arrivals: {
    button: '👥 Newcomers',
    title: '👥 <b>Who joined the chat this week</b>',
    empty: 'The bot has not seen anyone join this chat this week.',
    silent: 'silent',
    spoke: (count) => `wrote: ${count}`,
    suspect: 'joined alongside a spammer',
    outcomes: {
      removed: 'removed',
      banned_on_record: 'banned via spam databases',
      banned_carried: 'banned in another chat for spam',
      banned_by_admin: 'banned by an admin',
      gated: 'being checked'
    },
    footer: '⚠️ — joined alongside a spammer and looks like it. "🚫 N" bans number N.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Ban everyone still silent (${count})`,
    confirmAll: (count) => `Ban <b>${count}</b> ${count === 1 ? 'newcomer who has' : 'newcomers who have'} not written anything yet?`,
    confirmYes: '🚫 Yes, ban',
    cancel: 'Cancel',
    banned: (count) => `Banned: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>${count} similar ${count === 1 ? 'newcomer' : 'newcomers'} joined alongside the spammer ${spammer}</b>`,
    hint: 'Similar profile, joined around the same time, no messages yet. The bot has not touched anyone — an admin decides.',
    banButton: (count) => `🚫 Ban ${count}`,
    keepButton: 'Keep',
    banned: (done, total, admin) => `🚫 Banned ${done} of ${total} newcomer${s(total)} who joined alongside the spammer · ${admin}`,
    kept: (admin) => `✅ Newcomers kept · ${admin}`,
    expired: 'This card is out of date.'
  },

  chatActions: {
    button: '🧾 Recent actions',
    title: '🧾 <b>What the bot did in this chat</b>',
    empty: 'Nothing yet: the bot has not acted on anyone in this chat.',
    footer: '“Why?” opens the evidence, and “Not spam” if the bot got it wrong.'
  },

  ownRestrictions: {
    title: '🧾 <b>What I did about you</b>',
    ago,
    endsIn: (span) => `ends in ${span}`,
    ended: 'already over',
    permanent: 'no end date',
    overturned: '↩️ reversed',
    unknownChat: 'untitled chat',
    footer: [
      'These were automatic decisions by the bot, not by the admins.',
      "If I got it wrong, write to an admin of that chat: they can undo it with one tap.",
      'Restrictions with a term lift by themselves.'
    ].join('\n'),
    whyButton: (n) => `Why? · ${n}`
  },

  helpText: [
    '🛡 <b>What I do</b>',
    'I catch spam and ban scammers on my own. Most actions are buttons, not commands.',
    '',
    '<b>Everyone:</b>',
    '/report — report spam (as a reply, or /report @username or id)',
    '/stats — how much spam I have caught',
    '/mystats — my stats · /top, /top_banan — leaderboards',
    '/lang — language',
    '',
    '<b>Admins:</b>',
    '/settings — settings panel (opens in PM, all buttons there)',
    '/banan /kick /del — moderation as a reply',
    '/check — user card with buttons (trust, etc.)',
    '/welcome — newcomer greetings · /extra, /extras — triggers',
    '',
    'Every notice carries a <b>why?</b> link with the full decision card. Admins also get <b>[✅ Not spam]</b>.'
  ].join('\n'),

  writeFailed: '⚠️ Not saved — try again.',
  hiddenName: (userId) => `user ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Group: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Pick a language:',
    saved: 'Done, English it is',
    openInPm: 'Pick your own language in a PM with me.',
    openButton: '🌐 Pick a language'
  },

  commands: {
    start: 'Start using the bot',
    help: 'Help and commands',
    lang: 'Choose language',
    mystats: 'My stats',
    stats: 'How much spam I have caught',
    report: 'Report spam (reply)',
    settings: 'Anti-spam settings (admins)',
    banan: 'Mute via reply (/banan 5m)',
    kick: 'Kick a member (reply)',
    del: 'Delete a message (reply)',
    untrust: 'Revoke trust (reply)',
    check: 'Look up a profile (reply)',
    top: 'Top active members',
    topBanan: 'Top by bananas',
    extras: 'Saved triggers',
    welcome: 'Newcomer greetings',
    ping: 'Check the bot is alive'
  },

  actions: {
    captcha: '👋 checking',
    delete: '🧹 spam removed',
    kick: '🚪 kicked from chat',
    mute: '🔇 muted',
    ban: '🔨 banned'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'why?',
    whyButton: '🤨 Why?',
    notSpamButton: '✅ Not spam',
    overrideDone: 'Done, reverted. User is back and trusted in this chat now.',
    overridePartial: 'Reverted, but not everything went through. Try again, or check my rights.',
    overrideAlreadyDone: 'Already reverted.',
    adminOnly: 'Chat admins only.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` ${accounts} account${accounts === 1 ? '' : 's'} stayed in the chat because of it today.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ I delete the spam, but I cannot remove the spammers — I am missing the "Ban users" right.${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ I can ban the spammers, but I cannot delete their messages — I am missing the "Delete messages" right.'
      }
      return `⚠️ Caught spam and I am allowed to do nothing about it. Please grant me the "Delete messages" and "Ban users" rights.${left}`
    }
  },

  reasons: {
    job_scam: 'looks like a job scam',
    crypto_scam: 'crypto scam',
    gambling_promo: 'casino/betting promo',
    adult_promo: '18+ promo',
    ad_network: 'ad placement offer',
    flirt_bait: 'flirt bait',
    phishing: 'phishing link',
    channel_promo: 'unsolicited channel promo',
    guest_bot_promo: 'promo through a bot called in by mention',
    flood: 'flood / mass posting',
    prompt_injection: 'attempted moderation hijack',
    other_spam: 'spam',
    known_spam_signature: 'matches confirmed spam',
    semantic_spam_match: 'very similar to known spam',
    velocity_exceeded: 'same message across multiple chats',
    custom_deny: 'blocked by a chat rule',
    scam_flag_new: 'Telegram flagged the account as scam',
    external_ban_new: 'account is in spammer databases',
    shared_profile_photo: 'the same profile photo is on several other accounts',
    external_high_factor_new: 'account is in spammer databases',
    edit_injected_promo: 'message was edited to insert promo',
    edit_injected_invisibles: 'invisible characters inserted by an edit',
    private_invite_new: 'private invite from a new account',
    identity_churn_promo: 'frequent renames + promo content',
    nsfw_promo_profile: 'the profile itself is an advert (explicit media + linked promo)',
    hidden_url_new: 'deceptive link from a newcomer',
    low_information: 'not enough information, observing',
    low_information_profile: 'little text, but a suspicious profile',
    low_information_profile_unreachable: 'suspicious profile, but the check could not be sent — observing',
    reported_unreachable: 'the account was reported and the check could not be sent — paused for an hour',
    profile_farm_unreachable: 'the profile picture is an advert and the check could not be sent — paused for an hour',
    content_unconfirmed: 'suspicious profile, message content unconfirmed',
    admin_report: 'an admin reported this as spam',
    trusted_report: 'a trusted member reported this as spam',
    community_vote: 'the community voted: spam',
    forward_blacklist: 'forwarded from a known spam source',
    record_ban_elsewhere: 'account already banned in another chat over spam databases or a Telegram flag — banned here before its first message',
    content_ban_elsewhere: 'account banned in another chat for spam — banned here before its first message',
    listed_arrival: 'on arrival: account is in spammer databases or flagged by Telegram',
    arrival_look: 'a silent newcomer whose profile looks like a spam network',
    arrived_with_spammer: 'joined alongside a spammer and looks like it — banned by an admin',
    admin_arrival_ban: 'an admin banned this newcomer from the newcomers list'
  },
  reasonFallback: 'suspicious activity',

  why: {
    title: '🛡 Why I acted',
    inChat: (chatTitle) => `in ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Very likely spam · ${percent}%`,
      medium: (percent) => `🟠 Probably spam · ${percent}%`,
      low: (percent) => `🟡 Possibly spam · ${percent}%`
    },
    noticedTitle: 'What I noticed:',
    profileReuseEvidence: (accounts) =>
      `same avatar on ${accounts} other ${accounts === 1 ? 'account' : 'accounts'}`,
    profileMediaEvidence: (score) => `explicit profile photo · score ${score}`,
    externalBanEvidence: (sources, when) => [
      'in spam databases',
      ...(sources > 1 ? [`${sources} sources`] : []),
      ...(when ? [ago(when)] : [])
    ].join(' · '),
    signalLabels: {
      external_ban: 'the account is in spam databases',
      external_repeat_offender: 'listed in spam databases more than once',
      fresh_external_ban: 'recently added to spam databases',
      many_shared_chats: 'in many of our chats at once',
      promo_in_bio: 'a promo link in the bio',
      private_invite_in_bio: 'a private-channel invite in the bio',
      contact_in_bio: 'an off-platform contact in the bio',
      personal_channel: 'a channel linked on the profile',
      promo_in_linked_channel: 'the linked channel is itself an advert',
      promo_in_message_link: 'the link leads to an advert channel',
      restricted_for_spam: 'Telegram restricted them for spam',
      just_joined: 'joined and posted right away',
      joined_during_surge: 'joined during an influx of new members',
      arrived_with_spammer: 'joined alongside a spammer and looks like it',
      scam_flag: 'Telegram flagged the account as a scam',
      fake_flag: 'Telegram flagged the account as fake',
      restricted_flag: 'the account is restricted by Telegram',
      sleeper_awakened: 'a dormant account suddenly active',
      fresh_account: 'the account may be brand new',
      new_globally: 'has no standing in our chats yet',
      new_in_chat: 'has no standing in this chat yet',
      identity_churn_24h: 'frequent name / photo changes',
      avatar_recently_set: 'the avatar was set within the last few days',
      prior_spam_detections: 'caught spamming before',
      unofficial_client_risk: 'posted from an unofficial app',
      forward_hidden_user: 'forwarded from a hidden account',
      forward_source_suspicious: 'forwarded from a suspicious source',
      hidden_url: 'a disguised link',
      external_url: 'an external link',
      url_shortener: 'a shortened link',
      private_invite_link: 'a private invite link',
      bot_deeplink: 'a bot-launch link',
      messenger_contact_link: 'a contact on another messenger',
      many_url_buttons: 'several link buttons',
      phone_number: 'a phone number',
      cashtag: 'a crypto / ticker mention',
      long_text: 'a long post',
      invisible_in_word: 'invisible characters hidden inside words',
      mixed_script_word: 'mixed alphabets inside a word',
      greek_homoglyph_word: 'Greek letters standing in for look-alikes inside a word',
      foreign_script: 'written in a script this chat does not use',
      custom_emoji_heavy: 'many premium emoji',
      paid_media: 'paid media content',
      giveaway_media: 'a giveaway',
      story_share: 'a shared story',
      unknown_media: 'an unrecognized attachment',
      guest_bot_delivery: 'sent through a bot called in by mention',
      edited_message: 'the message was edited',
      edit_injected_invisibles: 'invisible characters inserted by an edit',
      edit_injected_link: 'a link was added by an edit',
      moderation_flagged: '18+ text or photo',
      sole_avatar_replaced: 'a single, recently set profile photo on an old account',
      avatar_shared_with_account: 'same profile photo on one other account',
      avatar_shared_with_accounts: 'same profile photo on several accounts',
      nsfw_avatar: '18+ profile photo',
      suggestive_profile_media: 'suggestive photo or video in the profile',
      nsfw_stories: '18+ story',
      nsfw_linked_channel: '18+ on the linked channel picture',
      promo_in_name: 'promo in the account name',
      invisible_in_name: 'invisible characters in the name',
      signature_candidate_match: 'resembles known spam',
      vector_similar_spam: 'semantically close to spam',
      velocity_repeats: 'same text posted repeatedly',
      velocity_wave: 'same text from several accounts',
      bot_mention: 'mentions a bot',
      sender_burst: 'a run of messages from one account',
      burst_grey_repeat: 'a run with several already-suspicious messages'
    },
    decidedBy: {
      custom_rule: 'chat rule',
      deterministic: 'deterministic rule',
      signature: 'signature database',
      vector: 'semantic search',
      forward: 'forward-source blacklist',
      velocity: 'cross-chat velocity',
      moderation: 'content moderation',
      llm: 'AI analysis',
      llm_cached: 'AI analysis (cached)',
      session: 'message series analysis',
      burst: 'sender run analysis',
      score: 'signal score',
      abstain: 'no decision',
      error: 'error'
    },
    expired: 'This decision has expired — no details left.'
  },

  profile: {
    title: '👤 Profile',
    openButton: '👤 Profile',
    accountAge: (age) => `account ${age}`,
    firstSeen: (seen) => `here ${seen}`,
    activity: (messages, chats) =>
      [
        ...(messages === null ? [] : [`${messages} message${messages === 1 ? '' : 's'}`]),
        `${chats} chat${chats === 1 ? '' : 's'}`
      ].join(' · '),
    reputation: (status) => `reputation: ${status}`,
    premium: 'Premium',
    externalBan: (when, offenses) => [
      'in spam databases',
      ...(when ? [`banned ${ago(when)}`] : []),
      ...(offenses > 1 ? [`${offenses} offences`] : [])
    ].join(' · '),
    justJoined: (span) => (span === NOW ? 'joined the chat just now' : `in the chat only ${span}`),
    promoInBio: 'promo in bio',
    personalChannel: 'linked channel',
    unknownAge: 'of unknown age',
    neverSeen: 'first time',
    units: { now: NOW, m: 'm', h: 'h', d: 'd', mo: 'mo', y: 'y' },
    checkNeedReply: 'Reply to a user’s message with /check.',
    notFound: 'Could not fetch the profile.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Is this spam?</b> Message from ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Is this spam?</b> Message from ${userLabel} — no text, just a ${what}.`
        : `🤔 <b>Is this spam?</b> Message from ${userLabel} — no text.`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'photo', sticker: 'sticker', video: 'video',
      voice: 'voice message', file: 'file', other: 'attachment'
    },
    redacted: { link: '[link]', mention: '[@mention]', invite: '[invite]' },
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `👌 Fine (${count})`,
    counted: 'Vote counted.',
    enforcement: {
      done: 'Deleted, author restricted.',
      deletedOnly: 'Deleted, but the author could not be restricted.',
      mutedOnly: 'Author restricted, but the message could not be deleted.',
      failed: '⚠️ Could neither delete the message nor restrict the author.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      (who ? `🗑 The community says the message from ${who} is spam.` : '🗑 The community says spam.')
      + (enforcement ? ` ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      (who ? `👌 The community says the message from ${who} is fine.` : '👌 The community says it is fine.')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'This vote is already closed.',
    voters: {
      button: '👥 Who voted',
      title: (spam, ham) => `👥 <b>Vote</b> · spam ${spam} : ${ham} fine`,
      spamGroup: '🗑 Spam',
      hamGroup: '👌 Fine',
      adminMark: 'admin',
      changedMark: 'changed their vote',
      span: (span) => `⏱ first to last ballot: ${span}`,
      more: (count) => `…and ${count} more`,
      nobody: 'Nobody voted in time.',
      notForTarget: 'This vote is about you.',
      noStanding: 'Voting is for members who have settled in.',
      knownBad: 'Your ballot does not count here.'
    }
  },

  report: {
    needReply: 'Use /report as a reply to a message, or name the person: /report @username, /report 123456789, or pick them from the list with @.',
    notFound: (who) => `I have not seen ${who} in this chat. Reply to one of their messages or pick them from the list with @.`,
    notInChat: 'That person is no longer in the chat.',
    cantReportAdmin: 'Admins cannot be reported.',
    rateLimited: 'Too many reports. Wait a few minutes.',
    accepted: 'Got it, thanks.',
    oneAtATime: 'Several people joined on that line. Reply to a message from the one you mean.'
  },

  botStats: {
    title: '🛡 <b>What I have done so far</b>',
    window: (days) => (days === 1 ? 'Over the last day:' : `Over the last ${days} days:`),
    checked: (count) => `📬 <b>${n(count)}</b> message${s(count)} checked`,
    spammers: (count) => `🚫 <b>${n(count)}</b> spammer${s(count)} blocked`,
    chats: (count) => `💬 <b>${n(count)}</b> chat${s(count)} under guard`,
    speed: (ms) => `⚡ a verdict in <b>${n(ms)} ms</b>`,
    quiet: (percent) => `<b>${decimal1(percent, '.')}%</b> of messages I never touched. No spam, no noise from me.`,
    reasonsTitle: '<b>What I catch most:</b>',
    reasonLine: (name, count) => `• ${name} — ${n(count)}`,
    memory: (signatures) => `🧠 ${n(signatures)} spam signature${s(signatures)} in memory`,
    corrections: (percent) => `✅ Admins overturned ${decimal1(percent, '.')}% of my calls`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> over ${days} day${s(days)}`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${n(checked)} checked · 🚫 ${n(spammers)} spammer${s(spammers)} · 🧹 ${n(deletes)} removed`,
    chatLastSpam: (span) => `Last spam: ${ago(span)}`,
    chatClean: '✨ Not a single spam message in that time.',
    unavailable: '📊 The numbers are out of reach right now, try again a bit later.',
    button: '📊 My numbers'
  },

  stats: {
    title: '📊 <b>Your stats</b>',
    inChat: (count, chatTitle) => chatTitle ? `Messages in ${chatTitle}: ${count}` : `Messages in this chat: ${count}`,
    global: (count) => `Messages everywhere: ${count}`,
    reputation: (score, status) => `Reputation: ${score} (${status})`,
    repStatus: { trusted: 'trusted', neutral: 'neutral', suspicious: 'suspicious', restricted: 'restricted' },
    bananCaught: (count) => `Bananas caught: ${count} 🍌`,
    openInPm: 'Stats are on the way to your PM.',
    openButton: '📊 My stats'
  },

  top: {
    titleMessages: '🏆 <b>Most active in chat</b>',
    titleBanan: '🍌 <b>Banana leaderboard</b>',
    empty: 'No stats yet.',
    messagesUnit: (count) => (count === 1 ? 'message' : 'messages'),
    bananUnit: () => '🍌'
  },

  kick: {
    success: (name) => `👋 ${name} was kicked from the chat.`,
    needReply: 'Reply to the message of whoever you want to kick with /kick.'
  },

  untrust: {
    success: (name) => `🔓 Trust revoked for ${name}. Their messages go through the checks again.`,
    needReply: 'Reply to the message of whoever you want to untrust with /untrust.',
    notTrusted: (name) => `${name} was not in the trusted list anyway.`
  },

  trust: {
    button: '✅ Trust',
    untrustButton: '🔓 Untrust',
    added: 'Added to this chat’s trusted users.',
    removed: 'Trust revoked.',
    grantedBy: (who, span, via) =>
      `✅ Trusted by ${who}, ${ago(span)}` +
      (via === 'override' ? ' · reversed a bot decision' : via === 'vote' ? ' · by admin ballot' : ''),
    grantUnknown: '✅ Trusted · who granted it and when was not recorded'
  },

  welcome: {
    enabled: '👋 Greetings on.',
    disabled: '👋 Greetings off.',
    textSet: '✅ Greeting text saved. %name% is substituted.',
    gifSet: '✅ Greeting gif saved.',
    usage: [
      '/welcome — toggle on/off',
      '/welcome <text with %name%> — set the greeting',
      'reply to a gif with /welcome — set the gif'
    ].join('\n'),
    limit: '⚠️ Limit reached — remove something in settings first.',
    duplicate: 'ℹ️ Already added.',
    tooLong: '⚠️ Text too long (max 1000 characters).',
    saveFailed: '⚠️ Could not save.',
    surgeAlert: (count, riskCount) => `⚠️ Surge of newcomers: ${count} member${s(count)}, ${riskCount} of them suspicious`,
    defaultGreeting: (name) => `👋 Welcome, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Newcomer greeting</b>\n\nStatus: ${state}\nTexts: ${nTexts} · Gifs: ${nGifs}\n\nWith several, the bot picks a random one each time.`,
      enable: '🔔 Enable',
      disable: '🔕 Disable',
      texts: (n) => `📝 Texts (${n})`,
      gifs: (n) => `🎞 Gifs (${n})`,
      preview: '👁 Preview',
      textsTitle: (n, max) => `📝 <b>Greeting texts</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Greeting texts</b>\n\nEmpty for now. Add the first — you can use <code>%name%</code> for the newcomer’s name.',
      addText: '➕ Add text',
      gifsTitle: (n, max) => `🎞 <b>Greeting gifs</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 gif #${i}`,
      gifsEmpty: '🎞 <b>Greeting gifs</b>\n\nEmpty for now. Add the first — send a gif, video or photo.',
      addGif: '➕ Add gif',
      promptText: '📝 Send the greeting text in one message.\nYou can include <code>%name%</code> — I’ll substitute the newcomer’s name.\n\n/cancel to abort.',
      promptGif: '🎞 Send a gif, video or photo in one message.\n\n/cancel to abort.',
      added: '✅ Added.',
      cancelled: '❌ Cancelled.',
      invalidGif: '⚠️ That’s not media. Send a gif, video or photo.',
      removed: '🗑 Removed.',
      removeMissing: 'That one is already gone — refreshed the list.',
      expired: '⌛ That took too long. Open the editor again.',
      previewEmpty: 'Nothing to show yet — add a text or a gif.'
    }
  },

  extra: {
    saved: (name) => `✅ Saved #${name}`,
    deleted: (name) => `🗑 Deleted #${name}`,
    notFound: (name) => `No such trigger: #${name}`,
    usage: [
      '/extra name (replying to a message) — saves it under #name',
      '/extra name (no reply) — deletes the trigger'
    ].join('\n'),
    listTitle: '📂 Saved triggers:',
    listEmpty: 'No triggers here yet.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Triggers</b> (${n})\n\nType <code>#name</code> in the chat and the bot sends the saved reply.\nMax fires per message: ${max}.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Triggers</b>\n\nEmpty for now. Add the first — a name plus text or media.',
      add: '➕ Add trigger',
      maxLabel: (n) => `Max: ${n}`,
      promptName: '#️⃣ Send the trigger name (without #), one word.\n\n/cancel to abort.',
      promptContent: (name) => `Now send the content for <code>#${name}</code> — text or media (gif/photo/video).\n\n/cancel to abort.`,
      added: (name) => `✅ Trigger #${name} saved.`,
      cancelled: '❌ Cancelled.',
      invalidName: '⚠️ The name must be one word, no spaces (letters/digits/_).',
      removed: '🗑 Removed.'
    }
  },

  banan: {
    success: (name, duration) => `🍌 ${name} gets the banana for ${duration}`,
    lifted: (name) => `🍌 ${name} loses the banana`,
    self: (name, duration) => `🍌 ${name} banana'd themselves for ${duration}. Respect`,
    needReply: 'Use /banan as a reply, or plain /banan to banana yourself.',
    undoButton: '↩️ Undo',
    units: { m: 'min', h: 'h', d: 'd' },
    show: (name) => `🍌 ${name} holds up the banana`
  },

  captcha: {
    prompt: (name) => `👋 ${name}, tap the button to keep chatting. Quick check that you are not a bot.`,
    button: '🙋 I am human',
    passed: 'Done, go ahead.',
    retry: 'Could not lift the restriction. Tap again.',
    notForYou: 'This button is not for you.'
  },

  settings: {
    openInPm: 'Settings are available in private messages.',
    openInPmButton: '⚙️ Open settings',
    title: '⚙️ <b>Anti-spam settings</b>',
    preset: 'Mode',
    presets: { soft: 'Soft', standard: 'Standard', strict: 'Strict' },
    captcha: 'Captcha for newcomers',
    voting: 'Community voting',
    enabled: 'Anti-spam',
    banDatabase: 'Spammer databases',
    quiet: 'Quiet mode',
    quietHint: '🤫 Notices about confident actions disappear after 5 s. Everything the bot did is under “🧾 Recent actions”. Votes are unaffected.',
    banan: 'Banan duration',
    language: 'Bot language in this chat',
    languageSaved: 'Chat language updated',
    welcome: '👋 Greeting',
    extras: '#️⃣ Triggers',
    on: 'On',
    off: 'Off',
    back: '‹ Back'
  }
}
