# LyAdminBot — UX/UI модернізація

**Дата:** 2026-04-22
**Статус:** Дизайн узгоджений, чекає implementation plan
**Скоуп:** Полна модернізація юзер-фейсінг частини бота. Без Mini App.

---

## Контекст

LyAdminBot — Telegram-бот для модерації груп з антиспам-pipeline (custom rules → signatures → forward blacklist → risk → moderation → velocity → vectors → LLM → community voting). Стек: Node.js, Telegraf 3.33, MongoDB, Qdrant, OpenAI, OpenRouter. 5 локалей (uk/en/ru/tr/by).

UX зараз має сильні елементи (custom emoji, easter eggs, inline-кнопки в `!spam`-меню), але:

- Адмінські команди розпорошені по `!`-prefix (немає єдиної точки входу `/settings`)
- 3 розрізнені callback-namespaces (`sv:`, `spam:`, `ns:`) → копіпаста перевірок прав, парсингу, "update UI on change"
- `setMyCommands` ніколи не викликається → немає автодоповнення в Telegram-клієнті
- `/help` — текстова стіна без навігації
- Авто-нотифікації спам-системи мають **зоопарк форматів** (різні структури, різні кнопки, різні рівні деталізації) — адмін не з першого погляду розуміє що, чому і що з тим робити
- Бот ніколи не використовує `setMessageReaction` → засирає чат "✓"-підтвердженнями замість тихих реакцій

## Цілі

1. **Discoverability** — будь-який юзер/адмін має знайти потрібну функцію за ≤2 кліки без знання `!`-команд
2. **Узгодженість** — однакові примітиви (back, pagination, confirm, toast, "тільки адмін") для всіх меню
3. **Прозорість авто-дій** — кожна спам-нотифікація відповідає на 4 питання: хто, чому, що зроблено, що адмін може зробити далі
4. **Менше шуму в чаті** — реакції замість текстових ack, auto-cleanup везде
5. **Сучасний Bot API** — `setMyCommands` зі scopes, `setChatMenuButton`, `setMessageReaction`, `link_preview_options`, `reply_parameters`

Anti-цілі: Mini App; inline-режим; custom reply-keyboards; платежі; PM-нотифікації забаненим.

## Незмінне

- Backward compatibility: всі поточні `/`- і `!`-команди працюють як shortcuts (можуть редіректити в нове меню)
- Локалізація: будь-який новий рядок має бути в усіх 5 локалях
- Telegraf 3.33 — без апгрейду до v4 у цьому скоупі
- 64-byte limit на `callback_data` — суворо

---

## Архітектура

### Menu Router (`helpers/menu/`)

Один уніфікований шар для всіх інтерактивних меню. Існуючі `sv:`, `spam:`, `ns:` мігруються на новий префікс `m:v1:` (з backward-compat aliases на 1 версію).

```
helpers/menu/
  router.js      // bot.action(/^m:v1:/) → dispatch
  registry.js    // registerMenu({id, render, handle, access})
  keyboard.js    // buttons, rows, backBtn, paginated
  state.js       // group.info.settings.menuState (TTL 10хв) для коротких state
  access.js      // initiator/admin/trusted guards з локалізованими toast
  flows.js       // force_reply chains для текстового вводу
```

**Callback-data схема:** `m:v1:<screenId>:<action>:<arg1>:<arg2>` — всі токени короткі (slug-style), довгі дані живуть у БД.

**Реєстрація екрану:**
```js
registerMenu({
  id: 'settings:antispam',
  access: 'group_admin',
  render: (ctx, state) => ({ text, keyboard }),
  handle: (ctx, action, args) => { /* ... */ }
})
```

**Спільні примітиви:**
- `backBtn(toScreenId)` — стандартизована "← Назад"
- `paginated(items, {page, perPage, screenId})` — список з ‹/› + лічильником
- `confirmScreen({title, btnYes, btnNo, onConfirm})` — destructive дії
- `toggleBtn({label, on, callback})` — `🟢 / 🔴` уніфіковано

### Force-reply чейни (для текстового вводу)

Сценарії: додати правило, додати welcome-text, створити extra. Замість Telegraf scenes — простіше:

