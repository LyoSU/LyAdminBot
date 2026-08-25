/**
 * Locale contract. uk and en are hand-written reference locales;
 * other languages derive from them (post-v1).
 *
 * UX rules baked into the type system:
 *  - reason CODES are localized here; raw LLM text never reaches users
 *  - no country flags anywhere (language names are plain text)
 */
import type { VerdictAction, SuspicionSignalName, MediaCategory } from '@lyadmin/core'

export interface Locale {
  /** Language name in its own language, NO flag emoji. */
  languageName: string

  start: {
    /** PM welcome card (HTML). `name` arrives pre-escaped. */
    privateCard: (name: string) => string
    /** One-line hint when /start is used inside a group (HTML). */
    groupHint: string
    addToGroupButton: string
    helpButton: string
    langButton: string
  }

  /** /help — full command reference (HTML). */
  helpText: string

  lang: {
    pickerTitle: string
    saved: string
  }

  /**
   * Descriptions for the Telegram command menu (setMyCommands). Keyed by
   * command name; the slash-menu autocomplete shows these next to each command.
   */
  commands: {
    start: string
    help: string
    lang: string
    mystats: string
    report: string
    settings: string
    banan: string
    kick: string
    del: string
    untrust: string
    check: string
    top: string
    topBanan: string
    extras: string
    welcome: string
    ping: string
  }

  actions: Record<Exclude<VerdictAction, 'none' | 'observe'>, string>

  /** One-line compact moderation notice: {action} {user}. */
  notification: {
    compact: (action: string, userLabel: string) => string
    /**
     * Inline "why?" link inside the compact line — the primary route to the
     * explanation. Reads as running text, not as a label on a button, because
     * it is one: lowercase, no emoji of its own.
     */
    whyLink: string
    /** Same destination as a button. Only for the no-username fallback. */
    whyButton: string
    notSpamButton: string
    overrideDone: string
    overrideAlreadyDone: string
    adminOnly: string
    /** Posted when the bot caught spam but lacks the rights to act. */
    missingRights: string
  }

  reasons: Record<string, string>
  reasonFallback: string

  why: {
    /**
     * Fallback header, used only when the verdict took no action (a recalled
     * `observe`). Every enforcement card is headed by the action itself —
     * "what did you do to whom" is the admin's first question, and a generic
     * "Why I acted" answered none of it.
     */
    title: string
    /** Which chat this happened in — an admin reads this card for many. */
    inChat: (chatTitle: string) => string
    /** Verdict line with a traffic-light emoji, chosen by pSpam bucket. */
    confidence: {
      high: (percent: number) => string
      medium: (percent: number) => string
      low: (percent: number) => string
    }
    /** Header above the bulleted, humanized signal list. */
    noticedTitle: string
    /**
     * Every accusing signal, in plain words.
     *
     * Complete by type, not by diligence: `SuspicionSignalName` is derived from
     * the signal catalogue, so adding a signal without translating it does not
     * compile — in any of the five locales. It used to be `Record<string,
     * string>`, and on 2026-07-31 a shipped signal with no label was dropped
     * from every "Why?" card in every language without a word of warning.
     *
     * Trust signals are deliberately absent: they are never shown to anyone.
     */
    signalLabels: Record<SuspicionSignalName, string>
    /** Technical footer (admins only): how the verdict was reached. */
    decidedBy: Record<string, string>
    expired: string
  }

  /** User profile card — shared by /check and the "Why?" card's context block. */
  profile: {
    /** Header used only when we have no display name for the account. */
    title: string
    /** Opens the live profile card from the "Why?" card (admins only). */
    openButton: string
    accountAge: (age: string) => string
    firstSeen: (seen: string) => string
    activity: (messages: number, chats: number) => string
    reputation: (status: string) => string
    premium: string
    externalBan: (ago: string, offenses: number) => string
    justJoined: (ago: string) => string
    promoInBio: string
    personalChannel: string
    /** Shown in place of an age when the account age is unknown / never seen. */
    unknownAge: string
    neverSeen: string
    /** Relative-span unit suffixes for the duration humanizer. */
    units: { now: string; m: string; h: string; d: string; mo: string; y: string }
    /** /check command feedback. */
    checkNeedReply: string
    notFound: string
  }

  /** Community vote on a reported / grey-zone message. */
  vote: {
    /** Prompt above the quoted text (HTML). Inputs arrive pre-escaped. */
    prompt: (userLabel: string, textPreview: string) => string
    /**
     * Prompt for a message with no words in it (HTML). `what` is one of
     * `media` below, already localized, or absent when there was not even an
     * attachment to name.
     *
     * Separate from `prompt` rather than passing it an empty string: a ballot
     * that renders `""` presents emptiness as content, and people vote on it
     * anyway — production 2026-08-25 shows two spam votes cast on a pair of
     * empty quotes. What the message WAS is the smallest honest thing to say.
     */
    promptNoText: (userLabel: string, what: string | null) => string
    /** Media names as a voter would say them, not as the transport calls them. */
    media: Record<MediaCategory, string>
    spamButton: (count: number) => string
    hamButton: (count: number) => string
    counted: string
    resolvedSpam: string
    resolvedHam: string
    alreadyEnded: string
    /** Roster shown behind the "who voted" button on a resolved question. */
    voters: {
      button: string
      title: (spam: number, ham: number) => string
      spamGroup: string
      hamGroup: string
      adminMark: string
      changedMark: string
      span: (span: string) => string
      more: (count: number) => string
      nobody: string
      /** Refused taps, by the reason `voteEligibility` gave. */
      notForTarget: string
      noStanding: string
      knownBad: string
    }
  }

