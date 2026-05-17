-- Optional parser PostgreSQL indexes for SOra2.
-- Run this on PARSER_DATABASE_URL only when these tables exist there.
-- Safe for existing data: this file does not delete, truncate, or drop tables/columns.
-- Run each statement outside an explicit transaction.

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_video_stats_url_created_id
ON video_stats(video_url, created_at DESC, id DESC)
INCLUDE (views, publish_date);

CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_reels_views_history_url_created
ON reels_views_history(reel_url, created_at DESC)
INCLUDE (views);
