import { randomUUID } from 'node:crypto';
import type {
  ReferenceLibraryInput,
  ReferenceLibraryItem,
  ReferenceLibraryStatus,
  ReferenceTextOverlay,
  ReferenceLibraryUpdate,
} from '../domain/reference-library.js';
import { query } from './db.js';

interface ReferenceLibraryRow {
  id: string;
  project_id: string;
  source_url: string;
  source_url_key: string;
  direct_video_url: string;
  thumbnail_url: string;
  audio_file_path: string;
  audio_stored_at: string;
  audio_s3_bucket: string;
  audio_s3_object_key: string;
  audio_s3_object_url: string;
  audio_s3_stored_at: string;
  duration_seconds: number;
  text_overlays: unknown;
  status: string;
  analysis: string;
  error_message: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function toIsoString(value: unknown, fallback = nowIso()): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = normalizeString(value);
  return normalized || fallback;
}

function normalizeSourceUrlKey(value: unknown): string {
  const source = normalizeString(value);
  if (!source) {
    return '';
  }

  const reelMatch = source.match(/instagram\.com\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/i);
  if (reelMatch?.[1]) {
    return `instagram:${reelMatch[1].toLowerCase()}`;
  }

  return source
    .replace(/[?#].*$/, '')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function normalizeDurationSeconds(value: unknown): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : 0;
}

function normalizeStatus(value: unknown): ReferenceLibraryStatus {
  return value === 'parsing' ||
    value === 'analyzing' ||
    value === 'analyzed' ||
    value === 'failed'
    ? value
    : 'received';
}

function clampPercent(value: unknown, fallback = 0): number {
  const numeric = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(numeric)) {
    return fallback;
  }

  return Math.max(0, Math.min(1, numeric));
}

function normalizeTextOverlays(value: unknown): ReferenceTextOverlay[] {
  if (typeof value === 'string') {
    try {
      return normalizeTextOverlays(JSON.parse(value));
    } catch {
      return [];
    }
  }

  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .map((item, index) => {
      if (!item || typeof item !== 'object') {
        return null;
      }

      const overlay = item as Partial<ReferenceTextOverlay>;
      const text = normalizeString(overlay.text);
      if (!text) {
        return null;
      }

      const anchor = overlay.anchor || 'top-center';
      const validAnchor = anchor === 'top-left' ||
        anchor === 'top-center' ||
        anchor === 'top-right' ||
        anchor === 'center-left' ||
        anchor === 'center' ||
        anchor === 'center-right' ||
        anchor === 'bottom-left' ||
        anchor === 'bottom-center' ||
        anchor === 'bottom-right'
        ? anchor
        : 'top-center';

      const startSeconds = normalizeDurationSeconds(overlay.startSeconds);
      const endSeconds = normalizeDurationSeconds(overlay.endSeconds);
      if (endSeconds <= startSeconds) {
        return null;
      }

      return {
        id: normalizeString(overlay.id) || `overlay-${index + 1}`,
        text,
        startSeconds,
        endSeconds,
        anchor: validAnchor,
        xPercent: clampPercent(overlay.xPercent, 0.5),
        yPercent: clampPercent(overlay.yPercent, 0.12),
        fontSizePercent: clampPercent(overlay.fontSizePercent, 0.04),
        textColor: normalizeString(overlay.textColor) || '#FFFFFF',
        box: Boolean(overlay.box),
        boxColor: normalizeString(overlay.boxColor) || '#000000',
        boxOpacity: Math.max(0, Math.min(1, typeof overlay.boxOpacity === 'number' ? overlay.boxOpacity : Number(overlay.boxOpacity) || 0)),
      } satisfies ReferenceTextOverlay;
    })
    .filter((item): item is ReferenceTextOverlay => Boolean(item));
}

function sanitizeItem(input: ReferenceLibraryInput, existing?: ReferenceLibraryItem): ReferenceLibraryItem {
  const timestamp = nowIso();

  return {
    id: existing?.id ?? randomUUID(),
    projectId: normalizeString(input.projectId ?? existing?.projectId),
    sourceUrl: normalizeString(input.sourceUrl ?? existing?.sourceUrl),
    directVideoUrl: normalizeString(input.directVideoUrl ?? existing?.directVideoUrl),
    thumbnailUrl: normalizeString(input.thumbnailUrl ?? existing?.thumbnailUrl),
    audioFilePath: normalizeString(input.audioFilePath ?? existing?.audioFilePath),
    audioStoredAt: normalizeString(input.audioStoredAt ?? existing?.audioStoredAt),
    audioS3Bucket: normalizeString(input.audioS3Bucket ?? existing?.audioS3Bucket),
    audioS3ObjectKey: normalizeString(input.audioS3ObjectKey ?? existing?.audioS3ObjectKey),
    audioS3ObjectUrl: normalizeString(input.audioS3ObjectUrl ?? existing?.audioS3ObjectUrl),
    audioS3StoredAt: normalizeString(input.audioS3StoredAt ?? existing?.audioS3StoredAt),
    durationSeconds: normalizeDurationSeconds(input.durationSeconds ?? existing?.durationSeconds),
    textOverlays: normalizeTextOverlays(input.textOverlays ?? existing?.textOverlays),
    status: normalizeStatus(input.status ?? existing?.status),
    analysis: normalizeString(input.analysis ?? existing?.analysis),
    errorMessage: normalizeString(input.errorMessage ?? existing?.errorMessage),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function mapRowToItem(row: ReferenceLibraryRow): ReferenceLibraryItem {
  return {
    id: normalizeString(row.id),
    projectId: normalizeString(row.project_id),
    sourceUrl: normalizeString(row.source_url),
    directVideoUrl: normalizeString(row.direct_video_url),
    thumbnailUrl: normalizeString(row.thumbnail_url),
    audioFilePath: normalizeString(row.audio_file_path),
    audioStoredAt: normalizeString(row.audio_stored_at),
    audioS3Bucket: normalizeString(row.audio_s3_bucket),
    audioS3ObjectKey: normalizeString(row.audio_s3_object_key),
    audioS3ObjectUrl: normalizeString(row.audio_s3_object_url),
    audioS3StoredAt: normalizeString(row.audio_s3_stored_at),
    durationSeconds: normalizeDurationSeconds(row.duration_seconds),
    textOverlays: normalizeTextOverlays(row.text_overlays),
    status: normalizeStatus(row.status),
    analysis: normalizeString(row.analysis),
    errorMessage: normalizeString(row.error_message),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export const referenceLibraryStore = {
  async getItem(itemId: string): Promise<ReferenceLibraryItem | null> {
    const result = await query<ReferenceLibraryRow>(
      'SELECT * FROM reference_library WHERE id = $1 LIMIT 1',
      [normalizeString(itemId)]
    );

    return result.rows[0] ? mapRowToItem(result.rows[0]) : null;
  },

  async listProjectItems(projectId: string, options?: { limit?: number }): Promise<ReferenceLibraryItem[]> {
    const limit = options?.limit ? Math.max(1, Math.min(2_000, Math.floor(options.limit))) : 0;
    const result = await query<ReferenceLibraryRow>(
      `
        SELECT *
        FROM reference_library
        WHERE project_id = $1
        ORDER BY created_at DESC
        ${limit ? 'LIMIT $2' : ''}
      `,
      limit ? [normalizeString(projectId), limit] : [normalizeString(projectId)]
    );

    return result.rows.map((row) => mapRowToItem(row));
  },

  async createItem(input: ReferenceLibraryInput): Promise<ReferenceLibraryItem> {
    const item = sanitizeItem(input);

    const result = await query<ReferenceLibraryRow>(
      `
        INSERT INTO reference_library (
          id,
          project_id,
          source_url,
          source_url_key,
          direct_video_url,
          thumbnail_url,
          audio_file_path,
          audio_stored_at,
          audio_s3_bucket,
          audio_s3_object_key,
          audio_s3_object_url,
          audio_s3_stored_at,
          duration_seconds,
          text_overlays,
          status,
          analysis,
          error_message,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14::jsonb, $15, $16, $17, $18::timestamptz, $19::timestamptz
        )
        RETURNING *
      `,
      [
        item.id,
        item.projectId,
        item.sourceUrl,
        normalizeSourceUrlKey(item.sourceUrl),
        item.directVideoUrl,
        item.thumbnailUrl,
        item.audioFilePath,
        item.audioStoredAt,
        item.audioS3Bucket,
        item.audioS3ObjectKey,
        item.audioS3ObjectUrl,
        item.audioS3StoredAt,
        item.durationSeconds,
        JSON.stringify(item.textOverlays),
        item.status,
        item.analysis,
        item.errorMessage,
        item.createdAt,
        item.updatedAt,
      ]
    );

    return mapRowToItem(result.rows[0] as ReferenceLibraryRow);
  },

  async deleteItem(itemId: string): Promise<ReferenceLibraryItem | null> {
    const result = await query<ReferenceLibraryRow>(
      'DELETE FROM reference_library WHERE id = $1 RETURNING *',
      [normalizeString(itemId)]
    );

    return result.rows[0] ? mapRowToItem(result.rows[0]) : null;
  },

  async deleteProjectItems(projectId: string): Promise<void> {
    await query('DELETE FROM reference_library WHERE project_id = $1', [normalizeString(projectId)]);
  },

  async findProjectItemBySourceUrl(projectId: string, sourceUrl: string): Promise<ReferenceLibraryItem | null> {
    const normalizedProjectId = normalizeString(projectId);
    const normalizedSourceKey = normalizeSourceUrlKey(sourceUrl);
    if (!normalizedProjectId || !normalizedSourceKey) {
      return null;
    }

    const result = await query<ReferenceLibraryRow>(
      `
        SELECT *
        FROM reference_library
        WHERE project_id = $1 AND source_url_key = $2
        LIMIT 1
      `,
      [normalizedProjectId, normalizedSourceKey]
    );

    return result.rows[0] ? mapRowToItem(result.rows[0]) : null;
  },

  async updateItem(itemId: string, update: ReferenceLibraryUpdate): Promise<ReferenceLibraryItem | null> {
    const existing = await this.getItem(itemId);
    if (!existing) {
      return null;
    }

    const nextItem = sanitizeItem(
      {
        projectId: existing.projectId,
        sourceUrl: existing.sourceUrl,
        directVideoUrl: update.directVideoUrl ?? existing.directVideoUrl,
        thumbnailUrl: update.thumbnailUrl ?? existing.thumbnailUrl,
        audioFilePath: update.audioFilePath ?? existing.audioFilePath,
        audioStoredAt: update.audioStoredAt ?? existing.audioStoredAt,
        audioS3Bucket: update.audioS3Bucket ?? existing.audioS3Bucket,
        audioS3ObjectKey: update.audioS3ObjectKey ?? existing.audioS3ObjectKey,
        audioS3ObjectUrl: update.audioS3ObjectUrl ?? existing.audioS3ObjectUrl,
        audioS3StoredAt: update.audioS3StoredAt ?? existing.audioS3StoredAt,
        durationSeconds: update.durationSeconds ?? existing.durationSeconds,
        textOverlays: update.textOverlays ?? existing.textOverlays,
        status: update.status ?? existing.status,
        analysis: update.analysis ?? existing.analysis,
        errorMessage: update.errorMessage ?? existing.errorMessage,
      },
      existing
    );

    const result = await query<ReferenceLibraryRow>(
      `
        UPDATE reference_library
        SET
          source_url = $2,
          source_url_key = $3,
          direct_video_url = $4,
          thumbnail_url = $5,
          audio_file_path = $6,
          audio_stored_at = $7,
          audio_s3_bucket = $8,
          audio_s3_object_key = $9,
          audio_s3_object_url = $10,
          audio_s3_stored_at = $11,
          duration_seconds = $12,
          text_overlays = $13::jsonb,
          status = $14,
          analysis = $15,
          error_message = $16,
          updated_at = $17::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [
        nextItem.id,
        nextItem.sourceUrl,
        normalizeSourceUrlKey(nextItem.sourceUrl),
        nextItem.directVideoUrl,
        nextItem.thumbnailUrl,
        nextItem.audioFilePath,
        nextItem.audioStoredAt,
        nextItem.audioS3Bucket,
        nextItem.audioS3ObjectKey,
        nextItem.audioS3ObjectUrl,
        nextItem.audioS3StoredAt,
        nextItem.durationSeconds,
        JSON.stringify(nextItem.textOverlays),
        nextItem.status,
        nextItem.analysis,
        nextItem.errorMessage,
        nextItem.updatedAt,
      ]
    );

    return result.rows[0] ? mapRowToItem(result.rows[0]) : null;
  },
};
