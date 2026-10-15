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

/** First-seen placeholder: the profile line reads it as a phrase, not a span. */
const NEVER_SEEN = 'first time'

/** "a photo", "an attachment": the media nouns are inserted after an article. */
const withArticle = (noun: string): string => `${/^[aeiou]/i.test(noun) ? 'an' : 'a'} ${noun}`

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
    groupHint: '🛡 I catch spam and ban scammers.\n<code>/settings</code> for admins · <code>/stats</code> numbers · <code>/help</code> commands',
    addToGroupButton: '➕ Add to group',
    helpButton: '❓ Commands',
    langButton: '🌐 Language'
  },
  arrivals: {
    button: '👥 Newcomers',
    title: '👥 <b>Who joined the chat this week</b>',
    empty: 'The bot has not noticed any new members in this chat this week.',
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
    footer: '⚠️ — joined alongside a spammer, with a similar profile. "🚫 N" bans member number N.',
    banButton: (index) => `🚫 ${index}`,
    banAllButton: (count) => `🚫 Ban everyone still silent (${count})`,
    confirmAll: (count) => `Ban <b>${count}</b> ${count === 1 ? 'newcomer who has' : 'newcomers who have'} not written anything yet?`,
    confirmYes: '🚫 Yes, ban',
    cancel: 'Cancel',
    banned: (count) => `Banned: ${count}`
  },
  cohort: {
    title: (count, spammer) => `👥 <b>${count} similar ${count === 1 ? 'newcomer' : 'newcomers'} joined alongside the spammer ${spammer}</b>`,
    hint: 'Similar profile, joined around the same time, no messages yet. The bot has not restricted anyone — an admin decides.',
    banButton: (count) => `🚫 Ban ${count}`,
    keepButton: 'Let them stay',
    banned: (done, total, admin) => `🚫 Banned ${done} of ${total} newcomer${s(total)} who joined alongside the spammer · ${admin}`,
    kept: (admin) => `✅ The newcomers stay in the chat · ${admin}`,
    expired: 'This card is out of date.'
  },

  chatActions: {
    button: '🧾 Recent actions',
    title: '🧾 <b>What the bot did in this chat</b>',
    empty: 'Empty for now: the bot has not done anything in this chat yet.',
    footer: '“Why?” opens the evidence, and “Not spam” if the bot got it wrong.'
  },

  ownRestrictions: {
    title: '🧾 <b>My decisions about you</b>',
    ago,
    endsIn: (span) => `ends in ${span}`,
    ended: 'already over',
    permanent: 'no end date',
    overturned: '↩️ reversed',
    unknownChat: 'untitled chat',
    footer: [
      'These were automatic decisions by the bot, not by the admins.',
      'If I got it wrong, write to an admin of that chat: an admin can undo it with one tap.',
      'Time-limited restrictions end on their own.'
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
    '/settings — settings panel (opens in a private chat, everything there is buttons)',
    '/banan /kick /del — moderation as a reply',
    '/check — user card with a trust button · /untrust — revoke trust',
    '/welcome — newcomer greeting · /extra, /extras — triggers',
    '',
    'Every notice carries a <b>why?</b> link with the full decision card. Admins also get the <b>“✅ Not spam”</b> button: it undoes the decision and adds the person to this chat’s trusted list.'
  ].join('\n'),

  writeFailed: '⚠️ Not saved — try again.',
  hiddenName: (userId) => `user ${userId}`,
  panelForChat: (chatTitle) => `⚙️ Group: <b>${chatTitle}</b>`,

  lang: {
    pickerTitle: 'Pick a language:',
    saved: 'Done, English it is',
    openInPm: 'Pick your own language in a private chat with the bot — tap the button.',
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
    banan: 'Mute a member (reply, /banan 5m)',
    kick: 'Kick a member (reply)',
    del: 'Delete a message (reply)',
    untrust: 'Revoke trust (reply)',
    check: 'Look up a profile (reply)',
    top: 'Most active members',
    topBanan: 'Banana leaderboard',
    extras: 'Saved triggers',
    welcome: 'Newcomer greeting',
    ping: 'Check whether the bot is alive'
  },

  actions: {
    captcha: '👋 checking',
    delete: '🧹 message removed',
    kick: '🚪 kicked from the chat',
    mute: '🔇 muted',
    ban: '🔨 banned'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyLink: 'why?',
    whyButton: 'ℹ️ Why?',
    notSpamButton: '✅ Not spam',
    overrideDone: 'Undone: the restriction is lifted and the account is now trusted in this chat.',
    overridePartial: '⚠️ Only partly undone: could not lift the restriction or add to the trusted list. Check my rights and tap again.',
    overrideAlreadyDone: 'Already reverted.',
    adminOnly: 'Only admins of this chat can do this.',
    missingRights: ({ deleteBlocked, senderBlocked, accounts }) => {
      const left = accounts > 0
        ? ` Over the last day I could not remove ${accounts} account${accounts === 1 ? '' : 's'}.`
        : ''
      if (senderBlocked && !deleteBlocked) {
        return `⚠️ I delete the spam, but I cannot ban the spammers — I am missing the "Ban users" right.${left}`
      }
      if (deleteBlocked && !senderBlocked) {
        return '⚠️ I can ban the spammers, but I cannot delete their messages — I am missing the "Delete messages" right.'
      }
      return `⚠️ I found spam, but I cannot do anything about it — I am missing the "Delete messages" and "Ban users" rights.${left}`
    }
  },

  reasons: {
    job_scam: 'looks like a job scam',
    crypto_scam: 'crypto scam',
    gambling_promo: 'casino or betting promo',
    adult_promo: '18+ promo',
    ad_network: 'selling ads and ad placements',
    flirt_bait: 'flirt bait',
    phishing: 'phishing link',
    channel_promo: 'unsolicited channel promo',
    guest_bot_promo: 'promo through a bot called in by mention',
    flood: 'flood or mass posting',
    prompt_injection: 'an attempt to get past the anti-spam check',
    other_spam: 'spam',
    known_spam_signature: 'matches confirmed spam',
    semantic_spam_match: 'very similar to known spam',
    velocity_exceeded: 'the same message posted in several chats in a row',
    custom_deny: 'blocked by a chat rule',
    scam_flag_new: 'Telegram flagged the account as a scam',
    external_ban_new: 'account is in spam databases',
    shared_profile_photo: 'the same profile photo is on several other accounts',
    external_high_factor_new: 'account is in spam databases',
    edit_injected_promo: 'promo added while editing',
    edit_injected_invisibles: 'invisible characters added while editing',
    private_invite_new: 'invite to a private chat from a new account',
    identity_churn_promo: 'frequent renames and promo',
    nsfw_promo_profile: 'the profile works as an advert: explicit photos or videos and a channel on the profile',
    hidden_url_new: 'deceptive link from a newcomer',
    low_information: 'not enough information — only watching for now',
    low_information_profile: 'little text, but a suspicious profile',
    low_information_profile_unreachable: 'suspicious profile, but the check could not be sent — only watching for now',
    reported_unreachable: 'the account was reported and the check could not be sent — restricted for an hour',
    profile_farm_unreachable: 'the profile photo itself is an advert and the check could not be sent — restricted for an hour',
    content_unconfirmed: 'suspicious profile, but the text itself was not confirmed as spam',
    admin_report: 'an admin reported this as spam',
    trusted_report: 'a trusted member reported this as spam',
    community_vote: 'the community voted: spam',
    forward_blacklist: 'forwarded from a known spam source',
    record_ban_elsewhere: 'the account was already banned in another chat because it is in spam databases or flagged by Telegram — banned here before its first message',
    content_ban_elsewhere: 'the account was banned in another chat for spam — banned here before its first message',
    listed_arrival: 'on joining: the account is in spam databases or flagged by Telegram',
    arrival_look: 'a silent newcomer whose profile looks like a spam network',
    arrived_with_spammer: 'joined alongside a spammer, with a similar profile — banned by an admin',
    admin_arrival_ban: 'banned by an admin from the newcomers list'
  },
  reasonFallback: 'suspicious activity',

  why: {
    title: '🛡 The bot is only watching',
    inChat: (chatTitle) => `in ${chatTitle}`,
    confidence: {
      high: (percent) => `🔴 Very likely spam · bot’s estimate ${percent}%`,
      medium: (percent) => `🟠 Probably spam · bot’s estimate ${percent}%`,
      low: (percent) => `🟡 Possibly spam · bot’s estimate ${percent}%`
    },
    noticedTitle: 'What I noticed:',
    profileReuseEvidence: (accounts) =>
      `same profile photo on ${accounts} other ${accounts === 1 ? 'account' : 'accounts'}`,
    // The pipeline writes the model's 0..1 score; the card shows percents.
    profileMediaEvidence: (score) => `explicit profile photo · score ${Math.round(Number(score) * 100)}%`,
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
      promo_in_linked_channel: 'the linked channel carries ads',
      promo_in_message_link: 'the link leads to an advert channel',
      restricted_for_spam: 'Telegram restricted them for spam',
      just_joined: 'joined and posted right away',
      joined_during_surge: 'joined during an influx of new members',
      arrived_with_spammer: 'joined alongside a spammer, with a similar profile',
      scam_flag: 'Telegram flagged the account as a scam',
      fake_flag: 'Telegram flagged the account as fake',
      restricted_flag: 'the account is restricted by Telegram',
      sleeper_awakened: 'a long-inactive account suddenly started posting',
      fresh_account: 'possibly a brand-new account',
      new_globally: 'new to our chats',
      new_in_chat: 'new to this chat',
      identity_churn_24h: 'frequent name or profile photo changes',
      avatar_recently_set: 'the profile photo was set within the last few days',
      prior_spam_detections: 'this account has sent spam before',
      unofficial_client_risk: 'posted from an unofficial app',
      forward_hidden_user: 'forwarded from an author who hides their profile',
      forward_source_suspicious: 'forwarded from a suspicious source',
      hidden_url: 'a disguised link',
      external_url: 'an external link',
      url_shortener: 'a shortened link',
      private_invite_link: 'an invite to a private chat',
      bot_deeplink: 'a link that starts a bot',
      messenger_contact_link: 'a contact on another messenger',
      many_url_buttons: 'several buttons with links',
      phone_number: 'a phone number',
      cashtag: 'a coin or stock mentioned with $',
      long_text: 'a long post',
      invisible_in_word: 'invisible characters hidden inside words',
      mixed_script_word: 'letters from different alphabets in one word',
      greek_homoglyph_word: 'Greek look-alike letters inside a word',
      foreign_script: 'written in a script this chat does not use',
      custom_emoji_heavy: 'many premium emoji',
      paid_media: 'paid media content',
      giveaway_media: 'a giveaway',
      story_share: 'a forwarded story',
      unknown_media: 'an unrecognized attachment',
      guest_bot_delivery: 'sent through a bot called in by mention',
      edited_message: 'the message was edited',
      edit_injected_invisibles: 'invisible characters added while editing',
      edit_injected_link: 'a link added while editing',
      moderation_flagged: '18+ text or photo',
      sole_avatar_replaced: 'an old account whose only profile photo was set recently',
      avatar_shared_with_account: 'same profile photo on one other account',
      avatar_shared_with_accounts: 'same profile photo on several accounts',
      nsfw_avatar: '18+ profile photo',
      suggestive_profile_media: 'suggestive photo or video in the profile',
      nsfw_stories: '18+ in stories',
      nsfw_linked_channel: '18+ in the linked channel’s photo',
      promo_in_name: 'promo in the account name',
      invisible_in_name: 'invisible characters in the name',
      signature_candidate_match: 'resembles known spam',
      vector_similar_spam: 'similar in meaning to known spam',
      velocity_repeats: 'same text posted repeatedly',
      velocity_wave: 'same text from several accounts',
      bot_mention: 'mentions a bot',
      sender_burst: 'a burst of messages from one account',
      burst_grey_repeat: 'several messages in the burst already looked suspicious'
    },
    decidedBy: {
      custom_rule: 'chat rule',
      deterministic: 'hard rule',
      signature: 'signature database',
      vector: 'semantic search',
      forward: 'forward-source blacklist',
      velocity: 'posting across several chats',
      moderation: 'content moderation',
      llm: 'AI analysis',
      llm_cached: 'AI analysis (cached)',
      session: 'message series analysis',
      burst: 'one-account burst analysis',
      score: 'signal score',
      abstain: 'no decision',
      error: 'error',
      join_screen: 'check on joining',
      captcha_ignored: 'check ignored'
    },
    expired: 'The details of this decision are no longer kept.',
    appeal: 'If this is a mistake, message an admin of this chat — an admin can undo the decision.'
  },

  profile: {
    title: '👤 Profile',
    openButton: '👤 Profile',
    accountAge: (age) => `account ${age}`,
    // A span under a minute is a first sighting too: "known to the bot for now" is not English.
    firstSeen: (seen) => (seen === NEVER_SEEN || seen === NOW ? 'new to the bot' : `known to the bot for ${seen}`),
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
    neverSeen: NEVER_SEEN,
    units: { now: NOW, m: 'm', h: 'h', d: 'd', mo: 'mo', y: 'y' },
    checkNeedReply: 'Reply to a user’s message with /check.',
    notFound: 'Could not load the profile.'
  },

  vote: {
    prompt: ({ userLabel, textPreview, media, whyLink }) =>
      `🤔 <b>Is this spam?</b> Posted by ${userLabel}`
      + (media ? ` · 📎 ${media}` : '')
      + (whyLink ? ` · ${whyLink}` : '')
      + `\n${textPreview}`,
    promptNoText: (userLabel, what, whyLink) =>
      (what
        ? `🤔 <b>Is this spam?</b> Posted by ${userLabel} · no text, just ${withArticle(what)}`
        : `🤔 <b>Is this spam?</b> Posted by ${userLabel} · no text`)
      + (whyLink ? ` · ${whyLink}` : ''),
    media: {
      photo: 'photo', sticker: 'sticker', video: 'video',
      voice: 'voice or audio message', file: 'file', other: 'attachment'
    },
    redacted: { link: '[link]', mention: '[@mention]', invite: '[invite]' },
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `✅ Not spam (${count})`,
    counted: 'Vote counted.',
    enforcement: {
      done: 'Message deleted, author restricted.',
      deletedOnly: 'Message deleted, but the author could not be restricted.',
      mutedOnly: 'Author restricted, but the message could not be deleted.',
      failed: '⚠️ Could neither delete the message nor restrict the author.'
    },
    resolvedSpam: ({ who, enforcement, whyLink }) =>
      '🗑 The community decided: spam' + (who ? ` · ${who}` : '')
      + (enforcement ? `. ${enforcement}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    resolvedHam: ({ who, whyLink }) =>
      '✅ The community decided: not spam' + (who ? ` · ${who}` : '')
      + (whyLink ? ` · ${whyLink}` : ''),
    alreadyEnded: 'This vote is already closed.',
    voters: {
      button: '👥 Who voted',
      title: (spam, ham) => `👥 <b>Vote</b> · spam ${spam} : ${ham} not spam`,
      spamGroup: '🗑 Spam',
      hamGroup: '✅ Not spam',
      adminMark: 'admin',
      changedMark: 'changed their vote',
      span: (span) => (span === NOW ? '⏱ all votes came within a minute' : `⏱ first to last vote: ${span}`),
      more: (count) => `…and ${count} more`,
      nobody: 'Nobody voted in time.',
      notForTarget: 'This vote is about you: you cannot vote in it or see who voted.',
      noStanding: 'Vote not counted: voting is for members who have been in the chat for at least a week and posted 10+ messages here (or 50+ across the bot’s chats), or who have been here over a year.',
      knownBad: 'Vote not counted: this account has sent spam before.'
    }
  },

  report: {
    needReply: 'Use /report as a reply to a message, or name the person: /report @username or /report 123456789. You can also type @ and pick them from the list.',
    notFound: (who) => `Not found in this chat: ${who}. Reply to one of their messages, or type @ and pick them from the list.`,
    notInChat: 'That person is no longer in the chat.',
    cantReportAdmin: 'Admins cannot be reported.',
    rateLimited: 'Too many reports. Wait a few minutes.',
    accepted: 'Report received, thanks.',
    oneAtATime: 'That is the join message for several people. Reply to a message from the person you are reporting.',
    voteClosed: 'The vote on this message is already closed. An admin can still decide.',
    channelSender: 'This was posted as a channel. Only an admin can block a channel.'
  },

  botStats: {
    title: '🛡 <b>What I have done so far</b>',
    window: (days) => (days === 1 ? 'Over the last day:' : `Over the last ${days} days:`),
    checked: (count) => `📬 <b>${n(count)}</b> message${s(count)} checked`,
    spammers: (count) => `🚫 <b>${n(count)}</b> spammer${s(count)} blocked`,
    chats: (count) => `💬 <b>${n(count)}</b> chat${s(count)} protected`,
    speed: (ms) => `⚡ a decision in <b>${n(ms)} ms</b>`,
    quiet: (percent) => `<b>${decimal1(percent, '.')}%</b> of messages I left alone. No spam, no noise from me.`,
    reasonsTitle: '<b>What I catch most:</b>',
    reasonLine: (name, count) => `• ${name} — ${n(count)}`,
    memory: (signatures) => `🧠 ${n(signatures)} spam signature${s(signatures)} in memory`,
    corrections: (percent) => `✅ Admins overturned ${decimal1(percent, '.')}% of my decisions`,
    chatHeader: (title, days) => `🛡 <b>${title}</b> over ${days} day${s(days)}`,
    chatLine: (checked, spammers, deletes) =>
      `📬 ${n(checked)} checked · 🚫 ${n(spammers)} spammer${s(spammers)} · 🧹 ${n(deletes)} removed`,
    chatLastSpam: (span) => `Last spam: ${ago(span)}`,
    chatClean: '✨ The bot found no spam in that time.',
    unavailable: '📊 I cannot show the numbers right now. Try again a bit later.',
    button: '📊 Bot stats'
  },

  stats: {
    title: '📊 <b>Your stats</b>',
    inChat: (count, chatTitle) => chatTitle ? `Messages in ${chatTitle}: ${n(count)}` : `Messages in this chat: ${n(count)}`,
    global: (count) => `Messages everywhere: ${n(count)}`,
    reputation: (score, status) => `Reputation: ${score} (${status})`,
    repStatus: { trusted: 'reliable', neutral: 'neutral', suspicious: 'suspicious', restricted: 'restricted' },
    bananCaught: (count) => `Bananas caught: ${n(count)} 🍌`,
    openInPm: 'Your stats are in a private chat with the bot — tap the button.',
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
    needReply: 'Reply with /kick to a message from the person you want to remove.'
  },

  untrust: {
    success: (name) => `🔓 Trust revoked for ${name}. Their messages go through the checks again.`,
    needReply: 'Reply with /untrust to a message from the person whose trust you want to revoke.',
    notTrusted: (name) => `ℹ️ ${name} is not on the trusted list — nothing to revoke.`
  },

  trust: {
    button: '✅ Trust',
    untrustButton: '🔓 Untrust',
    added: 'Added to this chat’s trusted list.',
    removed: 'Trust revoked.',
    grantedBy: (who, span, via) =>
      `✅ Trusted by ${who}, ${ago(span)}` +
      (via === 'override' ? ' · reversed a bot decision' : via === 'vote' ? ' · by an admin’s vote' : ''),
    grantUnknown: '✅ Trusted · who granted it and when was not recorded'
  },

  welcome: {
    enabled: '👋 Newcomer greeting on.',
    disabled: '👋 Newcomer greeting off.',
    textSet: '✅ Greeting text saved. %name% is replaced with the newcomer’s name.',
    gifSet: '✅ Greeting media saved.',
    usage: [
      '/welcome — toggle on/off',
      '/welcome <text with %name%> — set the greeting',
      'reply to a GIF with /welcome — set the GIF'
    ].join('\n'),
    limit: '⚠️ Cannot add more: the limit is reached. Remove something in settings first.',
    duplicate: 'ℹ️ Already added.',
    tooLong: '⚠️ Text too long (max 1000 characters).',
    saveFailed: '⚠️ Could not save.',
    surgeAlert: (count, riskCount) => `⚠️ Surge of newcomers: ${count} member${s(count)}, ${riskCount} of them with a suspicious profile`,
    defaultGreeting: (name) => `👋 Welcome, ${name}!`,
    editor: {
      title: (state, nTexts, nGifs) =>
        `👋 <b>Newcomer greeting</b>\n\nStatus: ${state}\nTexts: ${nTexts} · GIFs: ${nGifs}\n\nIf there are several, the bot picks one at random each time.`,
      enable: '🔔 Enable',
      disable: '🔕 Disable',
      texts: (n) => `📝 Texts (${n})`,
      gifs: (n) => `🎞 Media (${n})`,
      preview: '👁 Preview',
      textsTitle: (n, max) => `📝 <b>Greeting texts</b> (${n}/${max})`,
      textsItem: (i, preview) => `${i}. ${preview}`,
      textsEmpty: '📝 <b>Greeting texts</b>\n\nEmpty for now. Add the first — you can use <code>%name%</code> for the newcomer’s name.',
      addText: '➕ Add text',
      gifsTitle: (n, max) => `🎞 <b>Greeting media</b> (${n}/${max})`,
      gifsItem: (i) => `${i}. 🎞 media #${i}`,
      gifsEmpty: '🎞 <b>Greeting media</b>\n\nEmpty for now. Send a GIF, video or photo.',
      addGif: '➕ Add media',
      promptText: '📝 Send the greeting text in one message.\nYou can include <code>%name%</code> — I’ll substitute the newcomer’s name.\n\n/cancel to abort.',
      promptGif: '🎞 Send a GIF, video or photo in one message.\n\n/cancel to abort.',
      added: '✅ Added.',
      cancelled: '↩️ Cancelled.',
      invalidGif: '⚠️ That is not a GIF, video or photo. Send one of those.',
      removed: '🗑 Removed.',
      removeMissing: 'That one is already gone — refreshed the list.',
      expired: '⌛ That took too long. Open the editor again.',
      previewEmpty: 'Nothing to show yet — add a text, GIF, video or photo.'
    }
  },

  extra: {
    saved: (name) => `✅ Saved #${name}`,
    deleted: (name) => `🗑 Deleted #${name}`,
    notFound: (name) => `No such trigger: #${name}`,
    usage: [
      '/extra name (replying to a message) — saves that message under #name',
      '/extra name (no reply) — deletes the trigger'
    ].join('\n'),
    listTitle: '📂 Saved triggers:',
    listEmpty: 'No triggers here yet.',
    editor: {
      title: (n, max) =>
        `#️⃣ <b>Triggers</b> (${n})\n\nType <code>#name</code> in the chat and the bot sends the saved reply.\nLimit: up to ${max} replies per message.`,
      item: (i, icon, name) => `${i}. ${icon} #${name}`,
      empty: '#️⃣ <b>Triggers</b>\n\nEmpty for now. Add the first — a name plus text or media.',
      add: '➕ Add trigger',
      maxLabel: (n) => `Limit: ${n}`,
      promptName: '#️⃣ Send the trigger name (without #), one word.\n\n/cancel to abort.',
      promptContent: (name) => `Now send what the bot should reply to <code>#${name}</code> with: text, a GIF, photo or video.\n\n/cancel to abort.`,
      added: (name) => `✅ Trigger #${name} saved.`,
      cancelled: '↩️ Cancelled.',
      invalidName: '⚠️ The name is one word: letters, digits or _, no spaces.',
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
    prompt: (name, minutes) =>
      `👋 ${name}, tap the button${minutes === undefined ? '' : ` within ${minutes} min`} to keep chatting. Quick check that you are not a bot.`,
    button: '🙋 I am human',
    passed: 'Done, go ahead.',
    retry: 'Could not lift the restriction. Tap again.',
    notForYou: 'This button is for another member.'
  },

  settings: {
    openInPm: 'Settings are in a private chat with the bot — tap the button.',
    openInPmButton: '⚙️ Open settings',
    title: '⚙️ <b>Anti-spam settings</b>',
    preset: 'Mode',
    presets: { soft: 'Soft', standard: 'Standard', strict: 'Strict' },
    captcha: 'Captcha for newcomers',
    voting: 'Community voting',
    enabled: 'Anti-spam',
    banDatabase: 'Spam databases',
    quiet: 'Quiet mode',
    quietHint: '🤫 Notices about confident actions arrive silently, without buttons, and disappear after 5 s. Everything the bot did is under “🧾 Recent actions”. Votes and uncertain decisions show as usual.',
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