1. Адмін тиснe `[ ➕ Дозволити ]` → бот шле `force_reply` з підказкою + записує `group.info.settings.pendingInput = { type: 'spam_allow', screen: 'settings:antispam:rules', userId, expiresAt: now+5min, msgId }`
2. Middleware `pending-input.js` ловить наступне повідомлення цього юзера в цьому чаті → виконує дію → редагує оригінальне меню + видаляє свій `force_reply`
3. Якщо expired або юзер не відповів — silently drop

### Реєстрація команд (`bot/setup-commands.js`)

Викликається при boot:
- `setMyCommands(commands, { scope: { type: 'default' }, language_code: 'uk' })` × 5 мов
- Те саме для `all_group_chats`, `all_chat_administrators`, `all_private_chats`
- `setChatMenuButton({ menu_button: { type: 'commands' } })` — глобально (стандартні commands menu)

### Реакції замість текстових ack

Helper `helpers/reactions.js`:
```js
ack(ctx, emoji)           // setMessageReaction на повідомлення-команду
ackOnTarget(ctx, msgId, emoji) // на конкретний msgId
silent(ctx)               // 👀 — для report ack без тексту
```
Fallback: якщо `setMessageReaction` фейлиться (старі чати, заборонені реакції) — мовчки swallow, бо це cosmetic.

---

## Секції дизайну

### 1. Реєстрація команд + Menu Button

**setMyCommands scopes:**

| Scope | Команди |
|---|---|
| `default` | `/start`, `/help`, `/ping`, `/lang` |
| `all_group_chats` | `/banan`, `/kick`, `/del`, `/report`, `/mystats`, `/top`, `/top_banan`, `/extras`, `/help`, `/lang`, `/ping` |
| `all_chat_administrators` | + `/settings` |
| `all_private_chats` | `/start`, `/help`, `/lang`, `/ping`, `/mystats` |

Локалізовані описи беремо з нового `bot_commands:` namespace у локалях.

**Menu Button:** `type: 'commands'` глобально (Telegram сам відкриває команди для скоупу). Не використовуємо `web_app` (Mini App виключено з скоупу).

**Deep-links для `/start`:**
- `?startgroup=add` (вже є)
- `?start=help` — одразу /help
- `?start=settings_<chatId>` — /settings конкретного чату в приваті (з перевіркою адмінства)
- `?start=mystats_<chatId>` — для кнопки "Скинути в особисті" з `/mystats`

### 2. /start редизайн

**Приват:**
```
🛡 Привіт, {name}! 👋

LyAdminBot — антиспам для груп.
Ловлю спам · баню шахраїв · чищу рекламу.

Швидкий старт:
1. Додай в групу
2. Дай права адміна
3. Готово — я сам розберусь.
```
Клавіатура:
```
[ ➕ Додати в групу ]
[ 📖 Допомога ] [ 🌐 Мова ]
```

Якщо deep-link `start=help` → одразу малюємо /help.

**Група:** короткий рядок як зараз + кнопка `[ 📖 Допомога ]`.

### 3. /help редизайн (tab-style)

Один екран з табами замість текстової стіни:

```
🛡 LyAdminBot · Допомога

{обраний розділ: опис + команди з прикладами}

[ 🛡 Старт ] [ ⚔️ Модерація ] [ 📊 Стата ]
[ 🔧 Адмін ] [ 💬 Про бота ]
[ ← Назад ]    (приховано на root)
```

Розділи: Старт · Модерація · Стата · Адмін · Про бота.

**Поведінка:**
- Тільки ініціатор може клікати (інакше toast `🔒 Натисни /help сам`)
- У групі: auto-delete 60s після останнього кліку (рефреш `scheduleDeletion`)
- Callback: `m:v1:help:tab:<section>`

### 4. Onboarding wizard при додаванні в групу

Замість поточного `bot_added.as_admin` text-hint → 3-крокова інтро-карта:

```
🛡 Привіт! Я тут, антиспам активний.

Швидке налаштування (60 секунд):

🌐 Мова: Українська (auto)
🎚 Чутливість: 70% (середня)
👋 Привітання: вимкнено
```
```
[ ✓ Так підходить ] [ 🔧 Налаштувати ]
```

