import type { Locale } from '../locale.js'

export const en: Locale = {
  languageName: 'English',

  start: {
    privateCard: (name) => [
      `Hey, <b>${name}</b>! 👋`,
      '',
      '🛡 Anti-spam for groups.',
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
    '🛡 <b>Commands</b>',
    '/report — report spam (as a reply)',
    '/settings — anti-spam for admins (opens in PM)',
    '/lang — language',
    '',
    'I remove spam on my own. Every action has <b>[🤨 Why?]</b> with the reason',
    'and <b>[✅ Not spam]</b> for admins: reverts the call and teaches me.'
  ].join('\n'),

  lang: {
    pickerTitle: 'Pick a language:',
    saved: 'Done, English it is'
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
    title: 'Why this decision',
    probability: (percent) => `Spam probability: ${percent}%`,
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
    evidenceTitle: 'Evidence',
    signalsTitle: 'Signals',
    expired: 'This decision has expired — no details left.'
  },

  vote: {
    prompt: (userLabel, textPreview) => `🤔 Is this spam? Message from ${userLabel}:\n\n"${textPreview}"`,
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
    title: '📊 Your stats',
    inChat: (count) => `Messages in this chat: ${count}`,
    global: (count) => `Messages everywhere: ${count}`,
    reputation: (score, status) => `Reputation: ${score} (${status})`,
    repStatus: { trusted: 'trusted', neutral: 'neutral', suspicious: 'suspicious', restricted: 'restricted' },
    bananCaught: (count) => `Bananas caught: ${count} 🍌`,
    openInPm: 'Stats are on the way to your PM.',
    openButton: '📊 My stats'
  },

  top: {
    titleMessages: '🏆 Most active in chat',
    titleBanan: '🍌 Banana leaderboard',
    empty: 'No stats yet.',
    messagesUnit: (count) => (count === 1 ? 'message' : 'messages'),
    bananUnit: () => '🍌'
  },

  welcome: {
    enabled: '👋 Welcome greetings on.',
    disabled: '👋 Welcome greetings off.',
    textSet: '✅ Welcome text saved. %name% is substituted.',
    gifSet: '✅ Welcome gif saved.',
    usage: '/welcome — toggle on/off. /welcome text with %name% — set the greeting. Reply to a gif with /welcome — set the gif.',
    defaultGreeting: (name) => `👋 Welcome, ${name}!`
  },

  extra: {
    saved: (name) => `✅ Saved #${name}`,
    deleted: (name) => `🗑 Deleted #${name}`,
    notFound: (name) => `No such trigger: #${name}`,
    usage: 'Reply to a message with /extra name to save it under #name. /extra name with no reply deletes it.',
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
    title: 'Anti-spam settings',
    preset: 'Mode',
    presets: { soft: 'Soft', standard: 'Standard', strict: 'Strict' },
    captcha: 'Captcha for newcomers',
    voting: 'Community voting',
    enabled: 'Anti-spam',
    on: 'On',
    off: 'Off',
    back: '‹ Back'
  }
}
