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
    /**
     * The live proof line inside the welcome card.
     *
     * A first-time reader has no reason to believe any of the claims above it;
     * this is the sentence that is checkable. Omitted entirely when the counts
     * could not be read — an unproven claim beats a fabricated one.
     */
    liveProof: (chats: number, spammers: number, days: number) => string
    /** One-line hint when /start is used inside a group (HTML). */
    groupHint: string
    addToGroupButton: string
    helpButton: string
    langButton: string
  }

  /** /help — full command reference (HTML). */
  helpText: string

  /**
   * A write we told the admin about did not confirm.
   *
   * Shared across the editors because it is one fact: Mongo did not say yes.
   * Every one of those paths used to swallow the failure and answer "saved" —
   * an admin leaves setup believing a greeting or a trigger is live, and finds
   * out when it never fires.
   */
  writeFailed: string

  /**
   * A stand-in for a display name that IS the advertisement.
   *
   * `promo_in_name` exists precisely because some accounts buy their name as ad
   * space. Every notice about such an account reprinted that name — and once
   * names became tappable mentions, the notice about the advert became a tap
   * into the advertiser's profile. The neutral form keeps the notice navigable
   * (the link still resolves) without carrying the payload.
   */
  hiddenName: (userId: number) => string

  /**
   * Which group a PM panel is about. `chatTitle` arrives pre-escaped.
   *
   * Every editor screen carried the chat id in its callback data and showed it
   * nowhere, so an admin of several groups could reopen an old panel from the
   * scrollback and change voting, protection level, greetings or triggers in
   * the wrong one, with nothing on screen to say so.
   */
  panelForChat: (chatTitle: string) => string

  lang: {
    pickerTitle: string
    saved: string
    /**
     * Group `/lang` for a non-admin. Their own language is a PM setting: it
     * changes what the bot says to them, not what the chat reads.
     */
    openInPm: string
    openButton: string
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
    stats: string
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
    /**
     * The correction was recorded but something it promises did not land — the
     * unrestrict, or the trust write. Shown as an alert, and the button is left
     * in place so it can be pressed again.
     */
    overridePartial: string
    overrideAlreadyDone: string
    adminOnly: string
    /**
     * Posted when the bot caught spam but lacks the rights to act.
     *
     * Takes what is actually missing rather than asking for everything. The
     * flat version asked for both rights in every chat, which is wrong wherever
     * one of them works — and the chat that needed this most is exactly that
     * case: production 2026-08-26 had one group where the bot deleted 267 spam
     * messages it was not allowed to act on the senders of, and was telling its
     * admins it could not remove spam at all.
     *
     * `accounts` is how many distinct senders were left in place this episode;
     * zero means nothing is recorded and the sentence is dropped. It is the
     * half that persuades — the count of attempts reads as a broken bot.
     */
    missingRights: (gap: { deleteBlocked: boolean; senderBlocked: boolean; accounts: number }) => string
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
    /**
     * The `external_ban` evidence quote, in words.
     *
     * The one evidence line the bot writes itself — every other quote is a
     * stranger's text, reprinted verbatim. So it is the only one that can be
     * translated, and the only one where we choose what it does not say: which
     * lists accused the account is deliberately absent from every member-facing
     * surface. `sources` is the number of lists that agree (rendered only when
     * more than one says so, the way `profile.externalBan` renders `offenses`),
     * `ago` an already-formatted span, or null when the listing has no date.
     *
     * It COUNTS them and does not call them independent, which the first
     * version did. Measured 2026-08-30 against the store: of 7616 accounts both
     * lists answered for, 1155 are on both while 5734 are listed by one and
     * called clean by the other. That rules out one feed mirrored twice; it
     * does not establish independence, which would need to know whether either
     * imports from the other. A count is a fact we hold. Independence was a
     * claim we had not checked, made in the sentence a member reads to
     * understand why somebody was banned.
     */
    /**
     * Evidence lines the reader would otherwise get in English.
     *
     * `reasonEvidence` is written by the producer for the record, not for a
     * card — `same photo on 35 other account(s)` is what a Ukrainian chat was
     * shown under a Ukrainian verdict. Two facts carry most of the profile-only
     * population, so those two get a sentence in the reader's language and the
     * rest still fall through to the raw line.
     */
    profileReuseEvidence: (accounts: number) => string
    profileMediaEvidence: (score: string) => string
    externalBanEvidence: (sources: number, ago: string | null) => string
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
    /**
     * `messages` is `null` when the counter could not be read. Every locale
     * drops that half rather than printing a zero — an outage must not be
     * rendered as a fact about the member whose profile this is.
     */
    activity: (messages: number | null, chats: number) => string
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
    /**
     * Prompt above the quoted text (HTML). Every input arrives pre-escaped, and
     * the quote MUST be wrapped in `<pre>`: a monospace block is the one
     * container Telegram does not linkify, so the invite a spammer wrote stops
     * being a tappable link in a message the whole chat reads. The bot's own
     * authority behind a live link is the one distribution channel a spammer
     * cannot buy, and the ballot used to hand it over.
     *
     * `media` names the attachment when the message had BOTH words and a file —
     * a caption reads innocuous under a picture that is the whole advert, so a
     * ballot that quotes only the words asks about half the message. `whyLink`
     * is an anchor to the bot's PM explanation, or absent where there is no
     * bot username to link to (or nothing to explain, as with a human report).
     */
    prompt: (parts: {
      userLabel: string
      /**
       * The quoted message, already escaped AND already wrapped in its own
       * block — interpolate it, do not put a tag around it.
       *
       * The wrapper used to live in each translation as `<pre>`, five copies of
       * one presentation decision. It was the wrong container (a code block
       * does not wrap, so a long advert ran off the edge of the card) and
       * changing it meant editing five files that had no business holding the
       * choice. `quoteBlock` owns it now, expandable and all.
       */
      textPreview: string
      media: string | null
      whyLink: string | null
    }) => string
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
    promptNoText: (userLabel: string, what: string | null, whyLink: string | null) => string
    /** Media names as a voter would say them, not as the transport calls them. */
    media: Record<MediaCategory, string>
    /**
     * What replaces a destination inside the quoted text. Bracketed, because a
     * voter has to be able to tell our word from the sender's.
     */
    redacted: { link: string; mention: string; invite: string }
    spamButton: (count: number) => string
    hamButton: (count: number) => string
    counted: string
    /**
     * What the bot managed to do about a message the chat called spam.
     *
     * A separate sentence from the verdict, because they are separate facts:
     * the community can be certain while the bot is powerless. The receipt used
     * to assert removal unconditionally, so a chat that took the bot's rights
     * away mid-ballot got a settled-looking result over a message still on
     * screen — and a settled result is one moderators stop checking.
     */
    enforcement: {
      done: string
      deletedOnly: string
      mutedOnly: string
      failed: string
    }
    /**
     * The receipt (HTML). `who` names the person the question was about and is
     * absent only when a restart lost the label — the resolved prompt replaces
     * the question in place, and scrolled past a week later "the community says
     * spam" names nobody and settles nothing. `enforcement` is one of the
     * sentences above, or absent where the caller does not know the outcome.
     */
    resolvedSpam: (parts: {
      who: string | null
      enforcement: string | null
      whyLink: string | null
    }) => string
    resolvedHam: (parts: { who: string | null; whyLink: string | null }) => string
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
    /**
     * The reply was a join line that admitted several people at once, so the
     * report does not name anybody. One report is about one account: screening
     * a whole bulk add off a single tap is leverage nobody should have.
     */
    oneAtATime: string
  }

  /** /mystats personal panel (PM only). */
  stats: {
    title: string
    /**
     * `chatTitle` arrives pre-escaped, and is absent only where the title could
     * not be resolved. This used to say "in this chat" from a PM, where "this"
     * names nothing: somebody with stats links for several groups could not
     * tell which count belonged to which, and would compare unrelated numbers.
     */
    inChat: (count: number, chatTitle: string | null) => string
    global: (count: number) => string
    reputation: (score: number, status: string) => string
    repStatus: Record<'trusted' | 'neutral' | 'suspicious' | 'restricted', string>
    bananCaught: (count: number) => string
    openInPm: string
    openButton: string
  }

  /**
   * `/stats` — what the bot has done lately, in its own words.
   *
   * The one card where the bot is the subject, so it is written to the standard
   * the moderation notices are held to: counted figures over a named window, no
   * cumulative-since-launch claim nobody can recompute. Counts arrive raw and
   * each locale groups its own digits, because separators are a property of the
   * language.
   */
  botStats: {
    title: string
    /** "over the last N days" — the window is stated, never assumed. */
    window: (days: number) => string
    checked: (count: number) => string
    spammers: (count: number) => string
    chats: (count: number) => string
    speed: (ms: number) => string
    /**
     * The share of messages nothing happened to.
     *
     * The figure a chat owner is actually deciding on: "it bans a lot" reads as
     * a threat to their own members until the card says how rarely it acts.
     */
    quiet: (percent: number) => string
    reasonsTitle: string
    reasonLine: (name: string, count: number) => string
    memory: (signatures: number) => string
    /** Share of punishments an admin took back — our own error rate, published. */
    corrections: (percent: number) => string
    /** Per-chat block, shown when the card is asked for from inside a group. */
    chatHeader: (title: string, days: number) => string
    chatLine: (checked: number, spammers: number, deletes: number) => string
    chatLastSpam: (ago: string) => string
    /** A chat with nothing to report is told so, not shown a row of zeros. */
    chatClean: string
    /**
     * Said when the counts could not be read. A card of zeros would claim the
     * bot has done nothing, which is a worse answer than admitting the gap.
     */
    unavailable: string
    button: string
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
      /** The row the tap named was already gone — a stale screen, not a write. */
      removeMissing: string
      /**
       * The five-minute capture window lapsed before the admin replied. Said
       * out loud, because silence sent the correction into the /start handler.
       */
      expired: string
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
    /**
     * The tap was ours and valid, but lifting the restriction failed. The gate
     * is deliberately NOT spent in that case, so this asks for another tap —
     * the alternative was a success toast over a member who stayed muted with
     * nothing left to tap.
     */
    retry: string
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
