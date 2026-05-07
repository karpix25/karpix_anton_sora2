import { randomUUID } from 'node:crypto';
import type { GenerationProvider, GenerationTask, GenerationTaskInput, GenerationTaskStatus, GenerationTaskUpdate } from '../domain/generation-task.js';
import type { ReferenceTextOverlay } from '../domain/reference-library.js';
import { query } from './db.js';

interface GenerationTaskRow {
  id: string;
  project_id: string;
  reference_library_item_id: string;
  trigger_mode: string;
  status: string;
  target_model: string;
  provider: string;
  provider_task_id: string;
  prompt_text: string;
  result_video_url: string;
  video_file_name: string;
  video_description: string;
  overlay_texts: unknown;
  yandex_disk_path: string;
  yandex_download_url: string;
  s3_bucket: string;
  s3_object_key: string;
  s3_object_url: string;
  s3_stored_at: string;
  stored_at: string;
  error_message: string;
  started_at: string;
  finished_at: string;
  publication_url: string;
  created_at: Date | string;
  updated_at: Date | string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function parseOverlayTexts(value: unknown): ReferenceTextOverlay[] {
  if (typeof value === 'string') {
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? (parsed as ReferenceTextOverlay[]) : [];
    } catch {
      return [];
    }
  }

  return Array.isArray(value) ? (value as ReferenceTextOverlay[]) : [];
}

function toIsoString(value: unknown, fallback = nowIso()): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = normalizeString(value);
  return normalized || fallback;
}

function normalizeStatus(value: unknown): GenerationTaskStatus {
  return value === 'processing' || value === 'completed' || value === 'failed' ? value : 'pending';
}

function normalizeProvider(value: unknown): GenerationProvider {
  const providers: GenerationProvider[] = ['kie', 'aihubmix', 'laozhang', 'defapi', 'defapi-stable', 'comet'];
  if (typeof value === 'string' && (providers as string[]).includes(value)) {
    return value as GenerationProvider;
  }
  return 'kie';
}

