import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type { Project, ProjectInput, ReferenceImage } from '../domain/project.js';
import { query } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const uploadsDir = path.join(dataDir, 'uploads', 'reference-images');

interface ProjectRow {
  id: string;
  name: string;
  telegram_chat_id: string;
  telegram_topic_id: string;
  telegram_topic_name: string;
  product_name: string;
  product_description: string;
  extra_prompting_rules: string;
  target_audience: string;
  cta: string;
  mode: string;
  automation_enabled: boolean;
  daily_generation_limit: number;
  selected_model: string;
  is_active: boolean;
  primary_reference_image_id: string;
  reference_images: unknown;
  text_style: unknown;
  created_at: Date | string;
  updated_at: Date | string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function normalizeString(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
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

function sanitizeProjectInput(input: ProjectInput, existing?: Project): Project {
  const timestamp = nowIso();
  const mode = input.mode ?? existing?.mode ?? 'manual';
  const selectedModel = input.selectedModel ?? existing?.selectedModel ?? 'sora-2';
  const referenceImages = normalizeReferenceImages(input.referenceImages ?? existing?.referenceImages);
  const primaryReferenceImageId = normalizeString(input.primaryReferenceImageId ?? existing?.primaryReferenceImageId);
  const resolvedPrimaryReferenceImageId =
    referenceImages.find((image) => image.id === primaryReferenceImageId)?.id ??
    referenceImages[0]?.id ??
    '';

  const defaultTextStyle: Project['textStyle'] = {
    fontFamily: 'Montserrat',
    fontSize: 30,
    fontColor: '#FFFFFF',
    fontWeight: '700',
    outlineColor: '#000000',
    outlineWidth: 1.5,
    backgroundColor: '#000000',
    borderStyle: 1,
    verticalMargin: 40,
  };

  const textStyle = input.textStyle ?? existing?.textStyle ?? defaultTextStyle;

  return {
    id: existing?.id ?? randomUUID(),
    name: normalizeString(input.name) || existing?.name || 'New Project',
    telegramChatId: normalizeString(input.telegramChatId ?? existing?.telegramChatId),
    telegramTopicId: normalizeString(input.telegramTopicId ?? existing?.telegramTopicId),
    telegramTopicName: normalizeString(input.telegramTopicName ?? existing?.telegramTopicName),
    productName: normalizeString(input.productName ?? existing?.productName),
    productDescription: normalizeString(input.productDescription ?? existing?.productDescription),
    extraPromptingRules: normalizeString(input.extraPromptingRules ?? existing?.extraPromptingRules),
    targetAudience: normalizeString(input.targetAudience ?? existing?.targetAudience),
    cta: normalizeString(input.cta ?? existing?.cta),
    mode: mode === 'auto' ? 'auto' : 'manual',
    automationEnabled: normalizeBoolean(input.automationEnabled, existing?.automationEnabled ?? false),
    dailyGenerationLimit: normalizeNumber(input.dailyGenerationLimit, existing?.dailyGenerationLimit ?? 1),
    selectedModel: selectedModel === 'veo-3-1' ? 'veo-3-1' : 'sora-2',
    isActive: normalizeBoolean(input.isActive, existing?.isActive ?? true),
    primaryReferenceImageId: resolvedPrimaryReferenceImageId,
    referenceImages,
    textStyle,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function mapRowToProject(row: ProjectRow): Project {
  return {
    id: normalizeString(row.id),
    name: normalizeString(row.name) || 'New Project',
    telegramChatId: normalizeString(row.telegram_chat_id),
    telegramTopicId: normalizeString(row.telegram_topic_id),
    telegramTopicName: normalizeString(row.telegram_topic_name),
    productName: normalizeString(row.product_name),
    productDescription: normalizeString(row.product_description),
    extraPromptingRules: normalizeString(row.extra_prompting_rules),
    targetAudience: normalizeString(row.target_audience),
    cta: normalizeString(row.cta),
    mode: row.mode === 'auto' ? 'auto' : 'manual',
    automationEnabled: Boolean(row.automation_enabled),
    dailyGenerationLimit: normalizeNumber(row.daily_generation_limit, 1),
    selectedModel: row.selected_model === 'veo-3-1' ? 'veo-3-1' : 'sora-2',
    isActive: Boolean(row.is_active),
    primaryReferenceImageId: normalizeString(row.primary_reference_image_id),
    referenceImages: parseJSON(row.reference_images, []),
    textStyle: parseJSON(row.text_style, undefined),
    createdAt: toIsoString(row.created_at),
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
  const result = await query<ProjectRow>(
    `
      INSERT INTO projects (
        id,
        name,
        telegram_chat_id,
        telegram_topic_id,
        telegram_topic_name,
        product_name,
        product_description,
        extra_prompting_rules,
        target_audience,
        cta,
        mode,
        automation_enabled,
        daily_generation_limit,
        selected_model,
        is_active,
        primary_reference_image_id,
        reference_images,
        text_style,
        created_at,
        updated_at
      )
      VALUES (
        $1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
        $11, $12, $13, $14, $15, $16, $17::jsonb, $18::jsonb, $19::timestamptz, $20::timestamptz
      )
      ON CONFLICT (id) DO UPDATE
      SET
        name = EXCLUDED.name,
        telegram_chat_id = EXCLUDED.telegram_chat_id,
        telegram_topic_id = EXCLUDED.telegram_topic_id,
        telegram_topic_name = EXCLUDED.telegram_topic_name,
        product_name = EXCLUDED.product_name,
        product_description = EXCLUDED.product_description,
        extra_prompting_rules = EXCLUDED.extra_prompting_rules,
        target_audience = EXCLUDED.target_audience,
        cta = EXCLUDED.cta,
        mode = EXCLUDED.mode,
        automation_enabled = EXCLUDED.automation_enabled,
        daily_generation_limit = EXCLUDED.daily_generation_limit,
        selected_model = EXCLUDED.selected_model,
        is_active = EXCLUDED.is_active,
        primary_reference_image_id = EXCLUDED.primary_reference_image_id,
        reference_images = EXCLUDED.reference_images,
        text_style = EXCLUDED.text_style,
        updated_at = EXCLUDED.updated_at
      RETURNING *
    `,
    [
      project.id,
      project.name,
      project.telegramChatId,
      project.telegramTopicId,
      project.telegramTopicName,
      project.productName,
      project.productDescription,
      project.extraPromptingRules,
      project.targetAudience,
      project.cta,
      project.mode,
      project.automationEnabled,
      project.dailyGenerationLimit,
      project.selectedModel,
      project.isActive,
      project.primaryReferenceImageId,
      JSON.stringify(project.referenceImages),
      JSON.stringify(project.textStyle || {}),
      project.createdAt,
      project.updatedAt,
    ]
  );

  return mapRowToProject(result.rows[0] as ProjectRow);
}

export const projectStore = {
  async listProjects(): Promise<Project[]> {
    await ensureStorage();
    const result = await query<ProjectRow>('SELECT * FROM projects ORDER BY updated_at DESC');
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
        LIMIT 1
      `,
      [normalizeString(telegramChatId), normalizeString(telegramTopicId)]
    );

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

    const nextProject = sanitizeProjectInput(input, existing);
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

    await query('DELETE FROM projects WHERE id = $1', [normalizeString(projectId)]);

    await Promise.all(
      existing.referenceImages.map(async (image: ReferenceImage) => {
        const imagePath = path.join(uploadsDir, image.storedName);
        if (await fs.pathExists(imagePath)) {
          await fs.remove(imagePath);
        }
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

    const extension = safeFileExtension(payload.mimeType, payload.originalName);
    const storedName = `${Date.now()}-${randomUUID()}${extension}`;
    const outputPath = path.join(uploadsDir, storedName);
    const buffer = Buffer.from(payload.contentBase64, 'base64');

    await fs.writeFile(outputPath, buffer);

    return {
      id: randomUUID(),
      originalName: normalizeString(payload.originalName) || storedName,
      storedName,
      mimeType: normalizeString(payload.mimeType) || 'application/octet-stream',
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
        const mimeType = image.mimeType || 'application/octet-stream';
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
    const updatedProject = await this.updateProject(projectId, {
      ...project,
      referenceImages,
    });

    const imagePath = this.getReferenceImageAbsolutePath(removedImage);
    if (await fs.pathExists(imagePath)) {
      await fs.remove(imagePath);
    }

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

    const imagePath = path.join(uploadsDir, normalizedStoredName);
    if (!(await fs.pathExists(imagePath))) {
      return false;
    }

    await fs.remove(imagePath);
    return true;
  },

  getUploadsDir(): string {
    return uploadsDir;
  },
};