`[ Налаштувати ]` → `/settings` без окремої команди (edit message). `[ Так підходить ]` → реакція 👌 + auto-delete через 30s.

Якщо немає прав адміна — стандартне `bot_added.need_admin`.

### 5. /settings — єдина адмінська панель

Нова команда + alias `!settings`. Доступна адмінам у групі.

**Кореневий екран:**
```
🔧 Налаштування · {chatTitle}

🛡 Антиспам:        ✓ увімк · поріг 70%
👋 Привітання:      ✓ увімк · 3 тексти · 2 gif
🌍 Глоб. бан-база:  ✓ увімк
📺 Бан каналів:     ✗ вимк
📝 Extras:          5 / 50
🌐 Мова:            Українська
```
```
[ 🛡 Антиспам ] [ 👋 Привітання ]
[ 🌍 Бан-база ] [ 📺 Бан каналів ]
[ 📝 Extras ] [ 🌐 Мова ]
[ 📋 Журнал ] [ ⚙️ Діагностика ]
[ 📤 Експорт JSON ] [ ♻️ Скинути ]
[ ✕ Закрити ]
```

#### 5.1 🛡 Антиспам (мігрує `!spam`)

```
🛡 Антиспам

Стан:        ✓ увімкнено
Глоб. бан:   ✓ так
Чутливість:  70%   ▮▮▮▮▮▮▮▱▱▱
Правил:      3
Довірених:   12
```
```
[ 🟢 Вимкнути ]
[ 🌍 Глоб. бан: вимк ]
[ 🎚 Чутливість ]
[ 📜 Правила ] [ 👤 Довірені ]
[ ← Назад ]
```

**Підекран "Чутливість":** `[−5] [−1] [70%] [+1] [+5]` + bar + підказка "вище = менше помилок, але може щось пропустити".

**Підекран "Правила":** пагінований список з `[🗑]` біля кожного. `[ ➕ Дозволити ] [ ➕ Заборонити ]` → force-reply "Введи текст правила". Empty state з guided actions.

**Підекран "Довірені":** пагінація + `[🗑]`. `[ ➕ Додати ]` → інструкція + альтернативи (reply / @username / ID).

#### 5.2 👋 Привітання (мігрує `!welcome`/`!gif`/`!text`)

```
👋 Привітання

Стан:    ✓ увімкнено
Тексти:  3
Gif:     2
```
```
[ 🟢 Вимкнути ]
[ ✏️ Тексти ] [ 🎬 Gif ]
[ ← Назад ]
```

**"Тексти":** список з прев'ю (≤50 симв) + `[🗑]`. `[ ➕ Додати ]` → force-reply "Надішли текст з обовʼязковим `%name%`". Валідація на наявність `%name%` перед збереженням.

**"Gif":** грід 2×3 з thumbnail-прев'ю. `[ ➕ Додати ]` → force-reply.

#### 5.3 📝 Extras (мігрує `!extra`)

```
📝 Extras: 5 / 50
```
Грід inline-кнопок (2 в ряд) з `#hello`, `#rules`. Tap → перегляд + `[🗑] [✏️]`. `[ ➕ Створити ]` → інструкція "у відповідь на повідомлення `!extra назва`".

#### 5.4 🌍 Бан-база, 📺 Бан каналів

Простий toggle з поясненням ефекту. Один екран.

#### 5.5 🌐 Мова — без прапорів

```
🌐 Мова інтерфейсу

Поточна: Українська
```
```
[ ● Українська ]
[   English   ]
[   Русский   ]
[   Türkçe    ]
[   Беларуская ]
[ ← Назад ]
```

Маркер `●` для вибраної. **Без прапорів** (політично чутливо). `/lang` поза `/settings` показує те саме меню.

#### 5.6 📋 Журнал (новий)

Новий feature. Колекція `ModLog` (TTL 30 днів). Поля: `chatId, eventType, actor, target, action, reason, timestamp`.

Типи подій: `manual_ban, manual_kick, manual_del, auto_ban, auto_mute, auto_del, override, vote_resolved, trust, untrust, settings_change`.

