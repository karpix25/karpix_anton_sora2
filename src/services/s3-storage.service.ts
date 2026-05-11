import path from 'node:path';
import fs from 'fs-extra';
import axios from 'axios';
import { GetObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
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

    const fileBuffer = await fs.readFile(input.filePath);

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: fileBuffer,
        ContentLength: fileBuffer.length,
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

    const isLocalPath = input.sourceVideoUrl.startsWith('/') || input.sourceVideoUrl.startsWith('.') || !input.sourceVideoUrl.includes('://');

    if (isLocalPath) {
      if (!(await fs.pathExists(input.sourceVideoUrl))) {
        throw new Error(`Source video file does not exist: ${input.sourceVideoUrl}`);
      }

      const fileBuffer = await fs.readFile(input.sourceVideoUrl);

      await this.getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: fileBuffer,
          ContentLength: fileBuffer.length,
          ContentType: 'video/mp4',
          Metadata: {
            project_id: input.projectId,
            project_code: input.projectCode || '',
            task_id: input.taskId,
            source: 'generated_original_local',
          },
        })
      );
    } else {
      const response = await axios.get(input.sourceVideoUrl, {
        responseType: 'arraybuffer',
        timeout: 120000,
        maxContentLength: Infinity,
      });

      const buffer = Buffer.from(response.data);

      await this.getClient().send(
        new PutObjectCommand({
          Bucket: bucket,
          Key: objectKey,
          Body: buffer,
          ContentLength: buffer.length,
          ContentType: response.headers['content-type'] || 'video/mp4',
          Metadata: {
            project_id: input.projectId,
            project_code: input.projectCode || '',
            task_id: input.taskId,
            source: 'generated_original_remote',
          },
        })
      );
    }

    return {
      bucket,
      objectKey,
      objectUrl: this.buildObjectUrl(bucket, objectKey),
      fileName,
      storedAt: new Date().toISOString(),
    };
  }

  public static async uploadReferenceAudioFile(input: {
    projectId: string;
    referenceLibraryItemId: string;
    filePath: string;
    fileName?: string;
  }): Promise<S3UploadResult> {
    if (!this.isConfigured()) {
      throw new Error('S3 is not configured');
    }

    if (!(await fs.pathExists(input.filePath))) {
      throw new Error(`Reference audio file does not exist: ${input.filePath}`);
    }

    const fileName = input.fileName || this.buildReferenceAudioFileName(input.referenceLibraryItemId, input.filePath);
    const objectKey = this.buildReferenceAudioObjectKey(input.projectId, fileName);
    const bucket = config.s3.bucket;
    const fileBuffer = await fs.readFile(input.filePath);

    await this.getClient().send(
      new PutObjectCommand({
        Bucket: bucket,
        Key: objectKey,
        Body: fileBuffer,
        ContentLength: fileBuffer.length,
        ContentType: 'audio/mp4',
        Metadata: {
          project_id: input.projectId,
          reference_library_item_id: input.referenceLibraryItemId,
          source: 'reference_audio',
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

  public static async downloadObjectToFile(input: {
    bucket: string;
    objectKey: string;
    filePath: string;
  }): Promise<void> {
    if (!this.isConfigured()) {
      throw new Error('S3 is not configured');
    }

    const response = await this.getClient().send(
      new GetObjectCommand({
        Bucket: input.bucket || config.s3.bucket,
        Key: input.objectKey,
      })
    );

    if (!response.Body) {
      throw new Error(`S3 object has no body: ${input.objectKey}`);
    }

    const buffer = await this.streamToBuffer(response.Body);
    await fs.ensureDir(path.dirname(input.filePath));
    await fs.writeFile(input.filePath, buffer);
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

  private static buildReferenceAudioObjectKey(projectId: string, fileName: string): string {
    const safeProjectId = sanitizeSegment(projectId, 'project');
    const safeFileName = sanitizeSegment(path.basename(fileName), 'audio.m4a');
    return `projects/${safeProjectId}/reference-audio/${safeFileName}`;
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

  private static buildReferenceAudioFileName(referenceLibraryItemId: string, sourceAudioPath: string): string {
    const itemSuffix = referenceLibraryItemId.replace(/[^A-Za-z0-9]/g, '').slice(0, 12).toLowerCase() || 'reference';
    const extension = path.extname(sourceAudioPath) || '.m4a';
    return `reference_${itemSuffix}${extension}`;
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

  private static async streamToBuffer(body: any): Promise<Buffer> {
    if (Buffer.isBuffer(body)) {
      return body;
    }

    const chunks: Buffer[] = [];
    for await (const chunk of body) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  }
}
