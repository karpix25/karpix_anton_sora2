import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import fs from 'fs-extra';
import type { ProjectInput } from '../domain/project.js';
import { projectStore } from '../storage/project-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { config } from '../config.js';
import { TelegramMediaService } from '../services/telegram-media.service.js';
import { YandexDiskService } from '../services/yandex-disk.service.js';
import { ManualGenerationService } from '../services/manual-generation.service.js';
import { ParserService } from '../services/parser.service.js';
import { ReferenceAudioService } from '../services/reference-audio.service.js';
import { bot } from '../bot/bot.js';
import type { GenerationTask } from '../domain/generation-task.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, 'public');

const contentTypes: Record<string, string> = {
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.webp': 'image/webp',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
};

function sendJson(res: ServerResponse, statusCode: number, payload: unknown): void {
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify(payload));
}

function sendNotFound(res: ServerResponse): void {
  sendJson(res, 404, { error: 'Not found' });
}

async function readJsonBody<T>(req: IncomingMessage): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  const limit = 15 * 1024 * 1024;

  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > limit) {
      throw new Error('Request body is too large');
    }
    chunks.push(buffer);
  }

  const raw = Buffer.concat(chunks).toString('utf8');
  return raw ? (JSON.parse(raw) as T) : ({} as T);
}

function readSecretHeader(req: IncomingMessage): string {
  const value = req.headers['x-telegram-bot-api-secret-token'];
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    return value[0] || '';
  }

  return '';
}

function getDateKey(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return String(value || '').slice(0, 10);
  }
  return date.toISOString().slice(0, 10);
}

function isAutoGenerationTask(task: GenerationTask): boolean {
  return task.triggerMode === 'auto' || task.triggerMode === 'auto_remix';
}

function buildAutoDailyPositionMap(tasks: GenerationTask[], dailyLimit: number): Map<string, number> {
  const positions = new Map<string, number>();
  const orderedTasks = [...tasks].sort(
    (a, b) => Date.parse(a.createdAt || '') - Date.parse(b.createdAt || '')
  );
  const countedByDay = new Map<string, number>();

  for (const task of orderedTasks) {
    const day = getDateKey(task.createdAt);
    const countedBefore = countedByDay.get(day) || 0;

    if (isAutoGenerationTask(task)) {
      positions.set(task.id, Math.min(countedBefore + 1, Math.max(1, dailyLimit)));

      if (task.status !== 'failed') {
        countedByDay.set(day, countedBefore + 1);
      }
    }
  }

  return positions;
}

async function handleTelegramWebhook(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (!config.telegram.isConfigured || !config.telegram.webhook.enabled) {
    return false;
  }

  if (pathname !== config.telegram.webhook.path) {
    return false;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  const expectedSecret = config.telegram.webhook.secretToken.trim();
  if (expectedSecret && readSecretHeader(req) !== expectedSecret) {
    sendJson(res, 403, { error: 'Forbidden' });
    return true;
  }

  const update = await readJsonBody<Record<string, unknown>>(req);
  res.writeHead(200, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
  });
  res.end(JSON.stringify({ ok: true }));

  void bot.handleUpdate(update as any).catch((error: any) => {
    console.error('Telegram webhook update error:', error?.message || error);
  });

  return true;
}

async function handlePublicationWebhook(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname !== '/api/webhooks/publications') {
    return false;
  }

  if (req.method !== 'POST') {
    sendJson(res, 405, { error: 'Method not allowed' });
    return true;
  }

  try {
    const payload = await readJsonBody<{ taskId: string; publicationUrl: string }>(req);
    if (!payload.taskId || !payload.publicationUrl) {
      sendJson(res, 400, { error: 'taskId and publicationUrl are required' });
      return true;
    }

    let task = await generationTaskStore.getTask(payload.taskId);
    if (!task && payload.taskId.length >= 8) {
      task = await generationTaskStore.findByShortId(payload.taskId);
    }

    if (!task) {
      sendJson(res, 404, { error: 'Task not found' });
      return true;
    }

    const updatedTask = await generationTaskStore.updateTask(task.id, {
      publicationUrl: payload.publicationUrl,
    });

    console.log(`[Webhook] Updated task ${payload.taskId} with publication URL: ${payload.publicationUrl}`);
    sendJson(res, 200, { ok: true, taskId: task.id });
    return true;
  } catch (error: any) {
    sendJson(res, 400, { error: 'Invalid JSON body' });
    return true;
  }
}