```
📋 Останні дії · 24 год

15:42 ⚔️ @admin → /banan @user1 (5 хв)
15:30 🤖 авто-бан @spammer (97%)
14:55 ↩️ @admin скасував бан @user2
14:33 🛡 +правило "реклама заробітку"
...

[ 24 год ] [ 7 днів ] [ Весь час ]
[ ‹ ] стор 1/N [ › ]
[ ← Назад ]
```

#### 5.7 ⚙️ Діагностика (новий)

```
⚙️ Діагностика

🟢 Telegram API · 142 ms
🟢 MongoDB · OK
🟡 OpenAI · slow (3.2s avg)
🔴 Qdrant · недоступний
🟢 Антиспам черга · 0 pending
🟢 Аптайм · 4 дні 12 год
```

Read-only. Live-оновлення через `[ 🔄 Оновити ]`.

#### 5.8 📤 Експорт / ♻️ Скинути

- Експорт → JSON (вже є `send-settings-json.js`)
- Скинути → confirm-екран

### 6. /banan quick-picker

**Якщо адмін викликає `/banan` у відповіді БЕЗ часу:**
```
🍌 Замʼютити {імʼя}?

[ 5 хв ] [ 30 хв ] [ 1 год ]
[ 6 год ] [ 1 день ] [ 7 днів ]
[ ⛔ Назавжди ]
[ ✕ Скасувати ]
```

Callback: `m:v1:ban:do:<targetId>:<seconds>`. Перевірка: клікер = ініціатор АБО інший адмін. Auto-delete через 30s якщо нічого не вибрали.

**Якщо викликає не-адмін:** поведінка не змінюється (random 1–10 хв на ініціатора — це жарт-механіка).

### 7. Inline "Скасувати" після модераційних дій

Після успішних `/banan`, `/kick` додаємо до повідомлення-результату:
```
🍌 {імʼя} отримує банан
На: 5 хвилин

[ ↩️ Скасувати ]
```
- Кнопка живе 60s, потім видаляється editMessage'ом
- Натиснути може ініціатор АБО інший адмін
- Callback: `m:v1:mod:undo:<eventId>`

**`/del` — особливий кейс:** реальний undo неможливий. Робимо: бот зберігає копію text/caption/file_id у `pendingUndelete[messageId]` (in-memory LRU, TTL 30s). При `[↩️ Відновити]` репостить від імені бота з підписом "відновлено адміном @x". Якщо media занадто велике — кнопка вимикається.

### 8. Покращене "Дай мені права"

Замість одного рядка:
```
🔒 Не можу замʼютити {імʼя}

Бракує прав адміна:
• Видаляти повідомлення
• Банити користувачів

[ 📖 Як дати права ]
```

`[ 📖 Як дати права ]` → toast з deep-link на `/help#admin` АБО розгортає інлайн інструкцію (4 кроки з emoji).

### 9. Уніфіковане повідомлення про авто-дії *(центральне)*

**Проблема:** зараз є зоопарк (`spam.banned`, `spam.muted`, `spam.notification.{full,muted_only,deleted_only,no_permissions}`, `global_ban.kicked`, `spam_vote.title_*`, `report.spam_found`). Адмін не розуміє з першого погляду — що, чому, і що робити.

**Рішення:** один шаблон для **усіх** авто-дій бота.

```
{статус-emoji} {Заголовок}

👤 {імʼя}{ · @username}
└ репутація 42 · акаунт 3 міс. · 12 повідомл.

🤖 Чому: {причина людською} · {confidence}%
📝 «{прев'ю до 80 символів...}»

🛡 Дія: {що зроблено}
{⚠️ {застереження якщо щось не вдалось}}

[ ✓ Підтвердити спам ] [ ↩️ Розблокувати ]
[ 🗳 Голосувати громадою ]   (якщо voting активне)
```

**Заголовки (єдиний словник):**

