import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { S3StorageService } from './s3-storage.service.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const dataDir = path.resolve(__dirname, '../../data/reference-audio');
const ffprobePath = 'ffprobe';

function nowIso(): string {
  return new Date().toISOString();
}

function runFfmpeg(args: string[]): Promise<void> {
  return new Promise((resolve, reject) => {
    const process = spawn('ffmpeg', args, {
      stdio: ['ignore', 'ignore', 'pipe'],
    });

    let stderr = '';
    process.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    process.on('error', (error) => {
      reject(new Error(`Не удалось запустить ffmpeg: ${error.message}`));
    });

    process.on('close', (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`ffmpeg завершился с ошибкой: ${stderr.trim() || `code ${code}`}`));
    });
  });
}

function runFfprobeDuration(inputPath: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const process = spawn(ffprobePath, [
      '-v',
      'error',
      '-show_entries',
      'format=duration',
      '-of',
      'default=noprint_wrappers=1:nokey=1',
      inputPath,
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    process.stdout.on('data', (chunk) => {
      stdout += String(chunk);
    });

    process.stderr.on('data', (chunk) => {
      stderr += String(chunk);
    });

    process.on('error', (error) => {
      reject(new Error(`Не удалось запустить ffprobe: ${error.message}`));
    });

    process.on('close', (code) => {
      if (code !== 0) {
        reject(new Error(`ffprobe завершился с ошибкой: ${stderr.trim() || `code ${code}`}`));
        return;
      }

      const duration = Number.parseFloat(stdout.trim());
      if (!Number.isFinite(duration) || duration <= 0) {
        reject(new Error('ffprobe не вернул длительность аудио'));
        return;
      }

      resolve(duration);
    });
  });
}

export interface ReferenceAudioDetails {
  audioFilePath: string;
  durationSeconds: number;
}

export class ReferenceAudioService {
  public static getAudioRelativePath(itemId: string): string {
    return `reference-audio/${itemId}.m4a`;
  }

  public static getAudioAbsolutePath(audioFilePath: string): string {
    return path.resolve(path.join(__dirname, '../../data', audioFilePath));
  }

  public static async ensureAudioTrack(item: ReferenceLibraryItem): Promise<ReferenceAudioDetails> {
    if (item.audioFilePath) {
      const existingAudioPath = this.getAudioAbsolutePath(item.audioFilePath);
      if (await fs.pathExists(existingAudioPath)) {
        const durationSeconds = item.durationSeconds > 0
          ? item.durationSeconds
          : await runFfprobeDuration(existingAudioPath);

        if (durationSeconds !== item.durationSeconds) {
          await referenceLibraryStore.updateItem(item.id, {
            durationSeconds,
          });
        }

        await this.ensureAudioStoredInS3(item, existingAudioPath);

        return {
          audioFilePath: existingAudioPath,
          durationSeconds,
        };
      }
    }

    const restoredAudio = await this.restoreAudioTrackFromS3(item);
    if (restoredAudio) {
      return restoredAudio;
    }

    if (!item.directVideoUrl) {
      throw new Error('У Reel нет direct video URL для извлечения аудио');
    }

    await fs.ensureDir(dataDir);
    const outputPath = path.join(dataDir, `${item.id}.m4a`);

    await runFfmpeg([
      '-y',
      '-i',
      item.directVideoUrl,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      outputPath,
    ]);

    const durationSeconds = await runFfprobeDuration(outputPath);

    const update: Parameters<typeof referenceLibraryStore.updateItem>[1] = {
      audioFilePath: this.getAudioRelativePath(item.id),
      audioStoredAt: nowIso(),
      durationSeconds,
    };

    const s3Upload = await this.tryUploadAudioToS3(item, outputPath);
    if (s3Upload) {
      update.audioS3Bucket = s3Upload.bucket;
      update.audioS3ObjectKey = s3Upload.objectKey;
      update.audioS3ObjectUrl = s3Upload.objectUrl;
      update.audioS3StoredAt = s3Upload.storedAt;
    }

    await referenceLibraryStore.updateItem(item.id, update);

    return {
      audioFilePath: outputPath,
      durationSeconds,
    };
  }

  private static async restoreAudioTrackFromS3(item: ReferenceLibraryItem): Promise<ReferenceAudioDetails | null> {
    if (!item.audioS3ObjectKey || !S3StorageService.isConfigured()) {
      return null;
    }

    const outputPath = path.join(dataDir, `${item.id}.m4a`);
    try {
      await S3StorageService.downloadObjectToFile({
        bucket: item.audioS3Bucket,
        objectKey: item.audioS3ObjectKey,
        filePath: outputPath,
      });

      const durationSeconds = item.durationSeconds > 0
        ? item.durationSeconds
        : await runFfprobeDuration(outputPath);

      await referenceLibraryStore.updateItem(item.id, {
        audioFilePath: this.getAudioRelativePath(item.id),
        audioStoredAt: item.audioStoredAt || nowIso(),
        durationSeconds,
      });

      console.log(`[ReferenceAudioService] Restored reference audio ${item.id} from S3.`);
      return {
        audioFilePath: outputPath,
        durationSeconds,
      };
    } catch (error: any) {
      console.warn(`[ReferenceAudioService] Failed to restore reference audio ${item.id} from S3: ${error.message}`);
      return null;
    }
  }

  private static async ensureAudioStoredInS3(item: ReferenceLibraryItem, audioFilePath: string): Promise<void> {
    if (item.audioS3ObjectKey || !S3StorageService.isConfigured()) {
      return;
    }

    const s3Upload = await this.tryUploadAudioToS3(item, audioFilePath);
    if (!s3Upload) {
      return;
    }

    await referenceLibraryStore.updateItem(item.id, {
      audioS3Bucket: s3Upload.bucket,
      audioS3ObjectKey: s3Upload.objectKey,
      audioS3ObjectUrl: s3Upload.objectUrl,
      audioS3StoredAt: s3Upload.storedAt,
    });
  }

  private static async tryUploadAudioToS3(
    item: ReferenceLibraryItem,
    audioFilePath: string
  ): Promise<Awaited<ReturnType<typeof S3StorageService.uploadReferenceAudioFile>> | null> {
    if (!S3StorageService.isConfigured()) {
      return null;
    }

    try {
      const upload = await S3StorageService.uploadReferenceAudioFile({
        projectId: item.projectId,
        referenceLibraryItemId: item.id,
        filePath: audioFilePath,
      });
      console.log(`[ReferenceAudioService] Stored reference audio ${item.id} in S3 (${upload.objectKey}).`);
      return upload;
    } catch (error: any) {
      console.warn(`[ReferenceAudioService] Failed to store reference audio ${item.id} in S3: ${error.message}`);
      return null;
    }
  }

  public static async extractTemporaryAudioTrack(videoUrl: string): Promise<ReferenceAudioDetails> {
    const normalizedUrl = typeof videoUrl === 'string' ? videoUrl.trim() : '';
    if (!normalizedUrl) {
      throw new Error('Video URL is required to extract temporary audio track');
    }

    await fs.ensureDir(dataDir);
    const tempName = `tmp-${Date.now()}-${Math.random().toString(36).slice(2, 10)}.m4a`;
    const outputPath = path.join(dataDir, tempName);

    await runFfmpeg([
      '-y',
      '-i',
      normalizedUrl,
      '-vn',
      '-c:a',
      'aac',
      '-b:a',
      '192k',
      outputPath,
    ]);

    const durationSeconds = await runFfprobeDuration(outputPath);
    return {
      audioFilePath: outputPath,
      durationSeconds,
    };
  }
}
