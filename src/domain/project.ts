export type ProjectMode = 'manual' | 'auto';
export type VideoModel = 'sora-2' | 'veo-3-1';

export interface ReferenceImage {
  id: string;
  originalName: string;
  storedName: string;
  mimeType: string;
  url: string;
  yandexDiskPath: string;
  yandexDownloadUrl: string;
  yandexSyncedAt: string;
  telegramFileId: string;
  telegramMessageId: string;
  telegramSyncedAt: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  telegramChatId: string;
  telegramTopicId: string;
  productName: string;
  productDescription: string;
  extraPromptingRules: string;
  targetAudience: string;
  cta: string;
  mode: ProjectMode;
  automationEnabled: boolean;
  dailyGenerationLimit: number;
  selectedModel: VideoModel;
  isActive: boolean;
  primaryReferenceImageId: string;
  referenceImages: ReferenceImage[];
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  name?: string;
  telegramChatId?: string;
  telegramTopicId?: string;
  productName?: string;
  productDescription?: string;
  extraPromptingRules?: string;
  targetAudience?: string;
  cta?: string;
  mode?: ProjectMode;
  automationEnabled?: boolean;
  dailyGenerationLimit?: number;
  selectedModel?: VideoModel;
  isActive?: boolean;
  primaryReferenceImageId?: string;
  referenceImages?: ReferenceImage[];
}