| Статус | Заголовок | Emoji |
|---|---|---|
| Замучено 24 год (mid-confidence) | Замучено | 🔇 |
| Видалено + бан назавжди (high) | Заблоковано назавжди | ⛔ |
| Тільки видалено (no perms) | Видалено | 🗑 |
| Без прав, тільки попередження | Підозрілий допис | 👀 |
| Глоб-бан з іншого чату | Кікнуто (глоб. бан) | 🌍 |
| Voting timeout → spam | Спам підтверджено громадою | ⚖️ |
| Voting → clean | Розблоковано громадою | ↩️ |
| Admin override | Скасовано адміном @x | ↩️ |
| /report → spam | Спам (за репортом) | 📢 |

**Завжди 4 блоки:** заголовок · хто (з контекстом) · чому (humanized + confidence + preview) · що зроблено (+ warnings).

**Кнопки уніфіковано:**

| Сценарій | Кнопки |
|---|---|
| Авто-мут/бан high confidence | `[ ✓ Підтвердити ] [ ↩️ Розблокувати ]` |
| Авто-мут mid (з voting) | `[ 🚫 Спам ·N ] [ ✓ Норм ·N ]` |
| Бот без прав | `[ 📖 Як дати права ]` |
| Reportv | `[ 🚫 Забанити ] [ ↩️ Скасувати ]` |
| Глоб-бан | `[ ↩️ Розблокувати тут ]` |

Всі → `m:v1:mod:<action>:<eventId>` через menu router. `eventId` — або з `SpamVote`, або з нової легкої колекції `ModEvent` для не-vote кейсів.

**i18n:** новий namespace `mod_event:` з полями `title.{banned, muted, deleted, suspicious, global_ban, vote_spam, vote_clean, override, report_spam}`, `user_line`, `context_line`, `reason_line`, `preview_line`, `action_line`, `warning_line`, `btn.{confirm, undo, vote, ban, give_rights}`. Старі ключі — deprecated alias на 1 версію.

**Auto-cleanup:** 2 хв після останньої дії; якщо є voting — до резолюції + 2 хв.

### 10. Spam-vote polish (надбудова на §9)

**Прогрес-бар голосування:**
```
⚖️ Голосування: 4 хв 12 с
██████░░░░  3 / 5 голосів до резолюції
```
Оновлюється на кожен `editMessageText` (вже є `updateVoteUI`).

**Пост-результат кнопки:**
- Spam-confirmed: `[ ⛔ Забанити назавжди ] [ ↩️ Розблокувати ]`
- Clean-confirmed: `[ ⛔ Все ж забанити ]`
- Тільки адміни, активні 60s

**Розгортання deep-context:**
- `[ 🔍 Деталі ]` → toast з повним AI reasoning, signals, fingerprint hash

### 11. /mystats редизайн

```
📊 Стата {імʼя} в {chatName}

🍌 Бананів:        12
⏲ Всього в бані:  4 год 22 хв
⚡ Автобан:         1 год

💬 Повідомлень:   1 247
📈 Актив:   ▮▮▮▮▮▮▮▱▱▱  72%
🌊 Флуд:    ▮▮▱▱▱▱▱▱▱▱  18%

📅 Тут з: 2024-03-15
🎖 Ветеран чату
```

Helper `bar(percent, len=10)` у `helpers/text-utils.js`. Бейджі (вже є) лишаються.

### 12. /top, /top_banan редизайн

```
🏆 Топ активних · {chatName} · стор 1/3

 1. 👑 @user1                  2 341
 2. 🥈 @user2                  1 980
 3. 🥉 @user3                  1 504
 4.    @user4                  1 102
 ...
10.    @user10                   421

[ ‹ ] стор 1/3 [ › ]
[ 🕒 За 7 днів ] [ 📅 Весь час ]
[ ✕ Закрити ]
```

Пагінація 10/сторінка. Тогл періоду — **тільки якщо в БД є timestamps на статах**; інакше відображаємо лише "весь час" без тоглу. Нумерація вирівняна моноширинно через NBSP.

### 13. /extras редизайн

Грід 2×N inline-кнопок:
```
[ #hello ] [ #rules ]
[ #faq   ] [ #links ]
[ ‹ ] стор 1/2 [ › ]
```

Tap → бот шле extra (як зараз). Адмін бачить додатково:
```
[ 🗑 Видалити #hello ] [ ✏️ Редагувати ]
```

### 14. /lang — без прапорів

(Дублює §5.5; також доступне поза `/settings`.)

