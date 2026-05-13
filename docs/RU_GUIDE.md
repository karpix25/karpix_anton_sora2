# Инструкция и документация SOra2

Эта инструкция описывает запуск, настройку и ежедневное использование SOra2.

SOra2 помогает делать короткие рекламные видео по Instagram Reels-референсам. Пользователь создает проект, загружает фото товара, отправляет ссылки на Reels в Telegram-тему, а сервис анализирует референсы и запускает генерации через подключенных провайдеров.

## 1. Архитектура

В проект входят четыре основных блока:

- веб-интерфейс - управление проектами, фото, настройками, библиотекой референсов и генерациями;
- Telegram-бот - привязка проектов к темам и прием ссылок на Reels;
- сервисы генерации - OpenRouter/Gemini для анализа и провайдеры видео для генерации;
- хранилища - PostgreSQL, локальная папка `data`, S3 и Яндекс Диск.

Приложение стартует из `src/index.ts`. При запуске оно:

1. читает `.env`;
2. подключается к PostgreSQL;
3. подготавливает схему базы;
4. запускает веб-сервер;
5. запускает восстановление незавершенных задач;
6. запускает автоматическую генерацию;
7. включает Telegram-бота, если задан `TELEGRAM_BOT_TOKEN`.

## 2. Требования

Для локального запуска нужны:

- Node.js 22 или новее;
- npm;
- PostgreSQL;
- `ffmpeg` и `ffprobe`;
- доступ к внешним API, которые указаны в `.env.example`.

Для Docker/Coolify все системные зависимости устанавливаются через `Dockerfile`: `ffmpeg`, Chromium, шрифты и Node.js.

## 3. Локальный запуск

Создайте файл окружения:

```bash
cp .env.example .env
```

Установите зависимости:

```bash
npm install
```

Заполните `.env`. Минимально для старта нужен `DATABASE_URL`. Без ключей внешних сервисов приложение поднимется, но генерация, Telegram и загрузки в облако будут работать ограниченно.

Запустите приложение:

```bash
npm start
```

Для разработки используйте:

```bash
npm run dev
```

Откройте веб-интерфейс:

```text
http://localhost:3000
```

Проверьте health endpoint:

```bash
curl http://localhost:3000/api/health
```

Ответ должен быть:

```json
{ "ok": true }
```

## 4. Настройка `.env`

### PostgreSQL

```env
DATABASE_URL=postgresql://postgres:postgres@localhost:5432/sora2
DATABASE_SSL=false
```

`DATABASE_URL` обязателен. Если база требует SSL, установите `DATABASE_SSL=true` или используйте подходящий `PGSSLMODE`.

### Telegram

```env
TELEGRAM_BOT_TOKEN=your_telegram_bot_token
TELEGRAM_USE_WEBHOOK=false
TELEGRAM_WEBHOOK_URL=https://your-domain.com/telegram/webhook/sora2
TELEGRAM_WEBHOOK_SECRET=replace_with_long_random_secret
TELEGRAM_WEBHOOK_PATH=/telegram/webhook/sora2
TELEGRAM_HANDLER_TIMEOUT_MS=1200000
```

Для локальной разработки обычно удобнее polling:

```env
TELEGRAM_USE_WEBHOOK=false
```

Для продакшена используйте webhook:

```env
TELEGRAM_USE_WEBHOOK=true
```

`TELEGRAM_WEBHOOK_URL` должен быть публичным HTTPS URL. Путь в URL должен совпадать с `TELEGRAM_WEBHOOK_PATH`.

### Веб-интерфейс

```env
WEB_HOST=0.0.0.0
WEB_PORT=3000
WEB_PUBLIC_URL=https://your-domain.com
```

`WEB_PUBLIC_URL` используется в сообщениях Telegram-бота. Укажите публичный домен без завершающего слеша.

### OpenRouter

```env
OPENROUTER_API_KEY=your_openrouter_api_key
OPENROUTER_MODEL_FLASH=google/gemini-2.5-flash
OPENROUTER_MODEL_FLASH_FALLBACK=google/gemini-2.5-pro
OPENROUTER_MODEL_PRO=google/gemini-2.5-pro
OPENROUTER_PROVIDER_ORDER=google-vertex,google-ai-studio
OPENROUTER_ALLOW_FALLBACKS=true
```

OpenRouter используется для анализа референсов и подготовки текста/промптов.

### Провайдеры видео

