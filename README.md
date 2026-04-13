# SOra2

Node.js/TypeScript сервис с веб-админкой и Telegram-ботом для генерации и постобработки видео.

## Что уже подготовлено для Coolify

- Добавлен `Dockerfile` (включая `ffmpeg/ffprobe`)
- Добавлен `HEALTHCHECK` на `/api/health`
- Обновлены дефолты сети для контейнера (`WEB_HOST=0.0.0.0`)
- Хранилище проектов/библиотеки/задач переведено на PostgreSQL (`DATABASE_URL`)
- Добавлены `.gitignore` и `.dockerignore`
- Обновлен `.env.example` с безопасными плейсхолдерами

## Деплой через GitHub в Coolify

1. Запушьте проект в GitHub-репозиторий.
2. В Coolify создайте `New Resource -> Application -> Public Repository` (или Private, если репозиторий приватный).
3. Выберите ветку деплоя (обычно `main`).
4. Тип сборки: `Dockerfile`.
5. В `Port` укажите `3000`.
6. В `Health Check Path` укажите `/api/health`.
7. Создайте и подключите PostgreSQL в Coolify, затем укажите `DATABASE_URL` в переменных приложения.
8. Добавьте остальные переменные окружения из `.env.example` со своими значениями.
9. Добавьте постоянный volume:
   - `Source`: managed volume (любое имя, например `sora2-data`)
   - `Target`: `/app/data`
10. Нажмите `Deploy`.

## Важные замечания для продакшена

- Для деплоя в Coolify рекомендуется webhook-режим Telegram (`TELEGRAM_USE_WEBHOOK=true`).
- Если используете polling-режим (`TELEGRAM_USE_WEBHOOK=false`), запускайте **одну** реплику, иначе возможны конфликты `409`.
- Метаданные (проекты, Telegram-привязки, библиотека, задачи) хранятся в PostgreSQL.
- Файлы (изображения/аудио/временные видео) хранятся в `/app/data`, поэтому volume обязателен.
- Если в `Coolify` автоматически выставляется переменная `PORT`, приложение тоже ее поддерживает.
- Для корректных ссылок из Telegram-бота укажите `WEB_PUBLIC_URL` (публичный домен веб-интерфейса).

## Telegram Webhook Env

- `TELEGRAM_USE_WEBHOOK=true` — включает webhook режим.
- `TELEGRAM_WEBHOOK_URL` — публичный HTTPS URL этого приложения, например:
  `https://app.example.com/telegram/webhook/sora2`
- `TELEGRAM_WEBHOOK_SECRET` — длинный случайный секрет, который Telegram будет отправлять в заголовке.
- `TELEGRAM_WEBHOOK_PATH` — путь внутри приложения; должен совпадать с path в `TELEGRAM_WEBHOOK_URL`.

## Команды Бота

- `/create_project <название> [topic-id]` — создать проект и привязать к теме.
- `/bind_project <project-id> [название темы]` — привязать существующий проект к текущей теме.
- `/bind_topic <project-id> <topic-id> [название темы]` — привязать проект к конкретной теме по `topic-id`.
- `/project_status` — показать текущую привязку темы.
- `/settings` — отправляет ссылку на веб-интерфейс проекта.

Фото товара и все настройки проекта теперь ведутся через веб-интерфейс.

## Локальный запуск

```bash
cp .env.example .env
npm install
npm start
```

Сервер здоровья: `GET /api/health`
