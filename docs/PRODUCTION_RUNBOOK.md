# SOra2 Production Runbook

This runbook is intentionally conservative: preserve database data first, optimize second.

## 1. Take a Database Backup

Run this before deploying schema or index changes:

```bash
mkdir -p backups
pg_dump "$DATABASE_URL" --format=custom --file="backups/sora2_$(date +%Y%m%d_%H%M%S).dump"
```

Verify that the backup file exists and is not empty:

```bash
ls -lh backups/*.dump
```

Optional restore test on a separate empty database:

```bash
pg_restore --dbname "$RESTORE_TEST_DATABASE_URL" --clean --if-exists backups/sora2_YYYYMMDD_HHMMSS.dump
```

Never restore into production during a deployment test.

## 2. Run Read-Only Preflight Checks

```bash
psql "$DATABASE_URL" --file docs/production-db-preflight.sql
```

Review:

- row counts for `projects`, `reference_library`, `generation_tasks`, `sora_system_config`;
- duplicate Telegram bindings;
- duplicate `reference_library(project_id, source_url_key)` values;
- task status distribution;
- `pg_stat_user_tables` autovacuum/analyze freshness.

The preflight SQL is read-only.

## 3. Deploy the Code

The application startup path must not delete production data. Current startup DDL only creates missing tables, columns, and indexes. It no longer runs `DROP TABLE`, `DROP COLUMN`, `DROP INDEX`, or `TRUNCATE`.

Recommended environment values:

```env
DB_POOL_MAX=10
DB_IDLE_TIMEOUT_MS=30000
DB_CONNECTION_TIMEOUT_MS=10000
DB_STATEMENT_TIMEOUT_MS=120000
DB_QUERY_TIMEOUT_MS=120000
DB_APPLICATION_NAME=sora2
DASHBOARD_PROJECT_HISTORY_LIMIT=500
```

Tune `DB_POOL_MAX` against the database connection limit and number of app replicas.

## 4. Build Indexes Safely

Run the main DB index file on `DATABASE_URL`:

```bash
psql "$DATABASE_URL" --file docs/production-db-indexes.sql
```

The file uses `CREATE INDEX CONCURRENTLY IF NOT EXISTS`. Do not wrap it in `BEGIN`/`COMMIT`.

If `PARSER_DATABASE_URL` points to a separate database and it has `video_stats` or `reels_views_history`, run:

```bash
psql "$PARSER_DATABASE_URL" --file docs/parser-db-indexes.sql
```

## 5. Post-Deploy Checks

```bash
npm run typecheck
curl --silent "$WEB_PUBLIC_URL/api/health"
```

Open the dashboard and verify:

- projects load;
- generation history loads;
- Telegram webhook or polling mode is healthy;
- new generations can move through `pending`, `processing`, and `completed`.

## Rollback Notes

Code rollback does not require deleting indexes. Extra indexes are safe to leave in place unless storage pressure is critical. If rollback needs a database restore, restore only from a verified backup into the intended target database.