```env
KIE_AI_API_KEY=your_kie_api_key
COMET_API_KEY=your_comet_api_key
AIHUBMIX_API_KEY=your_aihubmix_key
LAOZHANG_API_KEY=your_laozhang_key
DEFAPI_API_KEY=your_defapi_key
```

Проект поддерживает несколько провайдеров. Конкретный провайдер выбирается сервисами генерации в зависимости от модели, настроек и fallback-логики.

### Хранилища

Яндекс Диск:

```env
YANDEX_TOKEN=your_yandex_disk_oauth_token
```

S3-совместимое хранилище:

```env
S3_ENDPOINT=https://s3.beget.com
S3_REGION=us-east-1
S3_BUCKET=your_bucket_name
S3_ACCESS_KEY_ID=your_s3_access_key
S3_SECRET_ACCESS_KEY=your_s3_secret_key
S3_PUBLIC_BASE_URL=
S3_FORCE_PATH_STYLE=true
```

Яндекс Диск нужен для пользовательских ссылок на финальные видео и референсы. S3 нужен для хранения исходников, аудио и промежуточных файлов.

### Instagram/RapidAPI

```env
RAPIDAPI_KEY=your_rapidapi_key
RAPIDAPI_HOST=instagram-social-api.p.rapidapi.com
IG_API_BASE=https://instagram-social-api.p.rapidapi.com/v1/info
```

Эти переменные нужны для получения данных Instagram Reels.

### Постобработка

```env
FFMPEG_TIMEOUT_MS=1200000
```

Таймаут применяется при финальной сборке видео через ffmpeg.

## 5. Работа в веб-интерфейсе

### Создание проекта

1. Откройте веб-интерфейс.
2. Нажмите "Новый проект".
3. Заполните название проекта.
4. Выберите модель: `sora-2`, `seedance-2`, `veo-3-1` или `grok-imagine`.
5. Выберите режим: ручной или автоматический.
6. При необходимости включите автоматизацию и задайте дневной лимит генераций.
7. Сохраните проект.

После сохранения у проекта появится `project-id`. Он нужен для Telegram-команд.

### Настройки товара

Заполните:

- название товара;
- описание товара;
- целевую аудиторию;
- CTA;
- дополнительные правила промпта;
- язык проекта.

Чем конкретнее описание, тем стабильнее генерация. Укажите материалы, цвет, форму, ограничения по внешнему виду и то, что нельзя менять.

### Фото товара

1. Загрузите одно или несколько фото товара.
2. Выберите основное фото.
3. Синхронизируйте фото с Яндекс Диском, если генерация требует публичный референс.

Первое или выбранное основным изображение используется как главный визуальный референс.

### Оверлеи и CTA

В веб-интерфейсе можно настроить:

- текст финального CTA;
- вертикальный отступ;
- ширину текстового блока;
- горизонтальное положение;
- шрифт;
- размер;
- цвет;
- обводку;
- фон;
- выравнивание;
- межстрочный интервал;
- padding и радиус блока.

Эти настройки применяются при финальной постобработке видео.

### Библиотека референсов

Библиотека заполняется ссылками на Reels, которые приходят из Telegram. Для каждого элемента видны:

- источник;
- статус разбора;
- длительность;
- анализ;
- аудио;
- связанные генерации.

Основные статусы:

- `received` - ссылка получена;
- `parsing` - идет разбор;
- `parsed` - данные получены;
- `analyzing` - идет анализ;
- `analyzed` - референс готов к генерации;
- `failed` - произошла ошибка.

Когда референс получил статус `analyzed`, из него можно запустить генерацию вручную.

### История генераций

В истории отображаются задачи проекта:

- `pending` - задача создана;
- `processing` - задача выполняется;
- `completed` - видео готово;
- `failed` - задача завершилась ошибкой.

Для готовых задач отображаются ссылки на S3 и Яндекс Диск, если загрузка настроена.

### Ремиксы

Для готовой генерации можно запустить ремикс. Сервис возьмет исходную задачу как контекст и создаст новую задачу генерации.

## 6. Работа через Telegram

### Быстрый сценарий

1. Создайте Telegram-группу или форум с темами.
2. Добавьте бота.
3. В нужной теме выполните:

```text
/create_project Название проекта
```

4. Откройте ссылку на веб-интерфейс из ответа бота.
5. Заполните настройки и загрузите фото товара.
6. Отправьте ссылку на Instagram Reel в эту же тему.
7. Дождитесь анализа референса.
8. Запустите генерацию в веб-интерфейсе или дождитесь автоматической генерации, если она включена.

