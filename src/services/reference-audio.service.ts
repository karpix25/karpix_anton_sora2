import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import fs from 'fs-extra';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';

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

        return {
          audioFilePath: existingAudioPath,
          durationSeconds,
        };
      }
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

    await referenceLibraryStore.updateItem(item.id, {
      audioFilePath: this.getAudioRelativePath(item.id),
      audioStoredAt: nowIso(),
      durationSeconds,
    });

    return {
      audioFilePath: outputPath,
      durationSeconds,
    };
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
