import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type { Project, ProjectInput, ReferenceImage } from '../domain/project.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data');
const uploadsDir = path.join(dataDir, 'uploads', 'reference-images');
const projectsFilePath = path.join(dataDir, 'projects.json');

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

  return {
    id: existing?.id ?? randomUUID(),
    name: normalizeString(input.name) || existing?.name || 'New Project',
    telegramChatId: normalizeString(input.telegramChatId ?? existing?.telegramChatId),
    telegramTopicId: normalizeString(input.telegramTopicId ?? existing?.telegramTopicId),
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
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

async function ensureStorage(): Promise<void> {
  await fs.ensureDir(uploadsDir);

  if (!(await fs.pathExists(projectsFilePath))) {
    await fs.writeJson(projectsFilePath, { projects: [] }, { spaces: 2 });
  }
}

async function loadProjects(): Promise<Project[]> {
  await ensureStorage();
  const data = (await fs.readJson(projectsFilePath)) as { projects?: ProjectInput[] };
  const projects = Array.isArray(data.projects) ? data.projects : [];
  return projects.map((project) => sanitizeProjectInput(project, project as Project));
}

async function saveProjects(projects: Project[]): Promise<void> {
  await ensureStorage();
  await fs.writeJson(projectsFilePath, { projects }, { spaces: 2 });
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

export const projectStore = {
  async listProjects(): Promise<Project[]> {
    const projects = await loadProjects();
    return projects.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
  },

  async getProject(projectId: string): Promise<Project | null> {
    const projects = await loadProjects();
    return projects.find((project) => project.id === projectId) ?? null;
  },

  async findProjectByTelegramBinding(telegramChatId: string, telegramTopicId: string): Promise<Project | null> {
    const projects = await loadProjects();
    return projects.find(
      (project) =>
        project.telegramChatId === normalizeString(telegramChatId) &&
        project.telegramTopicId === normalizeString(telegramTopicId)
    ) ?? null;
  },

  async createProject(input: ProjectInput): Promise<Project> {
    const projects = await loadProjects();
    const project = sanitizeProjectInput(input);
    projects.unshift(project);
    await saveProjects(projects);
    return project;
  },

  async updateProject(projectId: string, input: ProjectInput): Promise<Project | null> {
    const projects = await loadProjects();
    const index = projects.findIndex((project) => project.id === projectId);
    if (index === -1) {
      return null;
    }

    const nextProject = sanitizeProjectInput(input, projects[index]);
    projects[index] = nextProject;
    await saveProjects(projects);
    return nextProject;
  },

  async bindProjectToTelegramTopic(
    projectId: string,
    telegramChatId: string,
    telegramTopicId: string
  ): Promise<Project | null> {
    const projects = await loadProjects();
    const targetIndex = projects.findIndex((project) => project.id === projectId);
    if (targetIndex === -1) {
      return null;
    }

    const normalizedChatId = normalizeString(telegramChatId);
    const normalizedTopicId = normalizeString(telegramTopicId);

    const nextProjects = projects.map((project, index) => {
      if (
        index !== targetIndex &&
        project.telegramChatId === normalizedChatId &&
        project.telegramTopicId === normalizedTopicId
      ) {
        return sanitizeProjectInput(
          {
            ...project,
            telegramChatId: '',
            telegramTopicId: '',
          },
          project
        );
      }

      if (index === targetIndex) {
        return sanitizeProjectInput(
          {
            ...project,
            telegramChatId: normalizedChatId,
            telegramTopicId: normalizedTopicId,
          },
          project
        );
      }

      return project;
    });

    await saveProjects(nextProjects);
    return nextProjects[targetIndex] ?? null;
  },

  async deleteProject(projectId: string): Promise<boolean> {
    const projects = await loadProjects();
    const existing = projects.find((project) => project.id === projectId);
    if (!existing) {
      return false;
    }

    const filtered = projects.filter((project) => project.id !== projectId);
    await saveProjects(filtered);

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
