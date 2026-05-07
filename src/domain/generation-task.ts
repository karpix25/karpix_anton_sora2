import type { VideoModel } from './project.js';
import type { ReferenceTextOverlay } from './reference-library.js';

export type GenerationTaskStatus = 'pending' | 'processing' | 'completed' | 'failed';
export type GenerationTriggerMode =
  | 'telegram_manual'
  | 'web_manual'
  | 'web_manual_remix'
  | 'auto'
  | 'auto_remix';
export type GenerationProvider = 'kie' | 'aihubmix' | 'laozhang' | 'defapi' | 'defapi-stable' | 'comet';

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
  videoFileName: string;
  videoDescription: string;
  overlayTexts: ReferenceTextOverlay[];
  yandexDiskPath: string;
  yandexDownloadUrl: string;
  s3Bucket: string;
  s3ObjectKey: string;
  s3ObjectUrl: string;
  s3StoredAt: string;
  storedAt: string;
  errorMessage: string;
  startedAt: string;
  finishedAt: string;
  publicationUrl: string;
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
  videoFileName?: string;
  videoDescription?: string;
  overlayTexts?: ReferenceTextOverlay[];
  yandexDiskPath?: string;
  yandexDownloadUrl?: string;
  s3Bucket?: string;
  s3ObjectKey?: string;
  s3ObjectUrl?: string;
  s3StoredAt?: string;
  storedAt?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  publicationUrl?: string;
}

export interface GenerationTaskUpdate {
  status?: GenerationTaskStatus;
  provider?: GenerationProvider;
  providerTaskId?: string;
  promptText?: string;
  resultVideoUrl?: string;
  videoFileName?: string;
  videoDescription?: string;
  overlayTexts?: ReferenceTextOverlay[];
  yandexDiskPath?: string;
  yandexDownloadUrl?: string;
  s3Bucket?: string;
  s3ObjectKey?: string;
  s3ObjectUrl?: string;
  s3StoredAt?: string;
  storedAt?: string;
  errorMessage?: string;
  startedAt?: string;
  finishedAt?: string;
  publicationUrl?: string;
}
