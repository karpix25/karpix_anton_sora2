-- Production PostgreSQL indexes for SOra2.
-- Safe for existing data: this file does not delete, truncate, or drop tables/columns.
-- Run each statement outside an explicit transaction because CREATE INDEX CONCURRENTLY
-- is not allowed inside BEGIN/COMMIT.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_projects_active_automation
ON projects(updated_at DESC)
WHERE is_active = TRUE
  AND automation_enabled = TRUE
  AND daily_generation_limit > 0;

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reference_library_project_created
ON reference_library(project_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reference_library_project_status_created
ON reference_library(project_id, status, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reference_library_project_source
ON reference_library(project_id, source_url_key);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_project_created
ON generation_tasks(project_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_project_status
ON generation_tasks(project_id, status);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_project_billable_created
ON generation_tasks(project_id, created_at DESC)
WHERE status <> 'failed';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_project_auto_created
ON generation_tasks(project_id, trigger_mode, created_at DESC)
WHERE trigger_mode IN ('auto', 'auto_remix');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_recoverable
ON generation_tasks(status, updated_at, created_at)
WHERE status IN ('pending', 'processing');

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_reference_created
ON generation_tasks(reference_library_item_id, created_at DESC);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_project_publication_created
ON generation_tasks(project_id, created_at DESC)
WHERE publication_url <> '';

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_generation_tasks_s3_object_key
ON generation_tasks(s3_object_key);

-- Check duplicate reference URLs before converting this to a unique index.
-- SELECT project_id, source_url_key, COUNT(*)
-- FROM reference_library
-- GROUP BY project_id, source_url_key
-- HAVING COUNT(*) > 1;
