export type ProjectMode = 'manual' | 'auto';
export type VideoModel = 'sora-2' | 'seedance-2' | 'veo-3-1' | 'grok-imagine';
export type ProjectLanguage = 'ru' | 'en';

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

export interface TextStyle {
  fontFamily: string;
  fontSize: number;
  fontColor: string;
  fontWeight: string;
  outlineColor: string;
  outlineWidth: number;
  outlineEnabled: boolean;
  backgroundColor: string;
  backgroundOpacity: number;
  borderStyle: number; // 1 = Style with outline/shadow, 3 = Opaque box
  verticalMargin: number;
  frameWidthPercent: number;
  frameXPercent: number;
  textAlign: 'left' | 'center' | 'right';
  lineHeight: number;
  boxPaddingX: number;
  boxPaddingY: number;
  boxRadius: number;
}

export interface Project {
  id: string;
  projectCode: string;
  name: string;
  telegramChatId: string;
  telegramTopicId: string;
  telegramTopicName: string;
  productName: string;
  productDescription: string;
  extraPromptingRules: string;
  targetAudience: string;
  cta: string;
  projectLanguage: ProjectLanguage;
  mode: ProjectMode;
  automationEnabled: boolean;
  dailyGenerationLimit: number;
  selectedModel: VideoModel;
  isActive: boolean;
  primaryReferenceImageId: string;
  referenceImages: ReferenceImage[];
  textStyle?: TextStyle;
  endFrameText: string;
  endFrameVerticalMargin: number;
  endFrameWidthPercent: number;
  endFrameXPercent: number;
  viralReusePercentage: number;
  minViewsToReuse: number;
  yandexDiskFolder: string;
  createdAt: string;
  updatedAt: string;
}

export interface ProjectInput {
  projectCode?: string;
  name?: string;
  telegramChatId?: string;
  telegramTopicId?: string;
  telegramTopicName?: string;
  productName?: string;
  productDescription?: string;
  extraPromptingRules?: string;
  targetAudience?: string;
  cta?: string;
  projectLanguage?: ProjectLanguage;
  mode?: ProjectMode;
  automationEnabled?: boolean;
  dailyGenerationLimit?: number;
  selectedModel?: VideoModel;
  isActive?: boolean;
  primaryReferenceImageId?: string;
  referenceImages?: ReferenceImage[];
  textStyle?: TextStyle;
  endFrameText?: string;
  endFrameVerticalMargin?: number;
  endFrameWidthPercent?: number;
  endFrameXPercent?: number;
  viralReusePercentage?: number;
  minViewsToReuse?: number;
  yandexDiskFolder?: string;
}
