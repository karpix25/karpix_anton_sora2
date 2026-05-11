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
        throw new Error('PARSER_DATABASE_URL or DATABASE_URL is not configured in .env');
      }
      this.pool = new Pool({
        connectionString: config.parser.dbUrl,
        ssl: { rejectUnauthorized: false }, // Common for Supabase/Heroku
      });
    }
    return this.pool;
  }

  private static isMissingRelationError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    return message.includes('does not exist') || error?.code === '42P01';
  }

  private static isMissingStatsSchemaError(error: any): boolean {
    const message = String(error?.message || '').toLowerCase();
    return this.isMissingRelationError(error) ||
      error?.code === '42703' ||
      message.includes('column') && message.includes('does not exist');
  }

  private static async getViralVideosFromVideoStats(
    pool: Pool,
    urls: string[],
    minViews: number
  ): Promise<ViralVideoInfo[]> {
    const result = await pool.query<{ url: string; views: number }>(
      `
      WITH latest_stats AS (
        SELECT
          "Video URL" AS url,
          COALESCE("Views", 0)::integer AS views,
          ROW_NUMBER() OVER (
            PARTITION BY "Video URL"
            ORDER BY "Created At" DESC NULLS LAST, "ID" DESC NULLS LAST
          ) AS rn
        FROM "Video Stats"
        WHERE "Video URL" = ANY($1)
      )
      SELECT url, views
      FROM latest_stats
      WHERE rn = 1 AND views >= $2
      `,
      [urls, minViews]
    );

    return result.rows;
  }

  private static async getViewCountsMapFromVideoStats(
    pool: Pool,
    urls: string[]
  ): Promise<Record<string, number>> {
    const result = await pool.query<{ url: string; views: number }>(
      `
      WITH latest_stats AS (
        SELECT
          "Video URL" AS url,
          COALESCE("Views", 0)::integer AS views,
          ROW_NUMBER() OVER (
            PARTITION BY "Video URL"
            ORDER BY "Created At" DESC NULLS LAST, "ID" DESC NULLS LAST
          ) AS rn
        FROM "Video Stats"
        WHERE "Video URL" = ANY($1)
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
  }

  private static async getViralVideosFromLegacyHistory(
    pool: Pool,
    urls: string[],
    minViews: number
  ): Promise<ViralVideoInfo[]> {
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
  }

  private static async getViewCountsMapFromLegacyHistory(
    pool: Pool,
    urls: string[]
  ): Promise<Record<string, number>> {
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
  }

  /**
   * Fetches the latest performance data for a list of URLs.
   * Primary source: "Video Stats" table, matching by "Video URL".
   * Legacy fallback: reels_views_history.reel_url.
   */
  public static async getViralVideos(urls: string[], minViews: number): Promise<ViralVideoInfo[]> {
    if (!urls.length) return [];

    const pool = this.getPool();
    try {
      return await this.getViralVideosFromVideoStats(pool, urls, minViews);
    } catch (error: any) {
      if (this.isMissingStatsSchemaError(error)) {
        console.warn('[ParserService] "Video Stats" table is unavailable, falling back to reels_views_history.');
        try {
          return await this.getViralVideosFromLegacyHistory(pool, urls, minViews);
        } catch (legacyError: any) {
          if (this.isMissingStatsSchemaError(legacyError)) {
            console.warn('[ParserService] Legacy views history schema is unavailable. Viral remix will skip stats for now.');
            return [];
          }
          console.error('[ParserService] Failed to fetch viral videos from legacy history:', legacyError.message);
          throw legacyError;
        }
      }

      console.error('[ParserService] Failed to fetch viral videos from Video Stats:', error.message);
      throw error;
    }
  }

  public static async getViewCountsMap(urls: string[]): Promise<Record<string, number>> {
    if (!urls.length || !config.parser.dbUrl) return {};

    const pool = this.getPool();
    try {
      return await this.getViewCountsMapFromVideoStats(pool, urls);
    } catch (error: any) {
      if (this.isMissingStatsSchemaError(error)) {
        console.warn('[ParserService] "Video Stats" table is unavailable, falling back to reels_views_history.');
        try {
          return await this.getViewCountsMapFromLegacyHistory(pool, urls);
        } catch (legacyError: any) {
          if (this.isMissingStatsSchemaError(legacyError)) {
            console.warn('[ParserService] Legacy views history schema is unavailable. Returning empty view counts.');
            return {};
          }
          console.error('[ParserService] Failed to fetch view counts map from legacy history:', legacyError.message);
          return {};
        }
      }

      console.error('[ParserService] Failed to fetch view counts map from Video Stats:', error.message);
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
