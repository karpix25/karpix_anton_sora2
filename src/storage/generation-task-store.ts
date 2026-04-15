import { randomUUID } from 'node:crypto';
import type { GenerationProvider, GenerationTask, GenerationTaskInput, GenerationTaskStatus, GenerationTaskUpdate } from '../domain/generation-task.js';
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
  yandex_disk_path: string;
  yandex_download_url: string;
  stored_at: string;
  error_message: string;
  started_at: string;
  finished_at: string;
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

function normalizeStatus(value: unknown): GenerationTaskStatus {
  return value === 'processing' || value === 'completed' || value === 'failed' ? value : 'pending';
}

function normalizeProvider(value: unknown): GenerationProvider {
  return value === 'wavespeed' ? 'wavespeed' : 'kie';
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
    yandexDiskPath: normalizeString(input.yandexDiskPath ?? existing?.yandexDiskPath),
    yandexDownloadUrl: normalizeString(input.yandexDownloadUrl ?? existing?.yandexDownloadUrl),
    storedAt: normalizeString(input.storedAt ?? existing?.storedAt),
    errorMessage: normalizeString(input.errorMessage ?? existing?.errorMessage),
    startedAt: normalizeString(input.startedAt ?? existing?.startedAt),
    finishedAt: normalizeString(input.finishedAt ?? existing?.finishedAt),
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
    yandexDiskPath: normalizeString(row.yandex_disk_path),
    yandexDownloadUrl: normalizeString(row.yandex_download_url),
    storedAt: normalizeString(row.stored_at),
    errorMessage: normalizeString(row.error_message),
    startedAt: normalizeString(row.started_at),
    finishedAt: normalizeString(row.finished_at),
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
          yandex_disk_path,
          yandex_download_url,
          stored_at,
          error_message,
          started_at,
          finished_at,
          created_at,
          updated_at
        )
        VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17::timestamptz, $18::timestamptz
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
        task.yandexDiskPath,
        task.yandexDownloadUrl,
        task.storedAt,
        task.errorMessage,
        task.startedAt,
        task.finishedAt,
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
        yandexDiskPath: update.yandexDiskPath ?? existing.yandexDiskPath,
        yandexDownloadUrl: update.yandexDownloadUrl ?? existing.yandexDownloadUrl,
        storedAt: update.storedAt ?? existing.storedAt,
        errorMessage: update.errorMessage ?? existing.errorMessage,
        startedAt: update.startedAt ?? existing.startedAt,
        finishedAt: update.finishedAt ?? existing.finishedAt,
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
          yandex_disk_path = $7,
          yandex_download_url = $8,
          stored_at = $9,
          error_message = $10,
          started_at = $11,
          finished_at = $12,
          updated_at = $13::timestamptz
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
        nextTask.yandexDiskPath,
        nextTask.yandexDownloadUrl,
        nextTask.storedAt,
        nextTask.errorMessage,
        nextTask.startedAt,
        nextTask.finishedAt,
        nextTask.updatedAt,
      ]
    );

    return result.rows[0] ? mapRowToTask(result.rows[0]) : null;
  },

  async deleteProjectTasks(projectId: string): Promise<void> {
    await query('DELETE FROM generation_tasks WHERE project_id = $1', [normalizeString(projectId)]);
  },

  async deleteReferenceTasks(referenceLibraryItemId: string): Promise<void> {
    await query('DELETE FROM generation_tasks WHERE reference_library_item_id = $1', [normalizeString(referenceLibraryItemId)]);
  },
};