### Команды

```text
/start
```

Показывает краткую справку и ссылку на веб-интерфейс.

```text
/create_project <название> [topic-id]
```

Создает проект и привязывает его к текущей теме. Если команда вызвана не из темы, укажите `topic-id` вручную.

```text
/bind_project <project-id> [название темы]
```

Привязывает существующий проект к текущей теме.

```text
/bind_topic <project-id> <topic-id> [название темы]
```

Привязывает проект к конкретной теме по ID.

```text
/project_status
```

Показывает, какой проект привязан к текущему контексту.

```text
/settings
```

Отправляет ссылку на веб-интерфейс проекта.

### Ограничения Telegram-привязки

Одна тема может быть привязана только к одному проекту. Если тема уже занята, бот вернет ошибку и покажет ID занятого проекта.

Один проект может быть перепривязан к другой теме. В ответе бот покажет старую и новую привязку.

## 7. Автоматическая генерация

Автоматизация настраивается на уровне проекта.

Включите:

- активность проекта;
- режим `auto`;
- `automationEnabled`;
- `dailyGenerationLimit` больше нуля.

Автогенерация работает только если у проекта есть готовые референсы со статусом `analyzed` и успешные генерации, которые можно использовать как основу для повторного использования или ремиксов.

Поля `viralReusePercentage` и `minViewsToReuse` помогают управлять тем, какие успешные материалы стоит переиспользовать.

## 8. Деплой в Coolify

Проект подготовлен для Docker-деплоя.

### Настройка приложения

1. Загрузите проект в GitHub.
2. В Coolify создайте новое приложение.
3. Выберите репозиторий и ветку.
4. Укажите сборку через `Dockerfile`.
5. Укажите порт `3000`.
6. Укажите health check path `/api/health`.
7. Добавьте переменные окружения из `.env.example`.
8. Подключите PostgreSQL и задайте `DATABASE_URL`.
9. Добавьте volume `/app/data`.
10. Запустите деплой.

### Volume

Добавьте постоянный volume:

```text
Source: sora2-data
Target: /app/data
```

Без volume приложение потеряет загруженные изображения, временные файлы, аудио и кеши при пересоздании контейнера.

### Telegram webhook

Для продакшена используйте:

```env
TELEGRAM_USE_WEBHOOK=true
TELEGRAM_WEBHOOK_URL=https://your-domain.com/telegram/webhook/sora2
TELEGRAM_WEBHOOK_PATH=/telegram/webhook/sora2
TELEGRAM_WEBHOOK_SECRET=long_random_secret
WEB_PUBLIC_URL=https://your-domain.com
```

После старта приложение само вызовет `setWebhook`.

### Polling

Polling допустим для локальной разработки:

```env
TELEGRAM_USE_WEBHOOK=false
```

В polling-режиме запускайте одну реплику. Несколько реплик могут вызвать Telegram-ошибку `409 Conflict`.

## 9. API

Веб-интерфейс использует JSON API.

### Системные endpoints

```http
GET /api/health
```

Проверка здоровья сервиса.

```http
GET /api/system/config
PUT /api/system/config
```

Чтение и обновление системных настроек.

```http
GET /api/fonts/google-cyrillic
```

Список Google Fonts с поддержкой кириллицы.

```http
GET /api/dashboard/history
```

Сводная история по проектам, референсам и генерациям.

### Проекты

```http
GET /api/projects
POST /api/projects
GET /api/projects/:projectId
PUT /api/projects/:projectId
DELETE /api/projects/:projectId
```

Управление проектами.

### Изображения

```http
POST /api/uploads/reference-images
DELETE /api/uploads/reference-images/:storedName
POST /api/projects/:projectId/reference-images/:imageId/primary
DELETE /api/projects/:projectId/reference-images/:imageId
POST /api/projects/:projectId/reference-images/sync-yandex
POST /api/projects/:projectId/reference-images/primary/sync-telegram
```

Загрузка, удаление, выбор основного изображения и синхронизация.

### Библиотека референсов

```http
GET /api/projects/:projectId/library
DELETE /api/projects/:projectId/library/:itemId
POST /api/projects/:projectId/library/:itemId/generate
```

Чтение библиотеки, удаление референса и запуск ручной генерации.

### Генерации

```http
GET /api/projects/:projectId/generations
POST /api/tasks/:taskId/remix
```