async function serveFile(res: ServerResponse, filePath: string): Promise<void> {
  if (!(await fs.pathExists(filePath))) {
    sendNotFound(res);
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const contentType = contentTypes[ext] ?? 'application/octet-stream';
  res.writeHead(200, {
    'Content-Type': contentType,
    'Cache-Control': 'no-store',
  });
  fs.createReadStream(filePath).pipe(res);
}

function getRouteParams(pathname: string): { projectId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)$/);
  return match?.[1] ? { projectId: match[1] } : {};
}

function getProjectLibraryRouteParams(pathname: string): { projectId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/library$/);
  return match?.[1] ? { projectId: match[1] } : {};
}

function getProjectGenerationsRouteParams(pathname: string): { projectId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/generations$/);
  return match?.[1] ? { projectId: match[1] } : {};
}

function getProjectPrimaryImageSyncRouteParams(pathname: string): { projectId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/reference-images\/primary\/sync-telegram$/);
  return match?.[1] ? { projectId: match[1] } : {};
}

function getProjectYandexSyncRouteParams(pathname: string): { projectId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/reference-images\/sync-yandex$/);
  return match?.[1] ? { projectId: match[1] } : {};
}

function getProjectReferenceImageRouteParams(pathname: string): { projectId?: string; imageId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/reference-images\/([^/]+)$/);
  return match?.[1] && match?.[2] ? { projectId: match[1], imageId: match[2] } : {};
}

function getProjectPrimaryReferenceImageRouteParams(pathname: string): { projectId?: string; imageId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/reference-images\/([^/]+)\/primary$/);
  return match?.[1] && match?.[2] ? { projectId: match[1], imageId: match[2] } : {};
}

function getProjectLibraryGenerationRouteParams(pathname: string): { projectId?: string; itemId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/library\/([^/]+)\/generate$/);
  return match?.[1] && match?.[2] ? { projectId: match[1], itemId: match[2] } : {};
}

function getTaskRemixRouteParams(pathname: string): { taskId?: string } {
  const match = pathname.match(/^\/api\/tasks\/([^/]+)\/remix$/);
  return match?.[1] ? { taskId: match[1] } : {};
}

function getProjectLibraryItemRouteParams(pathname: string): { projectId?: string; itemId?: string } {
  const match = pathname.match(/^\/api\/projects\/([^/]+)\/library\/([^/]+)$/);
  return match?.[1] && match?.[2] ? { projectId: match[1], itemId: match[2] } : {};
}

function getUploadReferenceImageRouteParams(pathname: string): { storedName?: string } {
  const match = pathname.match(/^\/api\/uploads\/reference-images\/([^/]+)$/);
  return match?.[1] ? { storedName: decodeURIComponent(match[1]) } : {};
}

function isWithinDirectory(baseDir: string, targetPath: string): boolean {
  const normalizedBase = path.resolve(baseDir);
  const normalizedTarget = path.resolve(targetPath);
  return normalizedTarget.startsWith(`${normalizedBase}${path.sep}`) || normalizedTarget === normalizedBase;
}

