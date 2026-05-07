import { Pool } from 'pg';
import { config } from '../config.js';

export interface ViralVideoInfo {
  url: string;
  views: number;
}

export class ParserService {
  private static pool: Pool | null = null;

  private static getPool(): Pool {
    if (!this.pool) {
      if (!config.parser.dbUrl) {
        throw new Error('PARSER_DATABASE_URL is not configured in .env');
      }
      this.pool = new Pool({
        connectionString: config.parser.dbUrl,
        ssl: { rejectUnauthorized: false }, // Common for Supabase/Heroku
      });
    }
    return this.pool;
  }

  /**
   * Fetches the latest performance data for a list of URLs.
   * Based on previous context, we use 'reels_views_history' table.
   */
  public static async getViralVideos(urls: string[], minViews: number): Promise<ViralVideoInfo[]> {
    if (!urls.length) return [];

    const pool = this.getPool();
    try {
      // Find latest view count for each URL in history
      const result = await pool.query<{ url: string; views: number }>(
        `
        WITH latest_stats AS (
          SELECT 
            reel_url as url, 
            views,
            ROW_NUMBER() OVER (PARTITION BY reel_url ORDER BY created_at DESC) as rn
          FROM reels_views_history
          WHERE reel_url = ANY($1)
        )
        SELECT url, views
        FROM latest_stats
        WHERE rn = 1 AND views >= $2
        `,
        [urls, minViews]
      );

      return result.rows;
    } catch (error: any) {
      console.error('[ParserService] Failed to fetch viral videos:', error.message);
      // If table doesn't exist yet, return empty but don't crash
      if (error.message.includes('relation "reels_views_history" does not exist')) {
        return [];
      }
      throw error;
    }
  }

  public static async getViewCountsMap(urls: string[]): Promise<Record<string, number>> {
    if (!urls.length || !config.parser.dbUrl) return {};

    const pool = this.getPool();
    try {
      const result = await pool.query<{ url: string; views: number }>(
        `
        WITH latest_stats AS (
          SELECT 
            reel_url as url, 
            views,
            ROW_NUMBER() OVER (PARTITION BY reel_url ORDER BY created_at DESC) as rn
          FROM reels_views_history
          WHERE reel_url = ANY($1)
        )
        SELECT url, views
        FROM latest_stats
        WHERE rn = 1
        `,
        [urls]
      );

      const map: Record<string, number> = {};
      for (const row of result.rows) {
        map[row.url] = row.views;
      }
      return map;
    } catch (error: any) {
      console.error('[ParserService] Failed to fetch view counts map:', error.message);
      return {};
    }
  }

  public static async close(): Promise<void> {
    if (this.pool) {
      await this.pool.end();
      this.pool = null;
    }
  }
}
