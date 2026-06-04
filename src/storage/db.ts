import { Pool, type PoolConfig, type QueryResult, type QueryResultRow } from 'pg';

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

function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
}

function getPool(): Pool {
  if (!pool) {
    const poolConfig: PoolConfig = {
      connectionString: getDatabaseUrl(),
      ssl: shouldUseSsl() ? { rejectUnauthorized: false } : undefined,
      max: parsePositiveInteger(process.env.DB_POOL_MAX, 10),
      idleTimeoutMillis: parsePositiveInteger(process.env.DB_IDLE_TIMEOUT_MS, 30_000),
      connectionTimeoutMillis: parsePositiveInteger(process.env.DB_CONNECTION_TIMEOUT_MS, 10_000),
      statement_timeout: parsePositiveInteger(process.env.DB_STATEMENT_TIMEOUT_MS, 120_000),
      query_timeout: parsePositiveInteger(process.env.DB_QUERY_TIMEOUT_MS, 120_000),
      application_name: normalizeString(process.env.DB_APPLICATION_NAME) || 'sora2',
    };

    pool = new Pool(poolConfig);
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
      project_code TEXT NOT NULL DEFAULT '',
      name TEXT NOT NULL,
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      telegram_topic_id TEXT NOT NULL DEFAULT '',
      telegram_topic_name TEXT NOT NULL DEFAULT '',
      product_name TEXT NOT NULL DEFAULT '',
      product_description TEXT NOT NULL DEFAULT '',
      extra_prompting_rules TEXT NOT NULL DEFAULT '',
      target_audience TEXT NOT NULL DEFAULT '',
      cta TEXT NOT NULL DEFAULT '',
      project_language TEXT NOT NULL DEFAULT 'ru',
      mode TEXT NOT NULL DEFAULT 'manual',
      automation_enabled BOOLEAN NOT NULL DEFAULT FALSE,
      daily_generation_limit INTEGER NOT NULL DEFAULT 1,
      package_video_limit INTEGER NOT NULL DEFAULT 0,
      selected_model TEXT NOT NULL DEFAULT 'sora-2',
      is_active BOOLEAN NOT NULL DEFAULT TRUE,
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
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_code TEXT NOT NULL DEFAULT ''`);
  await db.query(`
    UPDATE projects
    SET project_code = UPPER(SUBSTRING(MD5(id) FROM 1 FOR 8))
    WHERE COALESCE(project_code, '') = '';
  `);

  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_frame_text TEXT DEFAULT ''`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_frame_vertical_margin INTEGER DEFAULT 320`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_frame_width_percent INTEGER DEFAULT 50`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS end_frame_x_percent INTEGER DEFAULT 50`);
  
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS viral_reuse_percentage INTEGER DEFAULT 0`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS min_views_to_reuse INTEGER DEFAULT 1000`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS max_viral_age_days INTEGER DEFAULT 30`);
  await db.query(`ALTER TABLE projects ALTER COLUMN max_viral_age_days SET DEFAULT 30`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS yandex_disk_folder TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS project_language TEXT NOT NULL DEFAULT 'ru'`);
  await db.query(`ALTER TABLE projects ADD COLUMN IF NOT EXISTS package_video_limit INTEGER NOT NULL DEFAULT 0`);
  
  // Disable outline by default in all existing projects as requested (One-time, commented out for stability)
  // await db.query(`UPDATE projects SET text_style = text_style || '{"outlineEnabled": false}'::jsonb`);

  // Switch all projects to sora-2 as requested (One-time, commented out for stability)
  // await db.query(`UPDATE projects SET selected_model = 'sora-2'`);

  // Update system config to ensure 8s duration default (One-time, commented out for stability)
  // await db.query(`UPDATE sora_system_config SET config = config || '{"defaultVideoModel": "sora-2", "grokDuration": 8}'::jsonb WHERE id = 'global'`);


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
      audio_s3_bucket TEXT NOT NULL DEFAULT '',
      audio_s3_object_key TEXT NOT NULL DEFAULT '',
      audio_s3_object_url TEXT NOT NULL DEFAULT '',
      audio_s3_stored_at TEXT NOT NULL DEFAULT '',
      duration_seconds DOUBLE PRECISION NOT NULL DEFAULT 0,
      text_overlays JSONB NOT NULL DEFAULT '[]'::jsonb,
      status TEXT NOT NULL DEFAULT 'received',
      analysis TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS audio_s3_bucket TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS audio_s3_object_key TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS audio_s3_object_url TEXT NOT NULL DEFAULT ''`);
  await db.query(`ALTER TABLE reference_library ADD COLUMN IF NOT EXISTS audio_s3_stored_at TEXT NOT NULL DEFAULT ''`);

  await db.query(`
    CREATE TABLE IF NOT EXISTS generation_tasks (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
      reference_library_item_id TEXT NOT NULL REFERENCES reference_library(id) ON DELETE CASCADE,
      remix_source_task_id TEXT NOT NULL DEFAULT '',
      remix_source_url TEXT NOT NULL DEFAULT '',
      trigger_mode TEXT NOT NULL DEFAULT 'web_manual',
      status TEXT NOT NULL DEFAULT 'pending',
      target_model TEXT NOT NULL DEFAULT 'sora-2',
      provider TEXT NOT NULL DEFAULT 'kie',
      provider_task_id TEXT NOT NULL DEFAULT '',
      prompt_text TEXT NOT NULL DEFAULT '',
      result_video_url TEXT NOT NULL DEFAULT '',
      video_file_name TEXT NOT NULL DEFAULT '',
      video_description TEXT NOT NULL DEFAULT '',
      overlay_texts JSONB NOT NULL DEFAULT '[]'::jsonb,
      yandex_disk_path TEXT NOT NULL DEFAULT '',
      yandex_download_url TEXT NOT NULL DEFAULT '',
      s3_bucket TEXT NOT NULL DEFAULT '',
      s3_object_key TEXT NOT NULL DEFAULT '',
      s3_object_url TEXT NOT NULL DEFAULT '',
      s3_stored_at TEXT NOT NULL DEFAULT '',
      stored_at TEXT NOT NULL DEFAULT '',
      error_message TEXT NOT NULL DEFAULT '',
      started_at TEXT NOT NULL DEFAULT '',
      finished_at TEXT NOT NULL DEFAULT '',
      publication_url TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS telegram_file_deliveries (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL DEFAULT '',
      project_name TEXT NOT NULL DEFAULT '',
      task_id TEXT NOT NULL DEFAULT '',
      reference_library_item_id TEXT NOT NULL DEFAULT '',
      file_kind TEXT NOT NULL DEFAULT '',
      file_name TEXT NOT NULL DEFAULT '',
      file_url TEXT NOT NULL DEFAULT '',
      telegram_file_id TEXT NOT NULL DEFAULT '',
      telegram_message_id TEXT NOT NULL DEFAULT '',
      telegram_chat_id TEXT NOT NULL DEFAULT '',
      telegram_chat_title TEXT NOT NULL DEFAULT '',
      telegram_topic_id TEXT NOT NULL DEFAULT '',
      telegram_topic_name TEXT NOT NULL DEFAULT '',
      recipient_user_id TEXT NOT NULL DEFAULT '',
      recipient_username TEXT NOT NULL DEFAULT '',
      recipient_name TEXT NOT NULL DEFAULT '',
      delivery_source TEXT NOT NULL DEFAULT '',
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_telegram_file_deliveries_project_created
      ON telegram_file_deliveries(project_id, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_telegram_file_deliveries_task_created
      ON telegram_file_deliveries(task_id, created_at DESC);
  `);

  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS publication_url TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS remix_source_task_id TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS remix_source_url TEXT NOT NULL DEFAULT '';
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_updated_at
      ON projects(updated_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_project_code
      ON projects(project_code);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_telegram_binding
      ON projects(telegram_chat_id, telegram_topic_id);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_projects_active_automation
      ON projects(updated_at DESC)
      WHERE is_active = TRUE
        AND automation_enabled = TRUE
        AND daily_generation_limit > 0;
  `);

  await db.query(`
    DO $$
    BEGIN
      IF NOT EXISTS (
        SELECT 1
        FROM projects
        WHERE telegram_chat_id <> '' AND telegram_topic_id <> ''
        GROUP BY telegram_chat_id, telegram_topic_id
        HAVING COUNT(*) > 1
      ) THEN
        CREATE UNIQUE INDEX IF NOT EXISTS idx_projects_telegram_binding_unique
          ON projects(telegram_chat_id, telegram_topic_id)
          WHERE telegram_chat_id <> '' AND telegram_topic_id <> '';
      ELSE
        RAISE WARNING 'Duplicate Telegram project bindings found. Unique binding index was not created.';
      END IF;
    END $$;
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_reference_library_project_created
      ON reference_library(project_id, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_reference_library_project_status_created
      ON reference_library(project_id, status, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_reference_library_project_source
      ON reference_library(project_id, source_url_key);
  `);

  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS video_file_name TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS video_description TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS overlay_texts JSONB NOT NULL DEFAULT '[]'::jsonb;
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS s3_bucket TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS s3_object_key TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS s3_object_url TEXT NOT NULL DEFAULT '';
  `);
  await db.query(`
    ALTER TABLE generation_tasks ADD COLUMN IF NOT EXISTS s3_stored_at TEXT NOT NULL DEFAULT '';
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_created
      ON generation_tasks(project_id, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_status
      ON generation_tasks(project_id, status);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_billable_created
      ON generation_tasks(project_id, created_at DESC)
      WHERE status <> 'failed';
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_auto_created
      ON generation_tasks(project_id, trigger_mode, created_at DESC)
      WHERE trigger_mode IN ('auto', 'auto_remix');
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_recoverable
      ON generation_tasks(status, updated_at, created_at)
      WHERE status IN ('pending', 'processing', 'pending_download');
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_reference_created
      ON generation_tasks(reference_library_item_id, created_at DESC);
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_project_publication_created
      ON generation_tasks(project_id, created_at DESC)
      WHERE publication_url <> '';
  `);

  await db.query(`
    CREATE INDEX IF NOT EXISTS idx_generation_tasks_s3_object_key
      ON generation_tasks(s3_object_key);
  `);

  await db.query(`
    CREATE TABLE IF NOT EXISTS sora_system_config (
      id TEXT PRIMARY KEY,
      config JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  await db.query(`ALTER TABLE sora_system_config ADD COLUMN IF NOT EXISTS id TEXT`);
  await db.query(`ALTER TABLE sora_system_config ADD COLUMN IF NOT EXISTS config JSONB NOT NULL DEFAULT '{}'::jsonb`);
  await db.query(`ALTER TABLE sora_system_config ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()`);
  await db.query(`
    UPDATE sora_system_config
    SET id = 'global'
    WHERE COALESCE(id, '') = '';
  `);

  // Ensure global config exists
  await db.query(`
    INSERT INTO sora_system_config (id, config)
    SELECT 'global', '{"forceGrokImagine": false, "grokMode": "normal", "grokResolution": "720p"}'::jsonb
    WHERE NOT EXISTS (
      SELECT 1
      FROM sora_system_config
      WHERE id = 'global'
    );
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
