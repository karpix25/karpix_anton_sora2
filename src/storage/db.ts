import { Pool, type QueryResult, type QueryResultRow } from 'pg';

let pool: Pool | null = null;
let initialized = false;

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function shouldUseSsl(): boolean {
  const raw = normalizeString(process.env.PGSSLMODE || process.env.DATABASE_SSL).toLowerCase();
  return raw === 'require' || raw === 'true' || raw === '1' || raw === 'yes';
}

function getDatabaseUrl(): string {
  const databaseUrl = normalizeString(process.env.DATABASE_URL);
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required. Configure PostgreSQL connection string in environment variables.');
  }

  return databaseUrl;
}

function getPool(): Pool {
  if (!pool) {
    pool = new Pool({
      connectionString: getDatabaseUrl(),
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
    });
  }

  return pool;
}

export async function query<T extends QueryResultRow = QueryResultRow>(
  sql: string,
  params: unknown[] = []
): Promise<QueryResult<T>> {
  return getPool().query<T>(sql, params);
}

export async function initDatabase(): Promise<void> {
  if (initialized) {
    return;
  }

  const db = getPool();

  await db.query(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      telegram_topic_id TEXT NOT NULL DEFAULT '',
      telegram_topic_name TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      product_description TEXT NOT NULL DEFAULT '',
      extra_prompting_rules TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT '',
      cta TEXT NOT NULL DEFAULT '',
      mode TEXT NOT NULL DEFAULT 'manual',
      automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      daily_generation_limit INTEGER NOT NULL DEFAULT 1,
      selected_model TEXT NOT NULL DEFAULT 'sora-2',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
      trim_video_to_audio BOOLEAN NOT NULL DEFAULT FALSE,
      primary_reference_image_id TEXT NOT NULL DEFAULT '',
      reference_images JSONB NOT NULL DEFAULT '[]'::jsonb,
      text_style JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS text_style JSONB NOT NULL DEFAULT '{}'::jsonb;
  `);

  await db.query(`
    ALTER TABLE projects ADD COLUMN IF NOT EXISTS trim_video_to_audio BOOLEAN NOT NULL DEFAULT FALSE;
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS reference_library (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      source_url TEXT NOT NULL,
      source_url_key TEXT NOT NULL,
      direct_video_url TEXT NOT NULL DEFAULT '',
      thumbnail_url TEXT NOT NULL DEFAULT '',
      audio_file_path TEXT NOT NULL DEFAULT '',
      audio_stored_at TEXT NOT NULL DEFAULT '',
      duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      text_overlays JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'received',
      analysis TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      reference_library_item_id TEXT NOT NULL REFERENCES reference_library(id) ON DELETE CASCADE,
      trigger_mode TEXT NOT NULL DEFAULT 'web_manual',
      status TEXT NOT NULL DEFAULT 'pending',
      target_model TEXT NOT NULL DEFAULT 'sora-2',
      provider TEXT NOT NULL DEFAULT 'kie',
      provider_task_id TEXT NOT NULL DEFAULT '',
      prompt_text TEXT NOT NULL DEFAULT '',
      result_video_url TEXT NOT NULL DEFAULT '',
      yandex_disk_path TEXT NOT NULL DEFAULT '',
      yandex_download_url TEXT NOT NULL DEFAULT '',
      stored_at TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at
      ON projects(updated_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_telegram_binding
      ON projects(telegram_chat_id, telegram_topic_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_reference_library_project_created
      ON reference_library(project_id, created_at DESC);
  `);

  await db.query(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_reference_library_project_source
      ON reference_library(project_id, source_url_key);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_created
      ON generation_tasks(project_id, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_reference_created
      ON generation_tasks(reference_library_item_id, created_at DESC);
  `);

  initialized = true;
}

export async function closeDatabase(): Promise<void> {
  if (!pool) {
    return;
  }

  await pool.end();
  pool = null;
  initialized = false;
}
