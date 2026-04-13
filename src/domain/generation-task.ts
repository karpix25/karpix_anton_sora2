import type { VideoModel } from './project.js';

export type GenerationTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type GenerationTriggerMode = 'telegram_manual' | 'web_manual';
export type GenerationProvider = 'kie' | 'wavespeed';

export interface GenerationTask {
  id: string;
  projectId: string;
  referenceLibraryItemId: string;
  triggerMode: GenerationTriggerMode;
  status: GenerationTaskStatus;
  targetModel: VideoModel;
  provider: GenerationProvider;
  providerTaskId: string;
  promptText: string;
  resultVideoUrl: string;
  yandexDiskPath: string;
  yandexDownloadUrl: string;
  storedAt: string;
  errorMessage: string;
  startedAt: string;
  finishedAt: string;
  createdAt: string;
  updatedAt: string;
}

export interface GenerationTaskInput {
  projectId: string;
  referenceLibraryItemId: string;
  triggerMode: GenerationTriggerMode;
  status?: GenerationTaskStatus;
  targetModel: VideoModel;
  provider?: GenerationProvider;
  providerTaskId?: string;
  promptText?: string;
  resultVideoUrl?: string;
  yandexDiskPath?: string;
  yandexDownloadUrl?: string;
  storedAt?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface GenerationTaskUpdate {
  status?: GenerationTaskStatus;
  provider?: GenerationProvider;
  providerTaskId?: string;
  promptText?: string;
  resultVideoUrl?: string;
  yandexDiskPath?: string;
  yandexDownloadUrl?: string;
  storedAt?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
}
