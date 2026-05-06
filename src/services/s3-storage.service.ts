import path from 'node:path';
import fs from 'fs-extra';
import axios from 'axios';
import { PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { config } from '../config.js';

export interface S3UploadResult {
  bucket: string;
  objectKey: string;
  objectUrl: string;
  fileName: string;
  storedAt: string;
}

function sanitizeSegment(value: string, fallback: string): string {
  const normalized = String(value || '')
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}._-]+/gu, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-');
  return normalized || fallback;
}

export class S3StorageService {
  private static client: S3Client | null = null;

  public static isConfigured(): boolean {
    return config.s3.isConfigured;
  }

  public static async uploadGeneratedVideoFile(input: {
    projectId: string;
    projectCode: string;
    taskId: string;
    filePath: string;
    fileName?: string;
  }): Promise<S3UploadResult> {
    if (!this.isConfigured()) {
      throw new Error('S3 is not configured');
    }

    if (!(await fs.pathExists(input.filePath))) {
      throw new Error(`Generated video file does not exist: ${input.filePath}`);
    }

    const fileName = input.fileName || this.buildGeneratedVideoFileName(input.projectCode, input.taskId, input.filePath);
    const objectKey = this.buildObjectKey(input.projectId, input.projectCode, fileName);
    const bucket = config.s3.bucket;

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: fs.createReadStream(input.filePath),
        ContentType: 'video/mp4',
        Metadata: {
          project_id: input.projectId,
          project_code: input.projectCode || '',
          task_id: input.taskId,
        },
      })
    );

    return {
      bucket,
      objectKey,
      objectUrl: this.buildObjectUrl(bucket, objectKey),
      fileName,
      storedAt: new Date().toISOString(),
    };
  }

  public static async uploadGeneratedVideo(input: {
    projectId: string;
    projectCode: string;
    taskId: string;
    sourceVideoUrl: string;
    fileName?: string;
  }): Promise<S3UploadResult> {
    if (!this.isConfigured()) {
      throw new Error('S3 is not configured');
    }

    const fileName =
      input.fileName || this.buildGeneratedVideoFileName(input.projectCode, input.taskId, input.sourceVideoUrl);
    const objectKey = this.buildObjectKey(input.projectId, input.projectCode, fileName);
    const bucket = config.s3.bucket;

    const response = await axios.get(input.sourceVideoUrl, {
      responseType: 'stream',
      timeout: 120000,
      maxContentLength: Infinity,
    });

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: response.data,
        ContentType: response.headers['content-type'] || 'video/mp4',
        Metadata: {
          project_id: input.projectId,
          project_code: input.projectCode || '',
          task_id: input.taskId,
          source: 'generated_original',
        },
      })
    );

    return {
      bucket,
      objectKey,
      objectUrl: this.buildObjectUrl(bucket, objectKey),
      fileName,
      storedAt: new Date().toISOString(),
    };
  }

  private static getClient(): S3Client {
    if (!this.client) {
      this.client = new S3Client({
        region: config.s3.region,
        endpoint: config.s3.endpoint,
        forcePathStyle: config.s3.forcePathStyle,
        credentials: {
          accessKeyId: config.s3.accessKeyId,
          secretAccessKey: config.s3.secretAccessKey,
        },
      });
    }

    return this.client;
  }

  private static buildObjectKey(projectId: string, projectCode: string, fileName: string): string {
    const safeProjectCode = sanitizeSegment(projectCode, 'PRJ');
    const safeProjectId = sanitizeSegment(projectId, 'project');
    const safeFileName = sanitizeSegment(path.basename(fileName), 'video.mp4');
    return `projects/${safeProjectCode}/${safeProjectId}/videos/${safeFileName}`;
  }

  private static buildObjectUrl(bucket: string, objectKey: string): string {
    const encodedKey = objectKey
      .split('/')
      .filter(Boolean)
      .map((segment) => encodeURIComponent(segment))
      .join('/');

    if (config.s3.publicBaseUrl) {
      return `${config.s3.publicBaseUrl}/${encodedKey}`;
    }

    const base = config.s3.endpoint.replace(/\/+$/, '');
    return `${base}/${encodeURIComponent(bucket)}/${encodedKey}`;
  }

  private static buildGeneratedVideoFileName(projectCode: string, taskId: string, sourceVideoPath: string): string {
    const now = new Date();
    const yyyymmdd = `${now.getUTCFullYear()}${String(now.getUTCMonth() + 1).padStart(2, '0')}${String(now.getUTCDate()).padStart(2, '0')}`;
    const hhmmss = `${String(now.getUTCHours()).padStart(2, '0')}${String(now.getUTCMinutes()).padStart(2, '0')}${String(now.getUTCSeconds()).padStart(2, '0')}`;
    const projectCodePart = sanitizeSegment(projectCode.toUpperCase(), 'PRJ').slice(0, 12);
    const taskSuffix = taskId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toLowerCase() || 'task';
    const extension = this.getFileExtensionFromSource(sourceVideoPath);
    return `p${projectCodePart}_${yyyymmdd}_${hhmmss}_${taskSuffix}${extension}`;
  }

  private static getFileExtensionFromSource(source: string): string {
    try {
      const pathname = new URL(source).pathname;
      const extension = path.extname(pathname);
      return extension || '.mp4';
    } catch {
      const extension = path.extname(source);
      return extension || '.mp4';
    }
  }
}
