import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type { Project, ProjectInput, ReferenceImage } from '../domain/project.js';
import { query } from './db.js';
import { SafeFileService } from '../services/safe-file.service.js';
import { detectImageMimeType, isSupportedGeminiImageMimeType } from '../utils/media-mime.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const uploadsDir = path.join(dataDir, 'uploads', 'reference-images');
const defaultTextStyle: NonNullable<Project['textStyle']> = {
  fontFamily: 'Montserrat',
  fontSize: 30,
  fontColor: '#FFFFFF',
  fontWeight: '700',
  outlineColor: '#000000',
  outlineWidth: 1.5,
  outlineEnabled: false,
  backgroundColor: '#000000',
  backgroundOpacity: 0.82,
  borderStyle: 1,
  verticalMargin: 40,
  frameWidthPercent: 47,
  frameXPercent: 50,
  textAlign: 'center',
  lineHeight: 1.24,
  boxPaddingX: 18,
  boxPaddingY: 12,
  boxRadius: 10,
};

interface ProjectRow {
  id: string;
  project_code: string;
  name: string;
  telegram_chat_id: string;
  telegram_topic_id: string;
  telegram_topic_name: string;
  product_name: string;
  product_description: string;
  extra_prompting_rules: string;
  target_audience: string;
  cta: string;
  project_language: string;
  mode: string;
  automation_enabled: boolean;
  daily_generation_limit: number;
  package_video_limit: number;
  selected_model: string;
  is_active: boolean;
  primary_reference_image_id: string;
  reference_images: unknown;
  text_style: unknown;
  end_frame_text: string;
  end_frame_vertical_margin: number;
  end_frame_width_percent: number;
  end_frame_x_percent: number;
  viral_reuse_percentage: number;
  min_views_to_reuse: number;
  max_viral_age_days: number;
  yandex_disk_folder: string;
  created_at: string;
  updated_at: Date | string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function generateProjectCode(projectId: string): string {
  const hash = createHash('sha1')
    .update(projectId)
    .digest('base64url')
    .replace(/[^A-Za-z0-9]/g, '')
    .toUpperCase();

  const fallback = projectId.replace(/[^A-Za-z0-9]/g, '').toUpperCase();
  return (hash.slice(0, 8) || fallback.slice(0, 8) || 'PROJECT01').slice(0, 8);
}

function normalizeProjectCode(value: unknown, projectId: string): string {
  const normalized = normalizeString(value).toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (normalized.length >= 4) {
    return normalized.slice(0, 12);
  }

  return generateProjectCode(projectId);
}

function normalizeYandexDiskFolder(value: unknown): string {
  return normalizeString(value)
    .replace(/^disk:\/*/i, '')
    .replace(/^\/+/, '')
    .replace(/^ВИДЕО\/SORA2\/?/i, '')
    .split('/')
    .map((part) => part.trim().replace(/[\\:*?"<>|]+/g, '-').replace(/\s{2,}/g, ' '))
    .filter((part) => part && part !== '.' && part !== '..')
    .join('/')
    .slice(0, 240);
}

function normalizeProjectLanguage(value: unknown, fallback: Project['projectLanguage'] = 'ru'): Project['projectLanguage'] {
  return normalizeString(value).toLowerCase() === 'en' ? 'en' : fallback;
}

function normalizeBoolean(value: unknown, defaultValue = false): boolean {
  return typeof value === 'boolean' ? value : defaultValue;
}

function normalizeNumber(value: unknown, defaultValue = 0): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value >= 0 ? Math.floor(value) : defaultValue;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed) && parsed >= 0) {
      return Math.floor(parsed);
    }
  }

  return defaultValue;
}

function toIsoString(value: unknown, fallback = nowIso()): string {
  if (value instanceof Date) {
    return value.toISOString();
  }

  const normalized = normalizeString(value);
  return normalized || fallback;
}

function normalizeReferenceImages(value: unknown): ReferenceImage[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value
    .filter((item): item is ReferenceImage => typeof item === 'object' && item !== null)
    .map((item) => ({
      id: normalizeString(item.id) || randomUUID(),
      originalName: normalizeString(item.originalName),
      storedName: normalizeString(item.storedName),
      mimeType: normalizeString(item.mimeType),
      url: normalizeString(item.url),
      yandexDiskPath: normalizeString(item.yandexDiskPath),
      yandexDownloadUrl: normalizeString(item.yandexDownloadUrl),
      yandexSyncedAt: normalizeString(item.yandexSyncedAt),
      telegramFileId: normalizeString(item.telegramFileId),
      telegramMessageId: normalizeString(item.telegramMessageId),
      telegramSyncedAt: normalizeString(item.telegramSyncedAt),
      createdAt: normalizeString(item.createdAt) || nowIso(),
    }))
    .filter((item) => item.url);
}

function parseJSON<T>(value: unknown, defaultValue: T): T {
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T;
    } catch {
      return defaultValue;
    }
  }
  return (value as T) ?? defaultValue;
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

function toFiniteNumber(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return value;
  }

  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) {
      return parsed;
    }
  }

  return null;
}

function normalizeHexColor(value: unknown, fallback: string): string {
  const normalized = normalizeString(value).toUpperCase();
  return /^#[0-9A-F]{6}$/.test(normalized) ? normalized : fallback;
}

function normalizeTextStyle(
  value: unknown,
  fallback: NonNullable<Project['textStyle']> = defaultTextStyle
): NonNullable<Project['textStyle']> {
  const parsed =
    typeof value === 'string'
      ? parseJSON<Record<string, unknown> | null>(value, null)
      : (value as Record<string, unknown> | null);
  const style = parsed && typeof parsed === 'object' ? parsed : {};

  const fontSizeRaw = toFiniteNumber(style.fontSize);
  const outlineWidthRaw = toFiniteNumber(style.outlineWidth);
  const borderStyleRaw = toFiniteNumber(style.borderStyle);
  const verticalMarginRaw = toFiniteNumber(style.verticalMargin);
  const frameWidthPercentRaw = toFiniteNumber(style.frameWidthPercent);
  const frameXPercentRaw = toFiniteNumber(style.frameXPercent);
  const lineHeightRaw = toFiniteNumber(style.lineHeight);
  const backgroundOpacityRaw = toFiniteNumber(style.backgroundOpacity);
  const boxPaddingXRaw = toFiniteNumber(style.boxPaddingX);
  const boxPaddingYRaw = toFiniteNumber(style.boxPaddingY);
  const boxRadiusRaw = toFiniteNumber(style.boxRadius);
  const outlineEnabled = typeof style.outlineEnabled === 'boolean' ? style.outlineEnabled : fallback.outlineEnabled;
  const fontWeightRaw = normalizeString(style.fontWeight);
  const normalizedFontWeight =
    /^(normal|bold|[1-9]00)$/.test(fontWeightRaw) ? fontWeightRaw : fallback.fontWeight;
  const textAlignRaw = normalizeString(style.textAlign).toLowerCase();
  const textAlign: NonNullable<Project['textStyle']>['textAlign'] =
    textAlignRaw === 'left' || textAlignRaw === 'right' || textAlignRaw === 'center'
      ? textAlignRaw
      : fallback.textAlign;

  const fontFamily = normalizeString(style.fontFamily);

  const fallbackBorderStyle = fallback.borderStyle === 3 ? 3 : 1;
  const borderStyle =
    borderStyleRaw === 1 || borderStyleRaw === 3 ? Math.round(borderStyleRaw) : fallbackBorderStyle;

  return {
    fontFamily: fontFamily || fallback.fontFamily,
    fontSize: Math.round(clamp(fontSizeRaw ?? fallback.fontSize, 10, 120)),
    fontColor: normalizeHexColor(style.fontColor, fallback.fontColor),
    fontWeight: normalizedFontWeight,
    outlineColor: normalizeHexColor(style.outlineColor, fallback.outlineColor),
    outlineWidth: clamp(outlineWidthRaw ?? fallback.outlineWidth, 0, 12),
    outlineEnabled,
    backgroundColor: normalizeHexColor(style.backgroundColor, fallback.backgroundColor),
    backgroundOpacity: clamp(backgroundOpacityRaw ?? fallback.backgroundOpacity, 0, 1),
    borderStyle,
    verticalMargin: Math.round(clamp(verticalMarginRaw ?? fallback.verticalMargin, 0, 500)),
    frameWidthPercent: Math.round(clamp(frameWidthPercentRaw ?? fallback.frameWidthPercent, 20, 100)),
    frameXPercent: Math.round(clamp(frameXPercentRaw ?? fallback.frameXPercent, 0, 100)),
    textAlign,
    lineHeight: clamp(lineHeightRaw ?? fallback.lineHeight, 0.8, 2),
    boxPaddingX: Math.round(clamp(boxPaddingXRaw ?? fallback.boxPaddingX, 0, 120)),
    boxPaddingY: Math.round(clamp(boxPaddingYRaw ?? fallback.boxPaddingY, 0, 80)),
    boxRadius: Math.round(clamp(boxRadiusRaw ?? fallback.boxRadius, 0, 120)),
  };
}

function sanitizeProjectInput(input: ProjectInput, existing?: Project): Project {
  const timestamp = nowIso();
  const projectId = existing?.id ?? randomUUID();
  const mode = input.mode ?? existing?.mode ?? 'manual';
  const selectedModel = input.selectedModel ?? existing?.selectedModel ?? 'sora-2';
  const referenceImages = normalizeReferenceImages(input.referenceImages ?? existing?.referenceImages);
  const primaryReferenceImageId = normalizeString(input.primaryReferenceImageId ?? existing?.primaryReferenceImageId);
  const resolvedPrimaryReferenceImageId =
    referenceImages.find((image) => image.id === primaryReferenceImageId)?.id ??
    referenceImages[0]?.id ??
    '';
  const existingTextStyle = normalizeTextStyle(existing?.textStyle, defaultTextStyle);
  const textStyle = normalizeTextStyle(input.textStyle, existingTextStyle);

  return {
    id: projectId,
    projectCode: normalizeProjectCode(input.projectCode ?? existing?.projectCode, projectId),
    name: normalizeString(input.name) || existing?.name || 'New Project',
    telegramChatId: normalizeString(input.telegramChatId) || existing?.telegramChatId || '',
    telegramTopicId: normalizeString(input.telegramTopicId) || existing?.telegramTopicId || '',
    telegramTopicName: normalizeString(input.telegramTopicName) || existing?.telegramTopicName || '',
    productName: normalizeString(input.productName ?? existing?.productName),
    productDescription: normalizeString(input.productDescription ?? existing?.productDescription),
    extraPromptingRules: normalizeString(input.extraPromptingRules ?? existing?.extraPromptingRules),
    targetAudience: normalizeString(input.targetAudience ?? existing?.targetAudience),
    cta: normalizeString(input.cta ?? existing?.cta),
    projectLanguage: normalizeProjectLanguage(input.projectLanguage ?? existing?.projectLanguage, existing?.projectLanguage ?? 'ru'),
    mode: mode === 'auto' ? 'auto' : 'manual',
    automationEnabled: normalizeBoolean(input.automationEnabled, existing?.automationEnabled ?? false),
    dailyGenerationLimit: normalizeNumber(input.dailyGenerationLimit, existing?.dailyGenerationLimit ?? 1),
    packageVideoLimit: normalizeNumber(input.packageVideoLimit, existing?.packageVideoLimit ?? 0),
    selectedModel: (selectedModel === 'veo-3-1' || selectedModel === 'grok-imagine' || selectedModel === 'seedance-2' || selectedModel === 'wan-2-7') ? selectedModel : 'sora-2',
    isActive: normalizeBoolean(input.isActive, existing?.isActive ?? true),
    primaryReferenceImageId: resolvedPrimaryReferenceImageId,
    referenceImages,
    textStyle,
    endFrameText: normalizeString(input.endFrameText ?? existing?.endFrameText),
    endFrameVerticalMargin: normalizeNumber(input.endFrameVerticalMargin ?? existing?.endFrameVerticalMargin, 320),
    endFrameWidthPercent: normalizeNumber(input.endFrameWidthPercent ?? existing?.endFrameWidthPercent, 50),
    endFrameXPercent: normalizeNumber(input.endFrameXPercent ?? existing?.endFrameXPercent, 50),
    viralReusePercentage: normalizeNumber(input.viralReusePercentage ?? existing?.viralReusePercentage, 0),
    minViewsToReuse: normalizeNumber(input.minViewsToReuse ?? existing?.minViewsToReuse, 1000),
    maxViralAgeDays: normalizeNumber(input.maxViralAgeDays ?? existing?.maxViralAgeDays, 30),
    yandexDiskFolder: normalizeYandexDiskFolder(input.yandexDiskFolder ?? existing?.yandexDiskFolder),
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function mapRowToProject(row: ProjectRow): Project {
  const projectId = normalizeString(row.id);
  return {
    id: projectId,
    projectCode: normalizeProjectCode(row.project_code, projectId),
    name: normalizeString(row.name) || 'New Project',
    telegramChatId: normalizeString(row.telegram_chat_id),
    telegramTopicId: normalizeString(row.telegram_topic_id),
    telegramTopicName: normalizeString(row.telegram_topic_name),
    productName: normalizeString(row.product_name),
    productDescription: normalizeString(row.product_description),
    extraPromptingRules: normalizeString(row.extra_prompting_rules),
    targetAudience: normalizeString(row.target_audience),
    cta: normalizeString(row.cta),
    projectLanguage: normalizeProjectLanguage(row.project_language, 'ru'),
    mode: row.mode === 'auto' ? 'auto' : 'manual',
    automationEnabled: Boolean(row.automation_enabled),
    dailyGenerationLimit: normalizeNumber(row.daily_generation_limit, 1),
    packageVideoLimit: normalizeNumber(row.package_video_limit, 0),
    selectedModel: (row.selected_model === 'veo-3-1' || row.selected_model === 'grok-imagine' || row.selected_model === 'seedance-2' || row.selected_model === 'wan-2-7') ? row.selected_model : 'sora-2',
    isActive: Boolean(row.is_active),
    primaryReferenceImageId: normalizeString(row.primary_reference_image_id),
    referenceImages: parseJSON(row.reference_images, []),
    textStyle: normalizeTextStyle(row.text_style, defaultTextStyle),
    endFrameText: row.end_frame_text,
    endFrameVerticalMargin: row.end_frame_vertical_margin,
    endFrameWidthPercent: row.end_frame_width_percent,
    endFrameXPercent: row.end_frame_x_percent,
    viralReusePercentage: row.viral_reuse_percentage,
    minViewsToReuse: row.min_views_to_reuse,
    maxViralAgeDays: normalizeNumber(row.max_viral_age_days, 30),
    yandexDiskFolder: normalizeYandexDiskFolder(row.yandex_disk_folder),
    createdAt: row.created_at,
    updatedAt: toIsoString(row.updated_at),
  };
}

async function ensureStorage(): Promise<void> {
  await fs.ensureDir(uploadsDir);
}

function safeFileExtension(mimeType: string, fallbackName: string): string {
  const knownExtensions: Record<string, string> = {
    'image/jpeg': '.jpg',
    'image/png': '.png',
    'image/webp': '.webp',
    'image/heic': '.heic',
    'image/heif': '.heif',
  };

  if (knownExtensions[mimeType]) {
    return knownExtensions[mimeType];
  }

  const ext = path.extname(fallbackName);
  return ext || '.bin';
}

async function upsertProject(project: Project): Promise<Project> {
  const queryText = `
    INSERT INTO projects (
      id, project_code, name, telegram_chat_id, telegram_topic_id, telegram_topic_name,
      product_name, product_description, extra_prompting_rules, target_audience, cta, project_language,
      mode, automation_enabled, daily_generation_limit, package_video_limit, selected_model, is_active,
      primary_reference_image_id, reference_images, text_style,
      end_frame_text, end_frame_vertical_margin, end_frame_width_percent, end_frame_x_percent,
      viral_reuse_percentage, min_views_to_reuse, max_viral_age_days, yandex_disk_folder,
      created_at, updated_at
    )
    VALUES (
      $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
      $13, $14, $15, $16, $17, $18, $19, $20::jsonb, $21::jsonb,
      $22, $23, $24, $25, $26, $27, $28, $29, $30::timestamptz, $31::timestamptz
    )
    ON CONFLICT (id) DO UPDATE SET
      project_code = EXCLUDED.project_code,
      name = EXCLUDED.name,
      telegram_chat_id = EXCLUDED.telegram_chat_id,
      telegram_topic_id = EXCLUDED.telegram_topic_id,
      telegram_topic_name = EXCLUDED.telegram_topic_name,
      product_name = EXCLUDED.product_name,
      product_description = EXCLUDED.product_description,
      extra_prompting_rules = EXCLUDED.extra_prompting_rules,
      target_audience = EXCLUDED.target_audience,
      cta = EXCLUDED.cta,
      project_language = EXCLUDED.project_language,
      mode = EXCLUDED.mode,
      automation_enabled = EXCLUDED.automation_enabled,
      daily_generation_limit = EXCLUDED.daily_generation_limit,
      package_video_limit = EXCLUDED.package_video_limit,
      selected_model = EXCLUDED.selected_model,
      is_active = EXCLUDED.is_active,
      primary_reference_image_id = EXCLUDED.primary_reference_image_id,
      reference_images = EXCLUDED.reference_images,
      text_style = EXCLUDED.text_style,
      end_frame_text = EXCLUDED.end_frame_text,
      end_frame_vertical_margin = EXCLUDED.end_frame_vertical_margin,
      end_frame_width_percent = EXCLUDED.end_frame_width_percent,
      end_frame_x_percent = EXCLUDED.end_frame_x_percent,
      viral_reuse_percentage = EXCLUDED.viral_reuse_percentage,
      min_views_to_reuse = EXCLUDED.min_views_to_reuse,
      max_viral_age_days = EXCLUDED.max_viral_age_days,
      yandex_disk_folder = EXCLUDED.yandex_disk_folder,
      updated_at = EXCLUDED.updated_at
    RETURNING *
  `;

  const values = [
    project.id,
    project.projectCode,
    project.name,
    project.telegramChatId,
    project.telegramTopicId,
    project.telegramTopicName,
    project.productName,
    project.productDescription,
    project.extraPromptingRules,
    project.targetAudience,
    project.cta,
    project.projectLanguage,
    project.mode,
    project.automationEnabled,
    project.dailyGenerationLimit,
    project.packageVideoLimit,
    project.selectedModel,
    project.isActive,
    project.primaryReferenceImageId,
    JSON.stringify(project.referenceImages),
    JSON.stringify(project.textStyle || {}),
    project.endFrameText || '',
    project.endFrameVerticalMargin ?? 320,
    project.endFrameWidthPercent ?? 50,
    project.endFrameXPercent ?? 50,
    project.viralReusePercentage ?? 0,
    project.minViewsToReuse ?? 1000,
    project.maxViralAgeDays ?? 30,
    project.yandexDiskFolder || '',
    project.createdAt,
    project.updatedAt,
  ];

  const result = await query<ProjectRow>(queryText, values);
  return mapRowToProject(result.rows[0] as ProjectRow);
}

export const projectStore = {
  async listProjects(): Promise<Project[]> {
    await ensureStorage();
    const result = await query<ProjectRow>(`
      SELECT *
      FROM projects
      ORDER BY LOWER(NULLIF(name, '')) ASC NULLS LAST, created_at ASC, id ASC
    `);
    return result.rows.map((row) => mapRowToProject(row));
  },

  async getProject(projectId: string): Promise<Project | null> {
    await ensureStorage();
    const result = await query<ProjectRow>('SELECT * FROM projects WHERE id = $1 LIMIT 1', [normalizeString(projectId)]);
    return result.rows[0] ? mapRowToProject(result.rows[0]) : null;
  },

  async findProjectByTelegramBinding(telegramChatId: string, telegramTopicId: string): Promise<Project | null> {
    await ensureStorage();
    const result = await query<ProjectRow>(
      `
        SELECT *
        FROM projects
        WHERE telegram_chat_id = $1 AND telegram_topic_id = $2
        ORDER BY updated_at DESC, created_at DESC, id DESC
        LIMIT 2
      `,
      [normalizeString(telegramChatId), normalizeString(telegramTopicId)]
    );

    if (result.rows.length > 1) {
      console.error(
        `[ProjectStore] Duplicate Telegram binding detected for chat=${normalizeString(telegramChatId)}, topic=${normalizeString(telegramTopicId)}. Refusing to pick an arbitrary project.`
      );
      return null;
    }

    return result.rows[0] ? mapRowToProject(result.rows[0]) : null;
  },

  async createProject(input: ProjectInput): Promise<Project> {
    await ensureStorage();
    const project = sanitizeProjectInput(input);
    return upsertProject(project);
  },

  async updateProject(projectId: string, input: ProjectInput): Promise<Project | null> {
    await ensureStorage();
    const existing = await this.getProject(projectId);
    if (!existing) {
      return null;
    }

    const nextProject = sanitizeProjectInput(
      {
        ...input,
        telegramChatId: existing.telegramChatId,
        telegramTopicId: existing.telegramTopicId,
        telegramTopicName: existing.telegramTopicName,
      },
      existing
    );
    return upsertProject(nextProject);
  },

  async bindProjectToTelegramTopic(
    projectId: string,
    telegramChatId: string,
    telegramTopicId: string,
    telegramTopicName = ''
  ): Promise<Project | null> {
    await ensureStorage();

    const targetProject = await this.getProject(projectId);
    if (!targetProject) {
      return null;
    }

    const normalizedChatId = normalizeString(telegramChatId);
    const normalizedTopicId = normalizeString(telegramTopicId);
    const normalizedTopicName = normalizeString(telegramTopicName);
    const timestamp = nowIso();

    await query(
      `
        UPDATE projects
        SET
          telegram_chat_id = '',
          telegram_topic_id = '',
          telegram_topic_name = '',
          updated_at = $1::timestamptz
        WHERE id <> $2 AND telegram_chat_id = $3 AND telegram_topic_id = $4
      `,
      [timestamp, targetProject.id, normalizedChatId, normalizedTopicId]
    );

    const nextProject = sanitizeProjectInput(
      {
        ...targetProject,
        telegramChatId: normalizedChatId,
        telegramTopicId: normalizedTopicId,
        telegramTopicName: normalizedTopicName || targetProject.telegramTopicName || '',
      },
      targetProject
    );

    return upsertProject(nextProject);
  },

  async deleteProject(projectId: string): Promise<boolean> {
    await ensureStorage();
    const existing = await this.getProject(projectId);
    if (!existing) {
      return false;
    }

    const imagePaths = existing.referenceImages.map((image: ReferenceImage) =>
      SafeFileService.assertUserFilePath(path.join(uploadsDir, image.storedName), uploadsDir)
    );

    await query('DELETE FROM projects WHERE id = $1', [normalizeString(projectId)]);

    await Promise.all(
      imagePaths.map(async (imagePath) => {
        await SafeFileService.moveUserFileToTrash(imagePath, uploadsDir);
      })
    );

    return true;
  },

  async saveReferenceImage(payload: {
    originalName: string;
    mimeType: string;
    contentBase64: string;
  }): Promise<ReferenceImage> {
    await ensureStorage();

    const buffer = Buffer.from(payload.contentBase64, 'base64');
    const mimeType = detectImageMimeType(buffer, payload.originalName, payload.mimeType);
    const extension = safeFileExtension(mimeType || payload.mimeType, payload.originalName);
    const storedName = `${Date.now()}-${randomUUID()}${extension}`;
    const outputPath = path.join(uploadsDir, storedName);

    await fs.writeFile(outputPath, buffer);

    return {
      id: randomUUID(),
      originalName: normalizeString(payload.originalName) || storedName,
      storedName,
      mimeType: mimeType || normalizeString(payload.mimeType) || 'application/octet-stream',
      url: `/uploads/reference-images/${storedName}`,
      yandexDiskPath: '',
      yandexDownloadUrl: '',
      yandexSyncedAt: '',
      telegramFileId: '',
      telegramMessageId: '',
      telegramSyncedAt: '',
      createdAt: nowIso(),
    };
  },

  async getReferenceImageDataUrls(referenceImages: ReferenceImage[], limit = 4): Promise<string[]> {
    const activeImages = referenceImages
      .filter((image) => image.storedName)
      .slice(0, Math.max(0, limit));

    const dataUrls = await Promise.all(
      activeImages.map(async (image) => {
        const imagePath = path.join(uploadsDir, image.storedName);
        if (!(await fs.pathExists(imagePath))) {
          return '';
        }

        const buffer = await fs.readFile(imagePath);
        const mimeType = detectImageMimeType(buffer, image.originalName || image.storedName, image.mimeType);
        if (!isSupportedGeminiImageMimeType(mimeType)) {
          console.warn(
            `[ProjectStore] Skipping unsupported reference image MIME for Gemini: storedName=${image.storedName}, mime=${mimeType || image.mimeType || 'unknown'}`
          );
          return '';
        }
        return `data:${mimeType};base64,${buffer.toString('base64')}`;
      })
    );

    return dataUrls.filter(Boolean);
  },

  getPrimaryReferenceImage(projectOrImages: Project | ReferenceImage[]): ReferenceImage | null {
    const referenceImages = Array.isArray(projectOrImages) ? projectOrImages : projectOrImages.referenceImages;
    const primaryReferenceImageId = Array.isArray(projectOrImages) ? '' : projectOrImages.primaryReferenceImageId;

    return (
      referenceImages.find((image) => image.id === primaryReferenceImageId) ??
      referenceImages.find((image) => Boolean(image.storedName)) ??
      null
    );
  },

  getReferenceImageAbsolutePath(image: ReferenceImage): string {
    return path.join(uploadsDir, image.storedName);
  },

  async updateReferenceImageTelegramSync(
    projectId: string,
    imageId: string,
    input: {
      telegramFileId: string;
      telegramMessageId: string;
      telegramSyncedAt: string;
    }
  ): Promise<Project | null> {
    const project = await this.getProject(projectId);
    if (!project) {
      return null;
    }

    const referenceImages = project.referenceImages.map((image) => {
      if (image.id !== imageId) {
        return image;
      }

      return {
        ...image,
        telegramFileId: normalizeString(input.telegramFileId),
        telegramMessageId: normalizeString(input.telegramMessageId),
        telegramSyncedAt: normalizeString(input.telegramSyncedAt),
      };
    });

    return this.updateProject(projectId, {
      ...project,
      referenceImages,
    });
  },

  async updateReferenceImageYandexSync(
    projectId: string,
    imageId: string,
    input: {
      yandexDiskPath: string;
      yandexDownloadUrl: string;
      yandexSyncedAt: string;
    }
  ): Promise<Project | null> {
    const project = await this.getProject(projectId);
    if (!project) {
      return null;
    }

    const referenceImages = project.referenceImages.map((image) => {
      if (image.id !== imageId) {
        return image;
      }

      return {
        ...image,
        yandexDiskPath: normalizeString(input.yandexDiskPath),
        yandexDownloadUrl: normalizeString(input.yandexDownloadUrl),
        yandexSyncedAt: normalizeString(input.yandexSyncedAt),
      };
    });

    return this.updateProject(projectId, {
      ...project,
      referenceImages,
    });
  },

  async deleteProjectReferenceImage(
    projectId: string,
    imageId: string
  ): Promise<{ project: Project | null; removedImage: ReferenceImage | null }> {
    const project = await this.getProject(projectId);
    if (!project) {
      return { project: null, removedImage: null };
    }

    const removedImage = project.referenceImages.find((image) => image.id === imageId) ?? null;
    if (!removedImage) {
      return { project, removedImage: null };
    }

    const referenceImages = project.referenceImages.filter((image) => image.id !== imageId);
    const imagePath = SafeFileService.assertUserFilePath(this.getReferenceImageAbsolutePath(removedImage), uploadsDir);
    const updatedProject = await this.updateProject(projectId, {
      ...project,
      referenceImages,
    });

    await SafeFileService.moveUserFileToTrash(imagePath, uploadsDir);

    return {
      project: updatedProject,
      removedImage,
    };
  },

  async setPrimaryReferenceImage(projectId: string, imageId: string): Promise<Project | null> {
    const project = await this.getProject(projectId);
    if (!project) {
      return null;
    }

    const imageExists = project.referenceImages.some((image) => image.id === imageId);
    if (!imageExists) {
      return null;
    }

    return this.updateProject(projectId, {
      ...project,
      primaryReferenceImageId: imageId,
    });
  },

  async deleteUploadedReferenceImage(storedName: string): Promise<boolean> {
    const normalizedStoredName = normalizeString(storedName);
    if (!normalizedStoredName) {
      return false;
    }

    const imagePath = SafeFileService.assertUserFilePath(path.join(uploadsDir, normalizedStoredName), uploadsDir);
    if (!(await fs.pathExists(imagePath))) {
      return false;
    }

    await SafeFileService.moveUserFileToTrash(imagePath, uploadsDir);
    return true;
  },

  getUploadsDir(): string {
    return uploadsDir;
  },
};
