# Деплой v2 у Coolify

Образ перевірений локально: старт, persistent-сесія, graceful shutdown на SIGTERM.

## Створення застосунку

1. Coolify → New Resource → із цього git-репозиторію
2. Base directory: `/` (корінь репозиторію), build pack: **Dockerfile**
3. Persistent volume: **`/data`** (там живе mtcute-сесія; без волюма бот
   переавторизовується на кожен деплой і Telegram може тимчасово лочити токен)

## Env-змінні

Обов'язкові (значення з кореневого `.env`):

| Змінна | Звідки |
|---|---|
| `API_ID` | .env |
| `API_HASH` | .env |
| `BOT_TOKEN` | .env (прод-бот) |
| `MONGODB_URI` | **Atlas-URI** (закоментований рядок у .env) — там живі дані |

Опційні (вмикають відповідні шари пайплайна):

| Змінна | Шар |
|---|---|
| `OPENAI_API_KEY` | модерація + вектори (embeddings) |
| `OPENROUTER_API_KEY` | LLM-ескалація сірої зони |
| `QDRANT_URL`, `QDRANT_API_KEY` | семантичний пошук спаму |
| `LLM_CHEAP_MODEL`, `LLM_STRONG_MODEL` | override моделей (є дефолти) |

`SESSION_PATH=/data/session` уже зашитий в образ.

## Порядок перемикання (big-bang)

1. **Stop** на застосунку v1 в Coolify. Не "одночасно": два полери на одному
   токені ділять апдейти випадково — половина спаму пройде повз обидва боти.
2. Deploy + Start v2.
3. У логах має з'явитись `[bot] started as @<ім'я прод-бота>`.
4. Смок у живому чаті: `/start` у ПП, `/settings` у групі (має дати
   діп-лінк у ПП), `/banan` реплаєм.

## Відкат

Stop v2 → Start v1. Дані сумісні в обидва боки: v2 пише у ті самі
v1-колекції (groups/groupmembers/spamsignatures/forwardblacklists),
свої дані тримає в окремих `pipeline_*` колекціях, які v1 не читає.

## Після перемикання

- `pipeline_decisions` (TTL 90 днів) накопичує кожен вердикт — матеріал
  для перекалібрування ваг за реальним трафіком
- v1-застосунок у Coolify не видаляти перші 2 тижні — це і є план відкату
