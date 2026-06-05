import { spawn } from 'node:child_process';

interface NormalizePortraitVideoInput {
  inputPath: string;
  outputPath: string;
  width?: number;
  height?: number;
}

export class VideoNormalizeService {
  public static async normalizePortraitVideo(input: NormalizePortraitVideoInput): Promise<void> {
    const width = input.width ?? 720;
    const height = input.height ?? 1280;
    const filter = [
      `scale=${width}:${height}:force_original_aspect_ratio=increase`,
      `crop=${width}:${height}`,
      'setsar=1',
      'format=yuv420p',
    ].join(',');

    await this.runFfmpeg([
      '-y',
      '-i',
      input.inputPath,
      '-vf',
      filter,
      '-map',
      '0:v:0',
      '-map',
      '0:a?',
      '-c:v',
      'libx264',
      '-crf',
      '18',
      '-preset',
      'fast',
      '-c:a',
      'aac',
      '-movflags',
      '+faststart',
      input.outputPath,
    ]);
  }

  private static runFfmpeg(args: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      const process = spawn('ffmpeg', args, {
        stdio: ['ignore', 'ignore', 'pipe'],
      });

      let stderr = '';
      process.stderr.on('data', (chunk) => {
        stderr += String(chunk);
      });

      process.on('error', (error) => {
        reject(new Error(`Failed to start ffmpeg: ${error.message}`));
      });

      process.on('close', (code) => {
        if (code === 0) {
          resolve();
          return;
        }

        reject(new Error(stderr.trim() || `ffmpeg exited with code ${code}`));
      });
    });
  }
}
