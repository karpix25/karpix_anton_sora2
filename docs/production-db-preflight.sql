-- SOra2 production database preflight checks.
-- Read-only: this file does not modify or delete data.

SELECT
  'projects' AS table_name,
  COUNT(*) AS rows
FROM projects
UNION ALL
SELECT
  'reference_library' AS table_name,
  COUNT(*) AS rows
FROM reference_library
UNION ALL
SELECT
  'generation_tasks' AS table_name,
  COUNT(*) AS rows
FROM generation_tasks
UNION ALL
SELECT
  'sora_system_config' AS table_name,
  COUNT(*) AS rows
FROM sora_system_config;

SELECT
  project_id,
  source_url_key,
  COUNT(*) AS duplicates
FROM reference_library
WHERE COALESCE(source_url_key, '') <> ''
GROUP BY project_id, source_url_key
HAVING COUNT(*) > 1
ORDER BY duplicates DESC, project_id, source_url_key;

SELECT
  telegram_chat_id,
  telegram_topic_id,
  COUNT(*) AS duplicates
FROM projects
WHERE telegram_chat_id <> ''
  AND telegram_topic_id <> ''
GROUP BY telegram_chat_id, telegram_topic_id
HAVING COUNT(*) > 1
ORDER BY duplicates DESC, telegram_chat_id, telegram_topic_id;

SELECT
  status,
  COUNT(*) AS tasks
FROM generation_tasks
GROUP BY status
ORDER BY tasks DESC;

SELECT
  schemaname,
  relname,
  n_live_tup,
  n_dead_tup,
  last_vacuum,
  last_autovacuum,
  last_analyze,
  last_autoanalyze
FROM pg_stat_user_tables
WHERE relname IN ('projects', 'reference_library', 'generation_tasks', 'sora_system_config')
ORDER BY relname;