  /** Report command feedback. */
  report: {
    needReply: string
    cantReportAdmin: string
    rateLimited: string
    accepted: string
  }

  /** /mystats personal panel (PM only). */
  stats: {
    title: string
    inChat: (count: number) => string
    global: (count: number) => string
    reputation: (score: number, status: string) => string
    repStatus: Record<'trusted' | 'neutral' | 'suspicious' | 'restricted', string>
    bananCaught: (count: number) => string
    openInPm: string
    openButton: string
  }

  /** /top and /top-banan group leaderboards. */
  top: {
    titleMessages: string
    titleBanan: string
    empty: string
    messagesUnit: (count: number) => string
    bananUnit: (count: number) => string
  }

  /** /kick — admin removes a member (they can rejoin). */
  kick: {
    success: (name: string) => string
    needReply: string
  }

  /** /untrust — admin revokes the auto-trust granted by an override. */
  untrust: {
    success: (name: string) => string
    needReply: string
    notTrusted: (name: string) => string
  }

  /** Trust toggle buttons on the /check profile card (admin-only). */
  trust: {
    /** Button shown when the user is NOT yet trusted. */
    button: string
    /** Button shown when the user IS already trusted. */
    untrustButton: string
    /** Toast after granting trust. */
    added: string
    /** Toast after revoking trust. */
    removed: string
  }

  /** Welcome greetings for new members (off by default). */
  welcome: {
    enabled: string
    disabled: string
    textSet: string
    gifSet: string
    usage: string
    /** Add-list rejection toasts (multi-item welcome). */
    limit: string
    duplicate: string
    tooLong: string
    saveFailed: string
    surgeAlert: (count: number, riskCount: number) => string
    /** Default greeting if an admin enables welcome without setting text. */
    defaultGreeting: (name: string) => string
    /** PM welcome editor (opened from /settings). */
    editor: {
      title: (state: string, nTexts: number, nGifs: number) => string
      enable: string
      disable: string
      texts: (n: number) => string
      gifs: (n: number) => string
      preview: string
      textsTitle: (n: number, max: number) => string
      textsItem: (i: number, preview: string) => string
      textsEmpty: string
      addText: string
      gifsTitle: (n: number, max: number) => string
      gifsItem: (i: number) => string
      gifsEmpty: string
      addGif: string
      promptText: string
      promptGif: string
      added: string
      cancelled: string
      invalidGif: string
      removed: string
      previewEmpty: string
    }
  }

  /** Custom hashtag triggers (extras). */
  extra: {
    saved: (name: string) => string
    deleted: (name: string) => string
    notFound: (name: string) => string
    usage: string
    listTitle: string
    listEmpty: string
    /** PM extras editor (opened from /settings). */
    editor: {
      title: (n: number, max: number) => string
      item: (i: number, icon: string, name: string) => string
      empty: string
      add: string
      maxLabel: (n: number) => string
      promptName: string
      promptContent: (name: string) => string
      added: (name: string) => string
      cancelled: string
      invalidName: string
      removed: string
    }
  }

  /** Manual /banan moderation (admin mute with personality). */
  banan: {
    /** "name muted for duration". Inputs arrive pre-escaped. */
    success: (name: string, duration: string) => string
    lifted: (name: string) => string
    self: (name: string, duration: string) => string
    needReply: string
    undoButton: string
    units: { m: string; h: string; d: string }
    /**
     * An admin typing a bare `/banan`, muting nobody: they just hold the banana
     * up for the chat to see. Restored 2026-08-07 — v2 dropped the branch, so
     * the admin fell through to the self-banan and muted themselves instead.
     */
    show: (name: string) => string
  }

  /** Captcha gate for suspicious newcomers. */
  captcha: {
    /** Group prompt (HTML). `name` arrives pre-escaped. */
    prompt: (name: string) => string
    button: string
    passed: string
    notForYou: string
  }

  settings: {
    openInPm: string
    openInPmButton: string
    title: string
    preset: string
    presets: { soft: string; standard: string; strict: string }
    captcha: string
    voting: string
    enabled: string
    /** External ban databases (lols/CAS) toggle label. */
    banDatabase: string
    /** Default /banan mute-duration row label. */
    banan: string
    /** Group interface-language row label + toast on change. */
    language: string
    languageSaved: string
    /** Root-panel buttons that open the welcome / extras editors. */
    welcome: string
    extras: string
    on: string
    off: string
    back: string
  }
}