async function handleApi(req: IncomingMessage, res: ServerResponse, pathname: string): Promise<boolean> {
  if (pathname === '/api/health' && req.method === 'GET') {
    sendJson(res, 200, { ok: true });
    return true;
  }

  if (pathname === '/api/dashboard/history' && req.method === 'GET') {
    const projects = await projectStore.listProjects();
    const projectById = new Map(projects.map((project) => [project.id, project]));
    const events: any[] = [];
    const today = new Date().toISOString().slice(0, 10);
    let autoPlannedToday = 0;
    let autoCompletedToday = 0;
    let autoProcessingToday = 0;
    let autoStartedToday = 0;

    for (const project of projects) {
      const [items, tasks] = await Promise.all([
        referenceLibraryStore.listProjectItems(project.id),
        generationTaskStore.listProjectTasks(project.id),
      ]);

      const itemById = new Map(items.map((item) => [item.id, item]));
      const autoDailyPositionByTaskId = buildAutoDailyPositionMap(tasks, project.dailyGenerationLimit);
      const autoTasksToday = tasks.filter(
        (task) => isAutoGenerationTask(task) && getDateKey(task.createdAt) === today
      );
      const autoStartedForProjectToday = autoTasksToday.filter((task) => task.status !== 'failed').length;
      const autoCompletedForProjectToday = autoTasksToday.filter((task) => task.status === 'completed').length;
      const autoProcessingForProjectToday = autoTasksToday.filter((task) => task.status === 'processing' || task.status === 'pending').length;
      const reusableReferenceCount = items.filter((item) => {
        if (item.status !== 'analyzed' || !item.analysis) {
          return false;
        }
        return tasks.some((task) => task.referenceLibraryItemId === item.id && task.status === 'completed');
      }).length;
      const projectAutoPlannedToday = project.isActive && project.automationEnabled && project.dailyGenerationLimit > 0 && reusableReferenceCount > 0
        ? project.dailyGenerationLimit
        : 0;
      const projectQueueRemaining = projectAutoPlannedToday > 0
        ? Math.max(0, projectAutoPlannedToday - autoStartedForProjectToday)
        : 0;
      autoPlannedToday += projectAutoPlannedToday;
      autoCompletedToday += autoCompletedForProjectToday;
      autoProcessingToday += autoProcessingForProjectToday;
      autoStartedToday += autoStartedForProjectToday;

      for (const item of items) {
        events.push({
          id: `reference:${item.id}`,
          type: 'reference',
          eventAt: item.createdAt,
          projectId: project.id,
          projectName: project.name,
          projectCode: project.projectCode,
          title: 'Входящий референс',
          status: item.status,
          referenceLibraryItemId: item.id,
          sourceUrl: item.sourceUrl,
          directVideoUrl: item.directVideoUrl,
          thumbnailUrl: item.thumbnailUrl,
          hasAnalysis: Boolean(item.analysis),
          hasAudio: Boolean(item.audioFilePath || item.audioS3ObjectKey),
          errorMessage: item.errorMessage,
          createdAt: item.createdAt,
          updatedAt: item.updatedAt,
        });
      }

      for (const task of tasks) {
        const item = itemById.get(task.referenceLibraryItemId);
        const isAuto = task.triggerMode === 'auto' || task.triggerMode === 'auto_remix';
        const isRemix = task.triggerMode === 'auto_remix' || task.triggerMode === 'web_manual_remix';

        events.push({
          id: `generation:${task.id}`,
          type: 'generation',
          eventAt: task.createdAt,
          projectId: task.projectId,
          projectName: projectById.get(task.projectId)?.name || project.name,
          projectCode: projectById.get(task.projectId)?.projectCode || project.projectCode,
          title: isRemix ? 'Ремикс' : isAuto ? 'Автогенерация' : 'Ручная генерация',
          status: task.status,
          triggerMode: task.triggerMode,
          targetModel: task.targetModel,
          provider: task.provider,
          autoDailyIndex: isAuto ? autoDailyPositionByTaskId.get(task.id) || 0 : 0,
          autoDailyLimit: isAuto ? project.dailyGenerationLimit : 0,
          projectQueueRemaining,
          taskId: task.id,
          referenceLibraryItemId: task.referenceLibraryItemId,
          referenceSourceUrl: item?.sourceUrl || '',
          remixSourceTaskId: task.remixSourceTaskId,
          remixSourceUrl: task.remixSourceUrl,
          promptText: task.promptText,
          resultVideoUrl: task.resultVideoUrl,
          s3ObjectUrl: task.s3ObjectUrl,
          yandexDownloadUrl: task.yandexDownloadUrl,
          yandexDiskPath: task.yandexDiskPath,
          publicationUrl: task.publicationUrl,
          videoFileName: task.videoFileName,
          views: 0,
          errorMessage: task.errorMessage,
          startedAt: task.startedAt,
          finishedAt: task.finishedAt,
          createdAt: task.createdAt,
          updatedAt: task.updatedAt,
        });
      }
    }

    const publicationUrls = events
      .filter((event) => event.type === 'generation' && event.publicationUrl)
      .map((event) => event.publicationUrl);
    const viewsMap = await ParserService.getViewCountsMap(publicationUrls);
    const hydratedEvents = events.map((event) => event.publicationUrl
      ? { ...event, views: viewsMap[event.publicationUrl] || 0 }
      : event
    );

    hydratedEvents.sort((a, b) => Date.parse(b.eventAt || b.createdAt || '') - Date.parse(a.eventAt || a.createdAt || ''));
    sendJson(res, 200, {
      events: hydratedEvents.slice(0, 500),
      totals: {
        projects: projects.length,
        references: hydratedEvents.filter((event) => event.type === 'reference').length,
        generations: hydratedEvents.filter((event) => event.type === 'generation').length,
        completed: hydratedEvents.filter((event) => event.type === 'generation' && event.status === 'completed').length,
        failed: hydratedEvents.filter((event) => event.type === 'generation' && event.status === 'failed').length,
        processing: hydratedEvents.filter((event) => event.type === 'generation' && event.status === 'processing').length,
        autoPlannedToday,
        autoCompletedToday,
        autoProcessingToday,
        autoStartedToday,
        autoRemainingToday: Math.max(0, autoPlannedToday - autoStartedToday),
      },
    });
    return true;
  }

  if (pathname === '/api/fonts/google-cyrillic' && req.method === 'GET') {
    const { GoogleFontsService } = await import('../services/google-fonts.service.js');
    const fonts = await GoogleFontsService.listCyrillicFonts();
    sendJson(res, 200, { fonts });
    return true;
  }

  if (pathname === '/api/system/config' && req.method === 'GET') {
    const { systemConfigStore } = await import('../storage/system-config-store.js');
    const config = await systemConfigStore.getConfig();
    sendJson(res, 200, config);
    return true;
  }

  if (pathname === '/api/system/config' && req.method === 'PUT') {
    const { systemConfigStore } = await import('../storage/system-config-store.js');
    const payload = await readJsonBody<any>(req);
    const config = await systemConfigStore.updateConfig(payload);
    sendJson(res, 200, config);
    return true;
  }

  if (pathname === '/api/yandex/generated-folders' && req.method === 'GET') {
    const folders = await YandexDiskService.listGeneratedVideoFolders();
    sendJson(res, 200, { folders });
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'GET') {
    const projects = await projectStore.listProjects();
    sendJson(res, 200, { projects });
    return true;
  }

  if (pathname === '/api/projects' && req.method === 'POST') {
    const payload = await readJsonBody<ProjectInput>(req);
    const project = await projectStore.createProject(payload);
    sendJson(res, 201, { project });
    return true;
  }

  if (pathname === '/api/uploads/reference-images' && req.method === 'POST') {
    const payload = await readJsonBody<{
      originalName?: string;
      mimeType?: string;
      contentBase64?: string;
    }>(req);

    if (!payload.contentBase64) {
      sendJson(res, 400, { error: 'contentBase64 is required' });
      return true;
    }

    const image = await projectStore.saveReferenceImage({
      originalName: payload.originalName ?? 'reference-image',
      mimeType: payload.mimeType ?? 'application/octet-stream',
      contentBase64: payload.contentBase64,
    });

    sendJson(res, 201, { image });
    return true;
  }

  const uploadImageRoute = getUploadReferenceImageRouteParams(pathname);
  if (uploadImageRoute.storedName && req.method === 'DELETE') {
    const deleted = await projectStore.deleteUploadedReferenceImage(uploadImageRoute.storedName);
    if (!deleted) {
      sendNotFound(res);
      return true;
    }

    res.writeHead(204);
    res.end();
    return true;
  }

  const libraryRoute = getProjectLibraryRouteParams(pathname);
  if (libraryRoute.projectId && req.method === 'GET') {
    const items = await referenceLibraryStore.listProjectItems(libraryRoute.projectId);
    sendJson(res, 200, { items });
    return true;
  }

  const libraryItemRoute = getProjectLibraryItemRouteParams(pathname);
  if (libraryItemRoute.projectId && libraryItemRoute.itemId && req.method === 'DELETE') {
    const item = await referenceLibraryStore.getItem(libraryItemRoute.itemId);
    if (!item || item.projectId !== libraryItemRoute.projectId) {
      sendNotFound(res);
      return true;
    }

    const referenceTasks = await generationTaskStore.listReferenceTasks(item.id);
    for (const task of referenceTasks) {
      if (task.yandexDiskPath) {
        await YandexDiskService.deleteResource(task.yandexDiskPath);
      }
    }

    if (item.audioFilePath) {
      const audioPath = ReferenceAudioService.getAudioAbsolutePath(item.audioFilePath);
      if (await fs.pathExists(audioPath)) {
        await fs.remove(audioPath);
      }
    }

    await generationTaskStore.deleteReferenceTasks(item.id);
    await referenceLibraryStore.deleteItem(item.id);

    res.writeHead(204);
    res.end();
    return true;
  }

  const generationsRoute = getProjectGenerationsRouteParams(pathname);
  if (generationsRoute.projectId && req.method === 'GET') {
    const tasks = await generationTaskStore.listProjectTasks(generationsRoute.projectId);

    // Fetch view counts for tasks with publication URLs
    const publicationUrls = tasks
      .map(t => t.publicationUrl)
      .filter((url): url is string => !!url);
    
    const viewsMap = await ParserService.getViewCountsMap(publicationUrls);

    // Attach views to tasks
    const tasksWithViews = tasks.map(task => ({
      ...task,
      views: task.publicationUrl ? (viewsMap[task.publicationUrl] || 0) : 0
    }));

    if (!YandexDiskService.isConfigured()) {
      sendJson(res, 200, { tasks: tasksWithViews });
      return true;
    }

    const hydratedTasks = [];
    for (const task of tasksWithViews) {
      if (task.status !== 'completed' || !task.yandexDiskPath) {
        hydratedTasks.push(task);
        continue;
      }

      try {
        const refreshedDownloadUrl = await YandexDiskService.getDownloadUrlForPath(task.yandexDiskPath);
        if (!refreshedDownloadUrl || refreshedDownloadUrl === task.yandexDownloadUrl) {
          hydratedTasks.push(task);
          continue;
        }

        const updatedTask = await generationTaskStore.updateTask(task.id, {
          yandexDownloadUrl: refreshedDownloadUrl,
        });
        hydratedTasks.push(updatedTask || { ...task, yandexDownloadUrl: refreshedDownloadUrl });
      } catch (error: any) {
        if (error?.response?.status === 404) {
          const updatedTask = task.yandexDownloadUrl
            ? await generationTaskStore.updateTask(task.id, { yandexDownloadUrl: '' })
            : null;
          hydratedTasks.push(updatedTask || { ...task, yandexDownloadUrl: '' });
          continue;
        }

        console.warn(
          `[WebServer] Failed to refresh Yandex download URL for generation task ${task.id}:`,
          error?.message || error
        );
        hydratedTasks.push(task);
      }
    }

    sendJson(res, 200, { tasks: hydratedTasks });
    return true;
  }

  const primaryImageSyncRoute = getProjectPrimaryImageSyncRouteParams(pathname);
  if (primaryImageSyncRoute.projectId && req.method === 'POST') {
    const project = await projectStore.getProject(primaryImageSyncRoute.projectId);
    if (!project) {
      sendNotFound(res);
      return true;
    }

    if (!project.telegramChatId || !project.telegramTopicId) {
      sendJson(res, 400, { error: 'Project is not bound to a Telegram topic' });
      return true;
    }

    if (!TelegramMediaService.isConfigured()) {
      sendJson(res, 400, { error: 'Telegram bot token is not configured' });
      return true;
    }

    const primaryImage = projectStore.getPrimaryReferenceImage(project.referenceImages);
    if (!primaryImage) {
      sendJson(res, 400, { error: 'Project has no reference images' });
      return true;
    }

    const upload = await TelegramMediaService.uploadReferenceImageToTopic({
      chatId: project.telegramChatId,
      topicId: project.telegramTopicId,
      filePath: projectStore.getReferenceImageAbsolutePath(primaryImage),
      fileName: primaryImage.originalName || primaryImage.storedName,
      caption: `SOra2 reference image for project ${project.name}`,
    });

    const updatedProject = await projectStore.updateReferenceImageTelegramSync(project.id, primaryImage.id, {
      telegramFileId: upload.fileId,
      telegramMessageId: upload.messageId,
      telegramSyncedAt: upload.syncedAt,
    });

    const updatedPrimaryImage = updatedProject
      ? projectStore.getPrimaryReferenceImage(updatedProject.referenceImages)
      : null;

    sendJson(res, 200, {
      image: updatedPrimaryImage,
      fileUrl: upload.fileUrl,
    });
    return true;
  }

  const yandexSyncRoute = getProjectYandexSyncRouteParams(pathname);
  if (yandexSyncRoute.projectId && req.method === 'POST') {
    const project = await projectStore.getProject(yandexSyncRoute.projectId);
    if (!project) {
      sendNotFound(res);
      return true;
    }

    if (!YandexDiskService.isConfigured()) {
      sendJson(res, 400, { error: 'Yandex Disk token is not configured' });
      return true;
    }

    if (!project.referenceImages.length) {
      sendJson(res, 400, { error: 'Project has no reference images' });
      return true;
    }

    let updatedProject = project;
    for (const image of project.referenceImages) {
      const upload = await YandexDiskService.uploadReferenceImage({
        projectName: project.name,
        projectId: project.id,
        fileName: image.originalName || image.storedName,
        filePath: projectStore.getReferenceImageAbsolutePath(image),
      });

      const nextProject = await projectStore.updateReferenceImageYandexSync(project.id, image.id, {
        yandexDiskPath: upload.diskPath,
        yandexDownloadUrl: upload.downloadUrl,
        yandexSyncedAt: upload.syncedAt,
      });

      if (nextProject) {
        updatedProject = nextProject;
      }
    }

    sendJson(res, 200, {
      project: updatedProject,
      primaryImage: projectStore.getPrimaryReferenceImage(updatedProject.referenceImages),
    });
    return true;
  }

  const projectReferenceImageRoute = getProjectReferenceImageRouteParams(pathname);
  if (projectReferenceImageRoute.projectId && projectReferenceImageRoute.imageId && req.method === 'DELETE') {
    const result = await projectStore.deleteProjectReferenceImage(
      projectReferenceImageRoute.projectId,
      projectReferenceImageRoute.imageId
    );

    if (!result.project && !result.removedImage) {
      sendNotFound(res);
      return true;
    }

    if (result.removedImage?.yandexDiskPath && YandexDiskService.isConfigured()) {
      await YandexDiskService.deleteResource(result.removedImage.yandexDiskPath);
    }

    sendJson(res, 200, {
      project: result.project,
      removedImage: result.removedImage,
    });
    return true;
  }

  const projectPrimaryReferenceImageRoute = getProjectPrimaryReferenceImageRouteParams(pathname);
  if (
    projectPrimaryReferenceImageRoute.projectId &&
    projectPrimaryReferenceImageRoute.imageId &&
    req.method === 'POST'
  ) {
    const project = await projectStore.setPrimaryReferenceImage(
      projectPrimaryReferenceImageRoute.projectId,
      projectPrimaryReferenceImageRoute.imageId
    );

    if (!project) {
      sendNotFound(res);
      return true;
    }

    sendJson(res, 200, { project });
    return true;
  }

  const projectLibraryGenerationRoute = getProjectLibraryGenerationRouteParams(pathname);
  if (
    projectLibraryGenerationRoute.projectId &&
    projectLibraryGenerationRoute.itemId &&
    req.method === 'POST'
  ) {
    const task = await ManualGenerationService.runFromLibraryItem({
      projectId: projectLibraryGenerationRoute.projectId,
      referenceLibraryItemId: projectLibraryGenerationRoute.itemId,
      triggerMode: 'web_manual',
    });

    sendJson(res, 200, { task });
    return true;
  }

  const taskRemixRoute = getTaskRemixRouteParams(pathname);
  if (taskRemixRoute.taskId && req.method === 'POST') {
    try {
      const task = await ManualGenerationService.runManualRemix(taskRemixRoute.taskId);
      sendJson(res, 200, { task });
    } catch (error: any) {
      sendJson(res, 400, { error: error.message });
    }
    return true;
  }

  const { projectId } = getRouteParams(pathname);
  if (!projectId) {
    return false;
  }

  if (req.method === 'GET') {
    const project = await projectStore.getProject(projectId);
    if (!project) {
      sendNotFound(res);
      return true;
    }

    sendJson(res, 200, { project });
    return true;
  }

  if (req.method === 'PUT') {
    const payload = await readJsonBody<ProjectInput>(req);
    const project = await projectStore.updateProject(projectId, payload);
    if (!project) {
      sendNotFound(res);
      return true;
    }

    sendJson(res, 200, { project });
    return true;
  }

  if (req.method === 'DELETE') {
    const project = await projectStore.getProject(projectId);
    if (project && YandexDiskService.isConfigured()) {
      for (const image of project.referenceImages) {
        if (image.yandexDiskPath) {
          await YandexDiskService.deleteResource(image.yandexDiskPath);
        }
      }

      const tasks = await generationTaskStore.listProjectTasks(projectId);
      for (const task of tasks) {
        if (task.yandexDiskPath) {
          await YandexDiskService.deleteResource(task.yandexDiskPath);
        }
      }

      const generatedVideosFolder = YandexDiskService.getGeneratedVideosProjectFolderPath(
        project.name,
        project.yandexDiskFolder
      );
      await YandexDiskService.deleteResource(generatedVideosFolder);
      await YandexDiskService.deleteResource(path.posix.dirname(generatedVideosFolder));
    }

    await referenceLibraryStore.deleteProjectItems(projectId);
    await generationTaskStore.deleteProjectTasks(projectId);
    const deleted = await projectStore.deleteProject(projectId);
    if (!deleted) {
      sendNotFound(res);
      return true;
    }

    res.writeHead(204);
    res.end();
    return true;
  }

  return false;
}

