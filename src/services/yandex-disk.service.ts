import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { config } from '../config.js';
import { AdminNotifierService } from './admin-notifier.service.js';

const requestOptions = {
  family: 4 as const,
  timeout: 20000,
};

function getHeaders() {
  return {
    Authorization: `OAuth ${config.yandexDisk.token}`,
  };
}

function slugify(value: string): string {
  return value
    .toLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
    .slice(0, 80) || 'project';
}

export interface YandexUploadResult {
  diskPath: string;
  downloadUrl: string;
  syncedAt: string;
}

export interface YandexFolderOption {
  path: string;
  name: string;
  relativePath: string;
}

export class YandexDiskService {
  private static readonly baseUrl = 'https://cloud-api.yandex.net/v1/disk';
  private static readonly rootFolder = 'disk:/references sora 2';
  private static readonly generatedVideosParentFolder = 'disk:/ВИДЕО';
  private static readonly generatedVideosRootFolder = 'disk:/ВИДЕО/SORA2';
  private static readonly protectedDeletePaths = new Set([
    'disk:',
    'disk:/',
    'disk:/ВИДЕО',
    'disk:/ВИДЕО/SORA2',
    'disk:/references sora 2',
  ]);

  public static isConfigured(): boolean {
    return config.yandexDisk.isConfigured;
  }

  public static getProjectFolderPath(projectName: string, projectId: string): string {
    return `${this.rootFolder}/${slugify(projectName)}-${projectId.slice(0, 8)}`;
  }

  public static getReferenceImageDiskPath(projectName: string, projectId: string, fileName: string): string {
    const safeName = path.basename(fileName).replace(/[^\p{L}\p{N}._-]+/gu, '-');
    return `${this.getProjectFolderPath(projectName, projectId)}/${safeName}`;
  }

  public static getGeneratedVideosProjectFolderPath(projectName: string, projectFolder?: string): string {
    return this.getGeneratedVideosFolderPath(projectName, projectFolder);
  }

  public static getGeneratedVideosFolderPath(projectName: string, projectFolder?: string): string {
    const customFolder = this.sanitizeDiskRelativePath(projectFolder || '');
    if (customFolder) {
      return `${this.generatedVideosRootFolder}/${customFolder}`;
    }

    const safeProjectName = this.sanitizeDiskPathSegment(projectName);
    return `${this.generatedVideosRootFolder}/${safeProjectName}/${safeProjectName}`;
  }

  public static getGeneratedVideoDiskPath(projectName: string, fileName: string, projectFolder?: string): string {
    const safeName = path.basename(fileName).replace(/[^\p{L}\p{N}._ -]+/gu, '-');
    return `${this.getGeneratedVideosFolderPath(projectName, projectFolder)}/${safeName}`;
  }

  public static async listGeneratedVideoFolders(maxDepth = 8): Promise<YandexFolderOption[]> {
    if (!this.isConfigured()) {
      throw new Error('Yandex Disk token is not configured');
    }

    await this.ensureFolder('disk:/ВИДЕО');
    await this.ensureFolder(this.generatedVideosRootFolder);

    const folders: YandexFolderOption[] = [];
    await this.collectFolders(this.generatedVideosRootFolder, '', 0, Math.max(1, Math.min(maxDepth, 8)), folders);

    return folders.sort((a, b) => a.relativePath.localeCompare(b.relativePath, 'ru'));
  }