История генераций и запуск ремикса.

### Webhook публикаций

```http
POST /api/webhooks/publications
```

Endpoint принимает:

```json
{
  "taskId": "task-id-or-short-id",
  "publicationUrl": "https://..."
}
```

Он сохраняет ссылку на опубликованный пост в задаче генерации.

## 10. Структура проекта

```text
src/
  bot/                 Telegram-бот
  domain/              TypeScript-типы доменных сущностей
  services/            Интеграции и бизнес-логика
  storage/             PostgreSQL-хранилища
  web/                 HTTP-сервер и статическая админка
data/                  Локальные данные, загрузки, кеши и временные файлы
scratch/               Разовые скрипты и миграции
test/                  Тестовые медиафайлы
```

В репозитории также есть сгенерированные `.js`, `.d.ts` и `.map` файлы рядом с TypeScript-исходниками.

## 11. Модели данных

### Project

Проект хранит:

- ID и код проекта;
- Telegram chat/topic binding;
- название и описание товара;
- целевую аудиторию и CTA;
- язык;
- режим генерации;
- дневной лимит;
- выбранную модель;
- фото товара;
- настройки текстового стиля;
- настройки Яндекс Диска;
- даты создания и обновления.

### ReferenceLibraryItem

Элемент библиотеки хранит:

- ссылку на Reel;
- прямую ссылку на видео;
- thumbnail;
- аудио;
- длительность;
- найденные текстовые оверлеи;
- статус анализа;
- результат анализа;
- ошибку, если она была.

### GenerationTask

Задача генерации хранит:

- проект;
- референс;
- режим запуска;
- статус;
- целевую модель;
- провайдера;
- prompt;
- ссылку на результат;
- S3-данные;
- Яндекс Диск путь;
- ссылку на публикацию;
- ошибку;
- даты старта и завершения.

## 12. Типовые проблемы

### Приложение не стартует

Проверьте `DATABASE_URL`. Без PostgreSQL приложение завершит запуск с ошибкой.

### Health check не проходит

Проверьте, что приложение слушает правильный порт. Coolify может передавать `PORT`, а приложение также поддерживает `WEB_PORT`.

### Telegram webhook не получает события

Проверьте:

- `TELEGRAM_USE_WEBHOOK=true`;
- `TELEGRAM_WEBHOOK_URL` является публичным HTTPS URL;
- путь в `TELEGRAM_WEBHOOK_URL` совпадает с `TELEGRAM_WEBHOOK_PATH`;
- домен открывается извне;
- `TELEGRAM_WEBHOOK_SECRET` совпадает с секретом, который Telegram отправляет в заголовке.

### Telegram polling возвращает `409 Conflict`

Скорее всего, запущено несколько экземпляров бота. Оставьте одну реплику или переключитесь на webhook.

### Референс не анализируется

Проверьте:

- `RAPIDAPI_KEY`;
- доступность Instagram API;
- корректность ссылки на Reel;
- ключ `OPENROUTER_API_KEY`;
- логи приложения.

### Генерация падает

Проверьте ключи провайдеров:

- `KIE_AI_API_KEY`;
- `COMET_API_KEY`;
- `DEFAPI_API_KEY`;
- `AIHUBMIX_API_KEY`;
- `LAOZHANG_API_KEY`.

Также проверьте, что у проекта есть основное фото товара и оно синхронизировано, если модель требует публичный URL.

### Нет ссылки на финальное видео

Проверьте:

- `YANDEX_TOKEN`;
- права приложения на Яндекс Диск;
- настройки S3;
- наличие volume `/app/data`;
- логи загрузки.

### Пропали локальные файлы после деплоя

Проверьте, что в Coolify подключен volume к `/app/data`.

## 13. Безопасность

- Не коммитьте реальный `.env`.
- Используйте длинный `TELEGRAM_WEBHOOK_SECRET`.
- Ограничьте доступ к S3-ключам.
- Храните `DATABASE_URL` и API-ключи только в секретах окружения.
- Для продакшена используйте HTTPS.

## 14. Обслуживание

Регулярно проверяйте:

- свободное место в volume `/app/data`;
- размер S3 bucket;
- лимиты Яндекс Диска;
- логи ошибок провайдеров генерации;
- очереди задач со статусами `pending` и `processing`.

Перед обновлением приложения сделайте резервную копию PostgreSQL и убедитесь, что volume `/app/data` не удаляется при redeploy.
