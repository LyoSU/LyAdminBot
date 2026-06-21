import type { Locale } from '../locale.js'

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
    groupHint: '🛡 I catch spam and ban scammers.\n<code>/settings</code> for admins · <code>/help</code> commands',
    addToGroupButton: '➕ Add to group',
    helpButton: '❓ Commands',
    langButton: '🌐 Language'
  },

  helpText: [
    '🛡 <b>What I do</b>',
    'I catch spam and ban scammers on my own. Most actions are buttons, not commands.',
    '',
    '<b>Everyone:</b>',
    '/report — report spam (as a reply)',
    '/mystats — my stats · /top, /top_banan — leaderboards',
    '/lang — language',
    '',
    '<b>Admins:</b>',
    '/settings — settings panel (opens in PM, all buttons there)',
    '/banan /kick /del — moderation as a reply',
    '/check — user card with buttons (trust, etc.)',
    '/welcome — newcomer greetings · /extra, /extras — triggers',
    '',
    'Under every decision: <b>[🤨 Why?]</b> and <b>[✅ Not spam]</b> for admins.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Pick a language:',
    saved: 'Done, English it is'
  },

  commands: {
    start: 'Start using the bot',
    help: 'Help and commands',
    lang: 'Choose language',
    mystats: 'My stats',
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
    mute: '🔇 muted',
    ban: '🔨 banned'
  },

  notification: {
    compact: (action, userLabel) => `${action} · ${userLabel}`,
    whyButton: '🤨 Why?',
    notSpamButton: '✅ Not spam',
    overrideDone: 'Done, reverted. User is back and trusted in this chat now.',
    overrideAlreadyDone: 'Already reverted.',
    adminOnly: 'Chat admins only.',
    missingRights: '⚠️ Caught spam but I lack the rights to remove it. Please grant me delete-messages and ban-users rights.'
  },

  reasons: {
    job_scam: 'looks like a job scam',
    crypto_scam: 'crypto scam',
    gambling_promo: 'casino/betting promo',
    adult_promo: 'adult promo',
    ad_network: 'ad placement offer',
    flirt_bait: 'flirt bait',
    phishing: 'phishing link',
    channel_promo: 'unsolicited channel promo',
    guest_bot_promo: 'guest-bot promo delivery',
    flood: 'flood / mass posting',
    prompt_injection: 'attempted moderation hijack',
    other_spam: 'spam',
    known_spam_signature: 'matches confirmed spam',
    semantic_spam_match: 'very similar to known spam',
    velocity_exceeded: 'same message across multiple chats',
    custom_deny: 'blocked by a chat rule',
    scam_flag_new: 'Telegram flagged the account as scam',
    external_ban_new: 'account is in spammer databases',
    external_high_factor_new: 'account is in spammer databases',
    edit_injected_promo: 'message was edited to insert promo',
    private_invite_new: 'private invite from a new account',
    identity_churn_promo: 'frequent renames + promo content',
    hidden_url_new: 'deceptive link from a newcomer',
    low_information: 'not enough information, observing',
    admin_report: 'an admin reported this as spam',
    community_vote: 'the community voted: spam',
    forward_blacklist: 'forwarded from a known spam source'
  },
  reasonFallback: 'suspicious activity',

  why: {
    title: '🛡 Why I acted',
    confidence: {
      high: (percent) => `🔴 Very likely spam · ${percent}%`,
      medium: (percent) => `🟠 Probably spam · ${percent}%`,
      low: (percent) => `🟡 Possibly spam · ${percent}%`
    },
    reasonLine: (reason) => `Reason: ${reason}`,
    noticedTitle: 'What I noticed:',
    signalLabels: {
      external_ban: 'the account is in spam databases',
      external_repeat_offender: 'listed in spam databases more than once',
      fresh_external_ban: 'recently added to spam databases',
      many_shared_chats: 'in many of our chats at once',
      promo_in_bio: 'promo or a contact in the bio',
      personal_channel: 'a channel linked on the profile',
      restricted_for_spam: 'Telegram restricted them for spam',
      just_joined: 'joined and posted right away',
      scam_flag: 'Telegram flagged the account as a scam',
      fake_flag: 'Telegram flagged the account as fake',
      restricted_flag: 'the account is restricted by Telegram',
      sleeper_awakened: 'a dormant account suddenly active',
      fresh_account: 'a brand-new account',
      new_globally: 'new to Telegram',
      new_in_chat: 'first message in this chat',
      identity_churn_24h: 'frequent name / photo changes',
      avatar_recently_set: 'the avatar was just set',
      prior_spam_detections: 'caught spamming before',
      low_reputation: 'a low reputation',
      unofficial_client_risk: 'posted from an unofficial app',
      promo_bot: 'a promo bot',
      forward_hidden_user: 'forwarded from a hidden account',
      forward_source_suspicious: 'forwarded from a suspicious source',
      hidden_url: 'a disguised link',
      external_url: 'an external link',
      url_shortener: 'a shortened link',
      private_invite_link: 'a private invite link',
      bot_deeplink: 'a bot-launch link',
      messenger_contact_link: 'a contact on another messenger',
      many_url_buttons: 'lots of link buttons',
      phone_number: 'a phone number',
      cashtag: 'a crypto / ticker mention',
      long_text: 'an unusually long post',
      invisible_in_word: 'invisible characters hidden inside words',
      mixed_script_word: 'mixed alphabets inside a word',
      custom_emoji_heavy: 'lots of custom emoji',
      paid_media: 'paid media content',
      giveaway_media: 'a giveaway',
      story_share: 'a shared story',
      unknown_media: 'an unrecognized attachment',
      guest_bot_delivery: 'delivered through a guest bot',
      edited_message: 'the message was edited',
      edit_injected_promo: 'promo inserted by an edit',
      moderation_flagged: 'NSFW text or photo',
      nsfw_avatar: 'NSFW profile photo',
      nsfw_stories: 'NSFW story'
    },
    messageTitle: 'The message:',
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
      score: 'signal score',
      abstain: 'abstained',
      error: 'error'
    },
    expired: 'This decision has expired — no details left.'
  },

  profile: {
    title: '👤 Profile',
    accountAge: (age) => `account ${age}`,
    firstSeen: (seen) => `here ${seen}`,
    activity: (messages, chats) => `${messages} messages · ${chats} of our chats`,
    reputation: (status) => `reputation: ${status}`,
    premium: 'Premium',
    externalBan: (ago, offenses) => [
      'in spam databases',
      ...(ago ? [`banned ${ago} ago`] : []),
      ...(offenses > 1 ? [`${offenses} offences`] : [])
    ].join(' · '),
    justJoined: (ago) => `in the chat only ${ago}`,
    promoInBio: 'promo in bio',
    personalChannel: 'linked channel',
    unknownAge: 'age unknown',
    neverSeen: 'first time',
    units: { now: 'now', m: 'm', h: 'h', d: 'd', mo: 'mo', y: 'y' },
    checkNeedReply: 'Reply to a user’s message with /check.',
    notFound: 'Could not fetch the profile.'
  },

  vote: {
    prompt: (userLabel, textPreview) => `🤔 <b>Is this spam?</b> Message from ${userLabel}:\n\n"${textPreview}"`,
    spamButton: (count) => `🗑 Spam (${count})`,
    hamButton: (count) => `👌 Fine (${count})`,
    counted: 'Vote counted.',
    resolvedSpam: '🗑 The community says spam. Removed.',
    resolvedHam: '👌 The community says it is fine.',
    alreadyEnded: 'This vote is already closed.'
  },

  report: {
    needReply: 'Use /report as a reply to the message you want to report.',
    cantReportAdmin: 'Admins cannot be reported.',
    rateLimited: 'Too many reports. Wait a few minutes.',
    accepted: 'Got it, thanks.'
  },

  stats: {
    title: '📊 <b>Your stats</b>',
    inChat: (count) => `Messages in this chat: ${count}`,
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
    success: (name) => `👋 ${name} was removed from the chat.`,
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
    removed: 'Trust revoked.'
  },

  welcome: {
    enabled: '👋 Welcome greetings on.',
    disabled: '👋 Welcome greetings off.',
    textSet: '✅ Welcome text saved. %name% is substituted.',
    gifSet: '✅ Welcome gif saved.',
    usage: [
      '/welcome — toggle on/off',
      '/welcome <text with %name%> — set the greeting',
      'reply to a gif with /welcome — set the gif'
    ].join('\n'),
    defaultGreeting: (name) => `👋 Welcome, ${name}!`
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
    listEmpty: 'No triggers here yet.'
  },

  banan: {
    success: (name, duration) => `🍌 ${name} gets the banana for ${duration}`,
    lifted: (name) => `🍌 ${name} loses the banana`,
    self: (name, duration) => `🍌 ${name} banana'd themselves for ${duration}. Respect`,
    needReply: 'Use /banan as a reply, or plain /banan to banana yourself.',
    undoButton: '↩️ Undo',
    units: { m: 'min', h: 'h', d: 'd' }
  },

  captcha: {
    prompt: (name) => `👋 ${name}, tap the button to keep chatting. Quick check that you are not a bot.`,
    button: '🙋 I am human',
    passed: 'Done, go ahead.',
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
    banan: 'Banan duration',
    language: 'Bot language in this chat',
    languageSaved: 'Chat language updated',
    on: 'On',
    off: 'Off',
    back: '‹ Back'
  }
}