  public static async uploadReferenceImage(input: {
    projectName: string;
    projectId: string;
    fileName: string;
    filePath: string;
  }): Promise<YandexUploadResult> {
    if (!this.isConfigured()) {
      throw new Error('Yandex Disk token is not configured');
    }

    if (!(await fs.pathExists(input.filePath))) {
      throw new Error(`Reference image file does not exist: ${input.filePath}`);
    }

    const folderPath = this.getProjectFolderPath(input.projectName, input.projectId);
    const diskPath = this.getReferenceImageDiskPath(input.projectName, input.projectId, input.fileName);

    await this.ensureFolder(this.rootFolder);
    await this.ensureFolder(folderPath);

    try {
      const uploadUrl = await this.getUploadUrl(diskPath);
      await axios.put(uploadUrl, await fs.readFile(input.filePath), {
        headers: {
          'Content-Type': 'application/octet-stream',
        },
        ...requestOptions,
        maxBodyLength: Infinity,
      });

      const downloadUrl = await this.getDownloadUrlForPath(diskPath);

      return {
        diskPath,
        downloadUrl,
        syncedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.handleDiskError('Upload Reference', error);
      throw new Error(`Yandex Disk operation failed (Yandex Disk): ${error.message}`);
    }
  }

  public static async deleteResource(diskPath: string): Promise<void> {
    if (!this.isConfigured() || !diskPath) {
      return;
    }

    const safeDiskPath = this.assertSafeDeletePath(diskPath);
    console.log(`[YandexDiskService] Deleting resource: ${safeDiskPath}`);

    try {
      await axios.delete(`${this.baseUrl}/resources`, {
        headers: getHeaders(),
        ...requestOptions,
        params: {
          path: safeDiskPath,
          permanently: false,
        },
      });
    } catch (error: any) {
      if (error.response?.status !== 404) {
        this.handleDiskError('Delete Resource', error);
        throw new Error(`Yandex Disk operation failed (Yandex Disk): ${error.message}`);
      }
    }
  }

  public static async uploadGeneratedVideo(input: {
    projectName: string;
    projectFolder?: string;
    projectCode?: string;
    taskId: string;
    sourceVideoUrl: string;
  }): Promise<YandexUploadResult> {
    if (!this.isConfigured()) {
      throw new Error('Yandex Disk token is not configured');
    }

    const folderPath = this.getGeneratedVideosFolderPath(input.projectName, input.projectFolder);
    const diskPath = this.getGeneratedVideoDiskPath(
      input.projectName,
      this.buildGeneratedVideoFileName(input.projectCode ?? '', input.taskId, input.sourceVideoUrl),
      input.projectFolder
    );

    await this.ensureGeneratedVideosFolder(folderPath);

    const uploadUrl = await this.getUploadUrl(diskPath);
    const videoResponse = await axios.get(input.sourceVideoUrl, {
      ...requestOptions,
      responseType: 'stream',
      maxContentLength: Infinity,
      timeout: 120000,
    });

    await axios.put(uploadUrl, videoResponse.data, {
      headers: {
        'Content-Type': videoResponse.headers['content-type'] || 'video/mp4',
      },
      ...requestOptions,
      maxBodyLength: Infinity,
      maxContentLength: Infinity,
      timeout: 600000,
    });

    const downloadUrl = await this.getDownloadUrlForPath(diskPath);

    return {
      diskPath,
      downloadUrl,
      syncedAt: new Date().toISOString(),
    };
  }

  public static async uploadGeneratedVideoFile(input: {
    projectName: string;
    projectFolder?: string;
    projectCode?: string;
    taskId: string;
    filePath: string;
    fileName?: string;
  }): Promise<YandexUploadResult> {
    if (!this.isConfigured()) {
      throw new Error('Yandex Disk token is not configured');
    }

    if (!(await fs.pathExists(input.filePath))) {
      throw new Error(`Generated video file does not exist: ${input.filePath}`);
    }

    const folderPath = this.getGeneratedVideosFolderPath(input.projectName, input.projectFolder);
    const diskPath = this.getGeneratedVideoDiskPath(
      input.projectName,
      input.fileName || this.buildGeneratedVideoFileName(input.projectCode ?? '', input.taskId, input.filePath),
      input.projectFolder
    );

    await this.ensureGeneratedVideosFolder(folderPath);

    try {
      const uploadUrl = await this.getUploadUrl(diskPath);
      await axios.put(uploadUrl, fs.createReadStream(input.filePath), {
        headers: {
          'Content-Type': 'video/mp4',
        },
        ...requestOptions,
        maxBodyLength: Infinity,
        maxContentLength: Infinity,
        timeout: 600000,
      });

      const downloadUrl = await this.getDownloadUrlForPath(diskPath);

      return {
        diskPath,
        downloadUrl,
        syncedAt: new Date().toISOString(),
      };
    } catch (error: any) {
      this.handleDiskError('Upload Generated Video File', error);
      throw new Error(`Yandex Disk operation failed (Yandex Disk): ${error.message}`);
    }
  }

  private static handleDiskError(operation: string, error: any): void {
    const status = error.response?.status;
    const errorData = error.response?.data;
    const details = errorData ? JSON.stringify(errorData) : error.message;

    console.error(`[YandexDiskService] ${operation} error (status=${status}):`, details);

    // Detect auth or space errors
    if (status === 401 || status === 403 || status === 507) {
      console.warn(`[YandexDiskService] Detected critical Yandex Disk error (${status}). Notifying admins...`);
      AdminNotifierService.notifyBalanceError('Yandex Disk', `[${status}] ${details}`).catch(err => 
        console.error('[YandexDiskService] Failed to notify admins:', err.message)
      );
    }
  }

  private static async ensureFolder(folderPath: string): Promise<void> {
    try {
      await axios.put(`${this.baseUrl}/resources`, null, {
        headers: getHeaders(),
        ...requestOptions,
        params: {
          path: folderPath,
        },
      });
    } catch (error: any) {
      const status = error.response?.status;
      if (status !== 409) {
        throw error;
      }
    }
  }

  private static async ensureGeneratedVideosFolder(folderPath: string): Promise<void> {
    await this.ensureFolder(this.generatedVideosParentFolder);
    await this.ensureFolder(this.generatedVideosRootFolder);

    const relativePath = folderPath
      .slice(this.generatedVideosRootFolder.length)
      .replace(/^\/+/, '');
    let currentPath = this.generatedVideosRootFolder;

    for (const segment of relativePath.split('/').filter(Boolean)) {
      currentPath = `${currentPath}/${segment}`;
      await this.ensureFolder(currentPath);
    }
  }

  private static async collectFolders(
    folderPath: string,
    relativePath: string,
    depth: number,
    maxDepth: number,
    folders: YandexFolderOption[]
  ): Promise<void> {
    if (depth >= maxDepth) {
      return;
    }

    const response = await axios.get(`${this.baseUrl}/resources`, {
      headers: getHeaders(),
      ...requestOptions,
      params: {
        path: folderPath,
        limit: 200,
        fields: '_embedded.items.name,_embedded.items.path,_embedded.items.type',
      },
    });

    const items = Array.isArray(response.data?._embedded?.items)
      ? response.data._embedded.items
      : [];

    for (const item of items) {
      if (item?.type !== 'dir' || typeof item.name !== 'string' || typeof item.path !== 'string') {
        continue;
      }

      const nextRelativePath = [relativePath, item.name].filter(Boolean).join('/');
      folders.push({
        path: item.path,
        name: item.name,
        relativePath: nextRelativePath,
      });

      await this.collectFolders(item.path, nextRelativePath, depth + 1, maxDepth, folders);
    }
  }

  private static async getUploadUrl(diskPath: string): Promise<string> {
    const response = await axios.get(`${this.baseUrl}/resources/upload`, {
      headers: getHeaders(),
      ...requestOptions,
      params: {
        path: diskPath,
        overwrite: true,
      },
    });

    const href = response.data?.href;
    if (!href) {
      throw new Error('Yandex Disk upload URL was not returned');
    }

    return href;
  }

  public static async getDownloadUrlForPath(diskPath: string): Promise<string> {
    const response = await axios.get(`${this.baseUrl}/resources/download`, {
      headers: getHeaders(),
      ...requestOptions,
      params: {
        path: diskPath,
      },
    });

    const href = response.data?.href;
    if (!href) {
      throw new Error('Yandex Disk download URL was not returned');
    }

    return href;
  }

  private static sanitizeDiskPathSegment(value: string): string {
    const normalized = value
      .normalize('NFKC')
      .replace(/[\\/:*?"<>|]+/g, '-')
      .replace(/\s+/g, ' ')
      .trim();

    return normalized || 'Project';
  }

  private static buildGeneratedVideoFileName(projectCode: string, taskId: string, sourceVideoUrl: string): string {
    const now = new Date();
    const yyyymmdd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const hhmmss = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
    const projectCodePart = this.normalizeProjectCode(projectCode);
    const taskSuffix = taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'task';
    const extension = this.getFileExtensionFromUrl(sourceVideoUrl);
    return `p${projectCodePart}_${yyyymmdd}_${hhmmss}_${taskSuffix}${extension}`;
  }

  private static normalizeProjectCode(value: string): string {
    const normalized = String(value || '')
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, 12);

    return normalized || 'PRJ';
  }

  private static getFileExtensionFromUrl(sourceVideoUrl: string): string {
    try {
      const pathname = new URL(sourceVideoUrl).pathname;
      const extension = path.extname(pathname);
      return extension || '.mp4';
    } catch {
      return '.mp4';
    }
  }

  private static sanitizeDiskRelativePath(value: string): string {
    return value
      .split('/')
      .map((segment) => this.sanitizeDiskPathSegment(segment))
      .filter(Boolean)
      .join('/');
  }

  private static assertSafeDeletePath(diskPath: string): string {
    const normalizedPath = this.normalizeDiskPath(diskPath);

    if (this.protectedDeletePaths.has(normalizedPath)) {
      throw new Error(`Refusing to delete protected Yandex Disk path: ${normalizedPath}`);
    }

    const isReferenceResource = normalizedPath.startsWith(`${this.rootFolder}/`);
    const isGeneratedVideoResource = normalizedPath.startsWith(`${this.generatedVideosRootFolder}/`);
    if (!isReferenceResource && !isGeneratedVideoResource) {
      throw new Error(`Refusing to delete Yandex Disk path outside managed roots: ${normalizedPath}`);
    }

    return normalizedPath;
  }

  private static normalizeDiskPath(diskPath: string): string {
    const normalizedPath = String(diskPath || '')
      .trim()
      .replace(/\\/g, '/')
      .replace(/\/{2,}/g, '/')
      .replace(/^disk:\//, 'disk:/')
      .replace(/\/+$/g, '');

    return normalizedPath || 'disk:/';
  }
}
