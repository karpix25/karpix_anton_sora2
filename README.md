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

- Приложение использует Telegram polling. Запускайте **одну** реплику, иначе возможны конфликты бота.
- Метаданные (проекты, Telegram-привязки, библиотека, задачи) хранятся в PostgreSQL.
- Файлы (изображения/аудио/временные видео) хранятся в `/app/data`, поэтому volume обязателен.
- Если в `Coolify` автоматически выставляется переменная `PORT`, приложение тоже ее поддерживает.

## Локальный запуск

```bash
cp .env.example .env
npm install
npm start
```

Сервер здоровья: `GET /api/health`