function sanitizeTask(input: GenerationTaskInput, existing?: GenerationTask): GenerationTask {
  const timestamp = nowIso();

  return {
    id: existing?.id ?? randomUUID(),
    projectId: normalizeString(input.projectId ?? existing?.projectId),
    referenceLibraryItemId: normalizeString(input.referenceLibraryItemId ?? existing?.referenceLibraryItemId),
    triggerMode: input.triggerMode ?? existing?.triggerMode ?? 'web_manual',
    status: normalizeStatus(input.status ?? existing?.status),
    targetModel: input.targetModel ?? existing?.targetModel ?? 'sora-2',
    provider: normalizeProvider(input.provider ?? existing?.provider),
    providerTaskId: normalizeString(input.providerTaskId ?? existing?.providerTaskId),
    promptText: normalizeString(input.promptText ?? existing?.promptText),
    resultVideoUrl: normalizeString(input.resultVideoUrl ?? existing?.resultVideoUrl),
    videoFileName: normalizeString(input.videoFileName ?? existing?.videoFileName),
    videoDescription: normalizeString(input.videoDescription ?? existing?.videoDescription),
    overlayTexts: Array.isArray(input.overlayTexts ?? existing?.overlayTexts)
      ? ((input.overlayTexts ?? existing?.overlayTexts) as ReferenceTextOverlay[])
      : [],
    yandexDiskPath: normalizeString(input.yandexDiskPath ?? existing?.yandexDiskPath),
    yandexDownloadUrl: normalizeString(input.yandexDownloadUrl ?? existing?.yandexDownloadUrl),
    s3Bucket: normalizeString(input.s3Bucket ?? existing?.s3Bucket),
    s3ObjectKey: normalizeString(input.s3ObjectKey ?? existing?.s3ObjectKey),
    s3ObjectUrl: normalizeString(input.s3ObjectUrl ?? existing?.s3ObjectUrl),
    s3StoredAt: normalizeString(input.s3StoredAt ?? existing?.s3StoredAt),
    storedAt: normalizeString(input.storedAt ?? existing?.storedAt),
    errorMessage: normalizeString(input.errorMessage ?? existing?.errorMessage),
    startedAt: normalizeString(input.startedAt ?? existing?.startedAt),
    finishedAt: normalizeString(input.finishedAt ?? existing?.finishedAt),
    publicationUrl: normalizeString(input.publicationUrl ?? existing?.publicationUrl),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function mapRowToTask(row: GenerationTaskRow): GenerationTask {
  return {
    id: normalizeString(row.id),
    projectId: normalizeString(row.project_id),
    referenceLibraryItemId: normalizeString(row.reference_library_item_id),
    triggerMode: row.trigger_mode === 'telegram_manual' ? 'telegram_manual' : 'web_manual',
    status: normalizeStatus(row.status),
    targetModel: row.target_model === 'veo-3-1' ? 'veo-3-1' : 'sora-2',
    provider: normalizeProvider(row.provider),
    providerTaskId: normalizeString(row.provider_task_id),
    promptText: normalizeString(row.prompt_text),
    resultVideoUrl: normalizeString(row.result_video_url),
    videoFileName: normalizeString(row.video_file_name),
    videoDescription: normalizeString(row.video_description),
    overlayTexts: parseOverlayTexts(row.overlay_texts),
    yandexDiskPath: normalizeString(row.yandex_disk_path),
    yandexDownloadUrl: normalizeString(row.yandex_download_url),
    s3Bucket: normalizeString(row.s3_bucket),
    s3ObjectKey: normalizeString(row.s3_object_key),
    s3ObjectUrl: normalizeString(row.s3_object_url),
    s3StoredAt: normalizeString(row.s3_stored_at),
    storedAt: normalizeString(row.stored_at),
    errorMessage: normalizeString(row.error_message),
    startedAt: normalizeString(row.started_at),
    finishedAt: normalizeString(row.finished_at),
    publicationUrl: normalizeString(row.publication_url),
    createdAt: toIsoString(row.created_at),
    updatedAt: toIsoString(row.updated_at),
  };
}

export const generationTaskStore = {
  async getTask(taskId: string): Promise<GenerationTask | null> {
    const result = await query<GenerationTaskRow>(
      'SELECT * FROM generation_tasks WHERE id = $1 LIMIT 1',
      [normalizeString(taskId)]
    );

    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  },

  async findByShortId(shortId: string): Promise<GenerationTask | null> {
    const result = await query<GenerationTaskRow>(
      'SELECT * FROM generation_tasks WHERE id::text LIKE $1 LIMIT 1',
      [`${normalizeString(shortId)}%`]
    );

    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  },

  async listRecoverableTasks(input?: {
    limit?: number;
    pendingOlderThanSeconds?: number;
    processingOlderThanSeconds?: number;
  }): Promise<GenerationTask[]> {
    const limit = Math.max(1, Math.min(200, input?.limit ?? 50));
    const pendingOlderThanSeconds = Math.max(0, input?.pendingOlderThanSeconds ?? 20);
    const processingOlderThanSeconds = Math.max(0, input?.processingOlderThanSeconds ?? 120);

    const result = await query<GenerationTaskRow>(
      `
        SELECT *
        FROM generation_tasks
        WHERE
          (status = 'pending' AND updated_at < NOW() - make_interval(secs => $1::int))
          OR
          (status = 'processing' AND updated_at < NOW() - make_interval(secs => $2::int))
        ORDER BY created_at ASC
        LIMIT $3
      `,
      [pendingOlderThanSeconds, processingOlderThanSeconds, limit]
    );

    return result.rows.map((row) => mapRowToTask(row));
  },

  async listProjectTasks(projectId: string): Promise<GenerationTask[]> {
    const result = await query<GenerationTaskRow>(
      `
        SELECT *
        FROM generation_tasks
        WHERE project_id = $1
        ORDER BY created_at DESC
      `,
      [normalizeString(projectId)]
    );

    return result.rows.map((row) => mapRowToTask(row));
  },

  async createTask(input: GenerationTaskInput): Promise<GenerationTask> {
    const task = sanitizeTask(input);

    const result = await query<GenerationTaskRow>(
      `
        INSERT INTO generation_tasks (
          id,
          project_id,
          reference_library_item_id,
          trigger_mode,
          status,
          target_model,
          provider,
          provider_task_id,
          prompt_text,
          result_video_url,
          video_file_name,
          video_description,
          overlay_texts,
          yandex_disk_path,
          yandex_download_url,
          s3_bucket,
          s3_object_key,
          s3_object_url,
          s3_stored_at,
          stored_at,
          error_message,
          started_at,
          finished_at,
          publication_url,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13::jsonb, $14, $15, $16, $17, $18, $19, $20, $21, $22, $23, $24, $25::timestamptz, $26::timestamptz
        )
        RETURNING *
      `,
      [
        task.id,
        task.projectId,
        task.referenceLibraryItemId,
        task.triggerMode,
        task.status,
        task.targetModel,
        task.provider,
        task.providerTaskId,
        task.promptText,
        task.resultVideoUrl,
        task.videoFileName,
        task.videoDescription,
        JSON.stringify(task.overlayTexts),
        task.yandexDiskPath,
        task.yandexDownloadUrl,
        task.s3Bucket,
        task.s3ObjectKey,
        task.s3ObjectUrl,
        task.s3StoredAt,
        task.storedAt,
        task.errorMessage,
        task.startedAt,
        task.finishedAt,
        task.publicationUrl,
        task.createdAt,
        task.updatedAt,
      ]
    );

    return mapRowToTask(result.rows[0] as GenerationTaskRow);
  },

  async listReferenceTasks(referenceLibraryItemId: string): Promise<GenerationTask[]> {
    const result = await query<GenerationTaskRow>(
      `
        SELECT *
        FROM generation_tasks
        WHERE reference_library_item_id = $1
        ORDER BY created_at DESC
      `,
      [normalizeString(referenceLibraryItemId)]
    );

    return result.rows.map((row) => mapRowToTask(row));
  },
  
  async findTasksWithPublication(projectId: string): Promise<GenerationTask[]> {
    try {
      const result = await db.query<GenerationTaskRow>(
        `SELECT * FROM generation_tasks 
         WHERE project_id = $1 
         AND publication_url IS NOT NULL 
         AND publication_url != ''
         ORDER BY created_at DESC`,
        [projectId]
      );
      return result.rows.map(mapRowToTask);
    } catch (error: any) {
      console.error('[GenerationTaskStore] Failed to find tasks with publication:', error.message);
      throw error;
    }
  },

  async updateTask(taskId: string, update: GenerationTaskUpdate): Promise<GenerationTask | null> {
    const existingResult = await query<GenerationTaskRow>(
      'SELECT * FROM generation_tasks WHERE id = $1 LIMIT 1',
      [normalizeString(taskId)]
    );

    const existing = existingResult.rows[0] ? mapRowToTask(existingResult.rows[0]) : null;
    if (!existing) {
      return null;
    }

    const nextTask = sanitizeTask(
      {
        projectId: existing.projectId,
        referenceLibraryItemId: existing.referenceLibraryItemId,
        triggerMode: existing.triggerMode,
        targetModel: existing.targetModel,
        provider: update.provider ?? existing.provider,
        providerTaskId: update.providerTaskId ?? existing.providerTaskId,
        status: update.status ?? existing.status,
        promptText: update.promptText ?? existing.promptText,
        resultVideoUrl: update.resultVideoUrl ?? existing.resultVideoUrl,
        videoFileName: update.videoFileName ?? existing.videoFileName,
        videoDescription: update.videoDescription ?? existing.videoDescription,
        overlayTexts: update.overlayTexts ?? existing.overlayTexts,
        yandexDiskPath: update.yandexDiskPath ?? existing.yandexDiskPath,
        yandexDownloadUrl: update.yandexDownloadUrl ?? existing.yandexDownloadUrl,
        s3Bucket: update.s3Bucket ?? existing.s3Bucket,
        s3ObjectKey: update.s3ObjectKey ?? existing.s3ObjectKey,
        s3ObjectUrl: update.s3ObjectUrl ?? existing.s3ObjectUrl,
        s3StoredAt: update.s3StoredAt ?? existing.s3StoredAt,
        storedAt: update.storedAt ?? existing.storedAt,
        errorMessage: update.errorMessage ?? existing.errorMessage,
        startedAt: update.startedAt ?? existing.startedAt,
        finishedAt: update.finishedAt ?? existing.finishedAt,
        publicationUrl: update.publicationUrl ?? existing.publicationUrl,
      },
      existing
    );

    const result = await query<GenerationTaskRow>(
      `
        UPDATE generation_tasks
        SET
          provider = $2,
          provider_task_id = $3,
          status = $4,
          prompt_text = $5,
          result_video_url = $6,
          video_file_name = $7,
          video_description = $8,
          overlay_texts = $9::jsonb,
          yandex_disk_path = $10,
          yandex_download_url = $11,
          s3_bucket = $12,
          s3_object_key = $13,
          s3_object_url = $14,
          s3_stored_at = $15,
          stored_at = $16,
          error_message = $17,
          started_at = $18,
          finished_at = $19,
          publication_url = $20,
          updated_at = $21::timestamptz
        WHERE id = $1
        RETURNING *
      `,
      [
        nextTask.id,
        nextTask.provider,
        nextTask.providerTaskId,
        nextTask.status,
        nextTask.promptText,
        nextTask.resultVideoUrl,
        nextTask.videoFileName,
        nextTask.videoDescription,
        JSON.stringify(nextTask.overlayTexts),
        nextTask.yandexDiskPath,
        nextTask.yandexDownloadUrl,
        nextTask.s3Bucket,
        nextTask.s3ObjectKey,
        nextTask.s3ObjectUrl,
        nextTask.s3StoredAt,
        nextTask.storedAt,
        nextTask.errorMessage,
        nextTask.startedAt,
        nextTask.finishedAt,
        nextTask.publicationUrl,
        nextTask.updatedAt,
      ]
    );

    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  },

  async countTasksForDate(projectId: string, dateIso: string): Promise<number> {
    try {
      const result = await db.query<{ count: string }>(
        `SELECT COUNT(*) FROM generation_tasks 
         WHERE project_id = $1 
         AND created_at::text LIKE $2
         AND status != 'failed'`,
        [projectId, `${dateIso}%`]
      );
      return parseInt(result.rows[0].count, 10);
    } catch (error: any) {
      console.error('[GenerationTaskStore] Failed to count tasks for date:', error.message);
      throw error;
    }
  },

  async deleteProjectTasks(projectId: string): Promise<void> {
    await query('DELETE FROM generation_tasks WHERE project_id = $1', [normalizeString(projectId)]);
  },

  async deleteReferenceTasks(referenceLibraryItemId: string): Promise<void> {
    await query('DELETE FROM generation_tasks WHERE reference_library_item_id = $1', [normalizeString(referenceLibraryItemId)]);
  },
};
