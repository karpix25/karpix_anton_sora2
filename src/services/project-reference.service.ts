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

    if (primaryImage.yandexDiskPath && YandexDiskService.isConfigured()) {
      const refreshedDownloadUrl = await YandexDiskService.getDownloadUrlForPath(primaryImage.yandexDiskPath);

      await projectStore.updateReferenceImageYandexSync(project.id, primaryImage.id, {
        yandexDiskPath: primaryImage.yandexDiskPath,
        yandexDownloadUrl: refreshedDownloadUrl,
        yandexSyncedAt: new Date().toISOString(),
      });

      return refreshedDownloadUrl;
    }

    if (YandexDiskService.isConfigured()) {
      const upload = await YandexDiskService.uploadReferenceImage({
        projectName: project.name,
        projectId: project.id,
        fileName: primaryImage.originalName || primaryImage.storedName,
        filePath: projectStore.getReferenceImageAbsolutePath(primaryImage),
      });

      await projectStore.updateReferenceImageYandexSync(project.id, primaryImage.id, {
        yandexDiskPath: upload.diskPath,
        yandexDownloadUrl: upload.downloadUrl,
        yandexSyncedAt: upload.syncedAt,
      });

      return upload.downloadUrl;
    }

    if (!project.telegramChatId || !project.telegramTopicId || !TelegramMediaService.isConfigured()) {
      return null;
    }

    if (primaryImage.telegramFileId) {
      return TelegramMediaService.getFileDownloadUrl(primaryImage.telegramFileId);
    }

    const upload = await TelegramMediaService.uploadReferenceImageToTopic({
      chatId: project.telegramChatId,
      topicId: project.telegramTopicId,
      filePath: projectStore.getReferenceImageAbsolutePath(primaryImage),
      fileName: primaryImage.originalName || primaryImage.storedName,
      caption: `SOra2 reference image for project ${project.name}`,
    });

    await projectStore.updateReferenceImageTelegramSync(project.id, primaryImage.id, {
      telegramFileId: upload.fileId,
      telegramMessageId: upload.messageId,
      telegramSyncedAt: upload.syncedAt,
    });

    return upload.fileUrl;
  }
}