### 15. Реакції замість текстових ack

Бот викликає `setMessageReaction` замість додаткового reply для коротких операцій:

| Подія | Реакція | Замінює |
|---|---|---|
| `/del` успіх | 🗑 на бот-нотифікацію | окремий "Видалено" |
| `/banan` успіх | 🍌 на повідомлення замученого | (додатково до banan-card) |
| `/report` accepted | 👀 на репортоване | окреме "Перевіряю..." |
| Spam-vote голос | 🚫/✅ на vote-нотифікацію | (додатково до toast) |
| `!extra назва` створено | ✍️ на повідомлення-зразок | окреме "збережено" |
| `!spam trust @user` reply | ✓ на reply | окреме "Тепер в довірених" |

Helper `helpers/reactions.js`:
```js
ack(ctx, emoji)
ackOnTarget(ctx, msgId, emoji)
silent(ctx)  // 👀
```

**Fallback:** якщо `setMessageReaction` фейлиться (заборонені реакції в чаті, стара версія TG, etc.) — silent swallow + opcionálne fallback на текстове підтвердження.

### 16. Typing-індикатори

`sendChatAction("typing")` під час:
- `/report` AI-аналіз (зараз "Перевіряю..." — типінг кращий)
- LLM-перевірка спаму (опціонально, бо часто фоном)
- Будь-яка операція >1s

Helper `helpers/typing.js` зі `withTyping(ctx, fn)` обгорткою.

### 17. Empty states з guided actions

Шаблон для всіх "немає X":
```
{emoji} {Назва} поки немає

{1-2 рядки пояснення про що це і нащо}

[ ➕ Створити перше ]   (або 2 кнопки)
[ ← Назад ]
```

Місця: правила, довірені, welcome-тексти, welcome-gif, extras, ModLog (24 год без подій).

### 18. Дрібний polish

- **Toast-and-callback consistency:** короткі стандартні `✓ Збережено`, `↩️ Скасовано`, `🔒 Тільки адміни`, `⏱ Сесія застаріла`. Single helper `toast(ctx, key)`.
- **`disable_web_page_preview` → `link_preview_options: { is_disabled: true }`** — сучасна Bot API форма (Telegraf 3.33 повинен пропускати — інакше через `callApi`).
- **Reply quoting:** `reply_parameters.quote` для `/report` — "Скаржусь на цю частину".
- **`/ping`:** без змін (hostname → privacy-leak, відкинуто).
- **Auto-delete policy:** один config `helpers/cleanup-policy.js`:
  ```js
  module.exports = {
    cmd_help: 60_000,
    cmd_settings_idle: 600_000,
    vote_result: 120_000,
    mod_event: 120_000,
    banan_undo: 60_000,
    onboarding_ack: 30_000,
    confirm_screen: 30_000,
    quick_picker: 30_000
  }
  ```
- **`replyHTML` middleware-обгортка** — централізує `parse_mode: HTML` + `link_preview_options` + `reply_parameters` defaults.
- **Видалити `quote.js` хендлер?** — він просто рекомендує `@QuotLyBot`. Залишаємо як є (low-effort).

---

## Зміни в БД

**Нові колекції:**

1. **`ModEvent`** — для не-vote модераційних подій (auto-actions без vote): `eventId`, `chatId`, `actorId` (bot/admin/system), `targetId`, `actionType`, `reason`, `messagePreview`, `confidence`, `actionTaken`, `notificationMessageId`, `notificationChatId`, `createdAt` (TTL 7 днів). Дозволяє кнопкам у мод-нотифікаціях посилатись на eventId без зайвого парсингу.

2. **`ModLog`** — для §5.6 журналу: `chatId`, `eventType`, `actorId`, `actorName`, `targetId`, `targetName`, `action`, `reason`, `timestamp` (TTL 30 днів, індекс по `{chatId, timestamp:-1}`).

**Зміни в `Group.settings`:**

- `menuState: { userId, screen, data, expiresAt }[]` — короткоживучий state навігації по меню (TTL 10 хв)
- `pendingInput: { userId, type, screen, expiresAt, msgId }` — chain force-reply