async function handleStatic(res: ServerResponse, pathname: string): Promise<void> {
  if (pathname === '/' || pathname === '/index.html') {
    await serveFile(res, path.join(publicDir, 'index.html'));
    return;
  }

  if (pathname.startsWith('/uploads/')) {
    const relativePath = pathname.replace('/uploads/', '');
    const filePath = path.join(projectStore.getUploadsDir(), '..', relativePath);
    if (!isWithinDirectory(path.join(projectStore.getUploadsDir(), '..'), filePath)) {
      sendNotFound(res);
      return;
    }

    await serveFile(res, filePath);
    return;
  }

  const filePath = path.join(publicDir, pathname.replace(/^\//, ''));
  if (!isWithinDirectory(publicDir, filePath)) {
    sendNotFound(res);
    return;
  }

  await serveFile(res, filePath);
}

export async function startWebServer(): Promise<void> {
  const server = createServer(async (req, res) => {
    try {
      if (!req.url) {
        sendNotFound(res);
        return;
      }

      const url = new URL(req.url, 'http://localhost');
      const handledWebhook = await handleTelegramWebhook(req, res, url.pathname);
      if (handledWebhook) {
        return;
      }

      const handledPublication = await handlePublicationWebhook(req, res, url.pathname);
      if (handledPublication) {
        return;
      }

      const handledApi = await handleApi(req, res, url.pathname);
      if (handledApi) {
        return;
      }

      if (req.method === 'GET') {
        await handleStatic(res, url.pathname);
        return;
      }

      sendNotFound(res);
    } catch (error: any) {
      console.error('Web server error:', error.message);
      sendJson(res, 500, { error: error.message || 'Internal server error' });
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.web.port, config.web.host, () => {
      server.off('error', reject);
      console.log(`🌐 Web admin is running on http://${config.web.host}:${config.web.port}`);
      resolve();
    });
  });

  const shutdown = () => {
    server.close();
  };

  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
}
