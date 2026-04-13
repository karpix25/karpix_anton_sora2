import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { config } from '../config.js';

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

export class YandexDiskService {
  private static readonly baseUrl = 'https://cloud-api.yandex.net/v1/disk';
  private static readonly rootFolder = 'disk:/references sora 2';
  private static readonly generatedVideosRootFolder = 'disk:/ВИДЕО/SORA2';

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

  public static getGeneratedVideosProjectFolderPath(projectName: string): string {
    const safeProjectName = this.sanitizeDiskPathSegment(projectName);
    return `${this.generatedVideosRootFolder}/${safeProjectName}/${safeProjectName}`;
  }

  public static getGeneratedVideoDiskPath(projectName: string, fileName: string): string {
    const safeName = path.basename(fileName).replace(/[^\p{L}\p{N}._ -]+/gu, '-');
    return `${this.getGeneratedVideosProjectFolderPath(projectName)}/${safeName}`;
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
  }

  public static async deleteResource(diskPath: string): Promise<void> {
    if (!this.isConfigured() || !diskPath) {
      return;
    }

    try {
      await axios.delete(`${this.baseUrl}/resources`, {
        headers: getHeaders(),
        ...requestOptions,
        params: {
          path: diskPath,
          permanently: true,
        },
      });
    } catch (error: any) {
      if (error.response?.status !== 404) {
        throw error;
      }
    }
  }

  public static async uploadGeneratedVideo(input: {
    projectName: string;
    taskId: string;
    sourceVideoUrl: string;
  }): Promise<YandexUploadResult> {
    if (!this.isConfigured()) {
      throw new Error('Yandex Disk token is not configured');
    }

    const folderPath = this.getGeneratedVideosProjectFolderPath(input.projectName);
    const diskPath = this.getGeneratedVideoDiskPath(
      input.projectName,
      this.buildGeneratedVideoFileName(input.taskId, input.sourceVideoUrl)
    );

    await this.ensureFolder('disk:/ВИДЕО');
    await this.ensureFolder(this.generatedVideosRootFolder);
    await this.ensureFolder(path.posix.dirname(folderPath));
    await this.ensureFolder(folderPath);

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

    const folderPath = this.getGeneratedVideosProjectFolderPath(input.projectName);
    const diskPath = this.getGeneratedVideoDiskPath(
      input.projectName,
      input.fileName || this.buildGeneratedVideoFileName(input.taskId, input.filePath)
    );

    await this.ensureFolder('disk:/ВИДЕО');
    await this.ensureFolder(this.generatedVideosRootFolder);
    await this.ensureFolder(path.posix.dirname(folderPath));
    await this.ensureFolder(folderPath);

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

  private static buildGeneratedVideoFileName(taskId: string, sourceVideoUrl: string): string {
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const taskSuffix = taskId.slice(0, 8);
    const extension = this.getFileExtensionFromUrl(sourceVideoUrl);
    return `${timestamp}_${taskSuffix}${extension}`;
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
}
