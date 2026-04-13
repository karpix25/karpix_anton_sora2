import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type { GenerationProvider, GenerationTask, GenerationTaskInput, GenerationTaskStatus, GenerationTaskUpdate } from '../domain/generation-task.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const tasksFilePath = path.join(dataDir, 'generation-tasks.json');

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

async function ensureStorage(): Promise<void> {
  await fs.ensureDir(dataDir);
  if (!(await fs.pathExists(tasksFilePath))) {
    await fs.writeJson(tasksFilePath, { tasks: [] }, { spaces: 2 });
  }
}

async function loadTasks(): Promise<GenerationTask[]> {
  await ensureStorage();
  const data = (await fs.readJson(tasksFilePath)) as { tasks?: GenerationTaskInput[] };
  const tasks = Array.isArray(data.tasks) ? data.tasks : [];
  return tasks
    .map((task) => sanitizeTask(task, task as GenerationTask))
    .filter((task) => task.projectId && task.referenceLibraryItemId);
}

async function saveTasks(tasks: GenerationTask[]): Promise<void> {
  await ensureStorage();
  await fs.writeJson(tasksFilePath, { tasks }, { spaces: 2 });
}

export const generationTaskStore = {
  async listProjectTasks(projectId: string): Promise<GenerationTask[]> {
    const tasks = await loadTasks();
    return tasks
      .filter((task) => task.projectId === normalizeString(projectId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  },

  async createTask(input: GenerationTaskInput): Promise<GenerationTask> {
    const tasks = await loadTasks();
    const task = sanitizeTask(input);
    tasks.unshift(task);
    await saveTasks(tasks);
    return task;
  },

  async listReferenceTasks(referenceLibraryItemId: string): Promise<GenerationTask[]> {
    const tasks = await loadTasks();
    return tasks
      .filter((task) => task.referenceLibraryItemId === normalizeString(referenceLibraryItemId))
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  },

  async updateTask(taskId: string, update: GenerationTaskUpdate): Promise<GenerationTask | null> {
    const tasks = await loadTasks();
    const index = tasks.findIndex((task) => task.id === taskId);
    if (index === -1) {
      return null;
    }

    const existing = tasks[index];
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

    tasks[index] = nextTask;
    await saveTasks(tasks);
    return nextTask;
  },

  async deleteProjectTasks(projectId: string): Promise<void> {
    const tasks = await loadTasks();
    await saveTasks(tasks.filter((task) => task.projectId !== normalizeString(projectId)));
  },

  async deleteReferenceTasks(referenceLibraryItemId: string): Promise<void> {
    const tasks = await loadTasks();
    await saveTasks(tasks.filter((task) => task.referenceLibraryItemId !== normalizeString(referenceLibraryItemId)));
  },
};
