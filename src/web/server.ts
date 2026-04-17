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
import { ReferenceAudioService } from '../services/reference-audio.service.js';
import { bot } from '../bot/bot.js';

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

    if (!YandexDiskService.isConfigured()) {
      sendJson(res, 200, { tasks });
      return true;
    }

    const hydratedTasks = [];
    for (const task of tasks) {
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

      const generatedVideosFolder = YandexDiskService.getGeneratedVideosProjectFolderPath(project.name);
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
