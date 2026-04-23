import type { Project } from '../domain/project.js';
import { projectStore } from '../storage/project-store.js';
import { TelegramMediaService } from './telegram-media.service.js';
import { YandexDiskService } from './yandex-disk.service.js';

export class ProjectReferenceService {
  public static async getGenerationReferenceImageUrl(
    project: Project,
    fallbackImageUrl?: string
  ): Promise<string | null> {
    const primaryImage = projectStore.getPrimaryReferenceImage(project);
    if (!primaryImage) {
      return fallbackImageUrl || null;
    }
    return this.ensureImageAndGetUrl(project, primaryImage);
  }

  public static async getAllGenerationReferenceImageUrls(
    project: Project
  ): Promise<string[]> {
    const images = (project.referenceImages || []).slice(0, 5);
    if (images.length === 0) return [];

    const urls = await Promise.all(
      images.map(img => this.ensureImageAndGetUrl(project, img).catch(err => {
        console.warn(`[ProjectReferenceService] Failed to sync secondary image ${img.id}:`, err.message);
        return null;
      }))
    );

    return urls.filter((url): url is string => url !== null);
  }

  private static async ensureImageAndGetUrl(
    project: Project,
    image: any
  ): Promise<string | null> {
    if (image.yandexDiskPath && YandexDiskService.isConfigured()) {
      const refreshedDownloadUrl = await YandexDiskService.getDownloadUrlForPath(image.yandexDiskPath);

      await projectStore.updateReferenceImageYandexSync(project.id, image.id, {
        yandexDiskPath: image.yandexDiskPath,
        yandexDownloadUrl: refreshedDownloadUrl,
        yandexSyncedAt: new Date().toISOString(),
      });

      return refreshedDownloadUrl;
    }

    if (YandexDiskService.isConfigured()) {
      const upload = await YandexDiskService.uploadReferenceImage({
        projectName: project.name,
        projectId: project.id,
        fileName: image.originalName || image.storedName,
        filePath: projectStore.getReferenceImageAbsolutePath(image),
      });

      await projectStore.updateReferenceImageYandexSync(project.id, image.id, {
        yandexDiskPath: upload.diskPath,
        yandexDownloadUrl: upload.downloadUrl,
        yandexSyncedAt: upload.syncedAt,
      });

      return upload.downloadUrl;
    }

    if (!project.telegramChatId || !project.telegramTopicId || !TelegramMediaService.isConfigured()) {
      return null;
    }

    if (image.telegramFileId) {
      return TelegramMediaService.getFileDownloadUrl(image.telegramFileId);
    }

    const upload = await TelegramMediaService.uploadReferenceImageToTopic({
      chatId: project.telegramChatId,
      topicId: project.telegramTopicId,
      filePath: projectStore.getReferenceImageAbsolutePath(image),
      fileName: image.originalName || image.storedName,
      caption: `SOra2 reference image for project ${project.name}`,
    });

    await projectStore.updateReferenceImageTelegramSync(project.id, image.id, {
      telegramFileId: upload.fileId,
      telegramMessageId: upload.messageId,
      telegramSyncedAt: upload.syncedAt,
    });

    return upload.fileUrl;
  }
}