**Зміни в `Group.stats`/member-stats:** опціонально додаємо timestamps для тоглу періоду в `/top` (якщо немає — лишаємо тільки "весь час").

---

## Локалізація

Нові namespace в усіх 5 локалях:

- `bot_commands:` — описи команд для `setMyCommands` (`start.cmd`, `start.desc` тощо)
- `mod_event:` — уніфіковані спам-нотифікації (§9)
- `menu:common:` — `back`, `close`, `prev`, `next`, `cancel`, `confirm`, `saved`, `cancelled`, `only_admins`, `session_expired`, `loading`
- `menu:settings:` — повна структура settings + всі підекрани
- `menu:help:` — таби /help
- `menu:onboarding:` — wizard з §4
- `menu:diagnostics:` — §5.7
- `menu:modlog:` — §5.6
- `menu:lang_picker:` — §5.5 (підкреслено: жодних прапорів)
- `empty_state:` — §17 шаблони

Старі ключі лишаємо deprecated (alias через `ctx.i18n.t()` middleware на 1 версію), потім чистимо.

---

## Backward compatibility

| Шлях | До | Після | Період |
|---|---|---|---|
| `!spam` | свій inline | редірект в `/settings → антиспам` | назавжди (alias) |
| `!welcome`, `!gif`, `!text` | окремі handlers | редірект у `/settings → привітання` | назавжди |
| `!banbase`, `!banChannel` | окремі handlers | редірект у `/settings → бан-база/канали` | назавжди |
| `!extra` | окремий handler | без змін (сам акт додавання залишається у відповідь на повідомлення); `/extras` отримує grid | назавжди |
| `!reset`, `!json` | handlers | в `/settings → експорт/скинути` | назавжди |
| `sv:`, `spam:`, `ns:` callback-data | окремі handlers | aliased на `m:v1:` через router | 1 версія |
| `disable_web_page_preview` | в options | `link_preview_options` | відразу |

---

## Скоп розбиття для writing-plans

Очікую 6–8 plans. Орієнтовний порядок:

1. **Foundation** — Menu Router + access + state + force-reply chain + reactions helper + cleanup-policy + replyHTML wrapper
2. **Commands & onboarding** — `setMyCommands` × scopes × locales, menu button, /start редизайн, /help редизайн, onboarding wizard, deep-links
3. **Уніфікація мод-нотифікацій** — `ModEvent` колекція, `mod_event:` локалі, рефактор spam-check / global-ban / spam-vote / report / spam.notification на єдиний шаблон, deprecated alias-и старих ключів
4. **/settings core** — root, антиспам (міграція з `!spam`), мова без прапорів, експорт/скинути, бан-база, бан каналів
5. **/settings advanced** — привітання (тексти/gif з прев'ю), extras grid, журнал (`ModLog`), діагностика
6. **Moderation polish** — `/banan` quick-picker, undo-кнопка, `/del` undo, "як дати права"
7. **Spam-vote polish** — прогрес-бар, пост-результат кнопки, deep-context toast
8. **Stats & dryf polish** — `/mystats` з барами, `/top`/`/top_banan` пагінація, typing-індикатори, empty states, фінальний lint текстів усіх локалей

---

## Тестування

Для кожного plan:

- Unit: тести нових helpers (router, keyboard builders, cleanup-policy, bar(), reactions fallback)
- Integration: реальний chat-fixture з `tests/` patterns (вже є приклади з spam-signals/scripts/etc.)
- Manual smoke: чек-лист сценаріїв per plan, прогон у тестовій групі

Регресія: всі поточні `tests/*.test.js` мають пройти.

---

## Відкриті питання (мінорні, вирішимо при реалізації)

- Чи зберігати `pendingUndelete` (§7) в БД чи тільки in-memory? (in-memory простіше, але при рестарті бота undo губиться)
- Період для тоглу `/top` — потрібно перевірити чи є timestamps у member-stats; якщо ні — фіча відкладається або вимагає окремої міграції
- Емодзі для статусів у §9 — потенційно мапнути на custom-emoji з `emoji-map.js` (premium-кастомки) для консистентності

Ці питання не блокують дизайн і вирішаться у відповідних plan-ах.
