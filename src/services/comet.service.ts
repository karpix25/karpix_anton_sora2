import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import { config } from '../config.js';
import { AdminNotifierService } from './admin-notifier.service.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadsDir = path.resolve(__dirname, '../../data/comet-downloads');
const cometDebugHeaders = [
  'x-request-id',
  'x-comet-request-id',
  'cf-ray',
  'cf-cache-status',
  'server',
  'content-type',
  'date',
];

export class CometService {
  /**
   * Limit: 10 generation requests per 10 seconds.
   */
  private static generationRateLimiter = new RateLimiter(10, 10000);

  private static safeSerialize(value: unknown, maxLength = 4000): string {
    if (value === null || value === undefined) {
      return '';
    }

    try {
      const raw = typeof value === 'string' ? value : JSON.stringify(value);
      if (!raw) {
        return '';
      }
      return raw.length > maxLength ? `${raw.slice(0, maxLength)}... [truncated]` : raw;
    } catch {
      return '[unserializable]';
    }
  }

  private static pickDebugHeaders(headers: unknown): Record<string, string> {
    if (!headers || typeof headers !== 'object') {
      return {};
    }

    const source = headers as Record<string, unknown>;
    const picked: Record<string, string> = {};
    for (const key of cometDebugHeaders) {
      const value = source[key];
      if (value !== undefined && value !== null) {
        picked[key] = String(value);
      }
    }
    return picked;
  }

  private static buildAxiosDebugContext(error: any): string {
    const method = String(error?.config?.method || '').toUpperCase() || 'UNKNOWN';
    const requestUrl = error?.config?.url || 'unknown-url';
    const baseURL = error?.config?.baseURL;
    const fullUrl = baseURL && typeof requestUrl === 'string' && !requestUrl.startsWith('http')
      ? `${String(baseURL).replace(/\/+$/, '')}/${requestUrl.replace(/^\/+/, '')}`
      : requestUrl;
    const status = error?.response?.status ?? 'n/a';
    const statusText = error?.response?.statusText || '';
    const code = error?.code || 'n/a';
    const responseHeaders = this.pickDebugHeaders(error?.response?.headers);
    const responseData = this.safeSerialize(error?.response?.data, 6000);
    const message = error?.message || 'unknown error';
    const details: string[] = [
      `message=${message}`,
      `code=${code}`,
      `request=${method} ${fullUrl}`,
      `status=${status}${statusText ? ` ${statusText}` : ''}`,
    ];

    if (Object.keys(responseHeaders).length) {
      details.push(`headers=${JSON.stringify(responseHeaders)}`);
    }
    if (responseData) {
      details.push(`response=${responseData}`);
    }
    return details.join(' | ');
  }

  private static isCometBalanceError(error: any): boolean {
    const statusCode = Number(error?.response?.status || 0);
    const errorData = error?.response?.data;
    const code = String(
      errorData?.code ||
      errorData?.error?.code ||
      ''
    ).toLowerCase();
    const message = String(
      errorData?.message ||
      errorData?.error?.message ||
      error?.message ||
      ''
    ).toLowerCase();

    if (statusCode === 402) {
      return true;
    }

    if (statusCode === 403 && code.includes('insufficient_user_quota')) {
      return true;
    }

    return (
      code.includes('quota') ||
      code.includes('insufficient') ||
      message.includes('quota') ||
      message.includes('balance') ||
      message.includes('credits') ||
      message.includes('not enough funds') ||
      message.includes('pre-consume quota') ||
      message.includes('remaining quota')
    );
  }

  private static sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static normalizeStatus(status: unknown): string {
    return String(status || '').trim().toLowerCase();
  }

  private static isCompletedStatus(status: unknown): boolean {
    const normalized = this.normalizeStatus(status);
    return normalized === 'completed' || normalized === 'success' || normalized === 'succeeded';
  }

  private static isFailureStatus(status: unknown): boolean {
    const normalized = this.normalizeStatus(status);
    return normalized === 'failure' || normalized === 'failed' || normalized === 'error' || normalized === 'cancelled';
  }

  private static extractVideoId(payload: any): string | null {
    const candidateValues = [
      payload?.video_id,
      payload?.id,
      payload?.data?.video_id,
      payload?.data?.id,
      payload?.result?.video_id,
      payload?.result?.id,
      payload?.output?.video_id,
      payload?.output?.id,
      payload?.video?.id,
    ];

    for (const candidate of candidateValues) {
      if (typeof candidate === 'string' && candidate.trim()) {
        return candidate.trim();
      }
    }
    return null;
  }

  private static parseProgress(progress: unknown): number | null {
    if (typeof progress === 'number' && Number.isFinite(progress)) {
      return progress;
    }

    if (typeof progress === 'string') {
      const cleaned = progress.replace('%', '').trim();
      const parsed = Number(cleaned);
      if (Number.isFinite(parsed)) {
        return parsed;
      }
    }

    return null;
  }

  /**
   * Triggers video generation on Comet API.
   * @param prompt The prompt for generation.
   * @param imageUrl The reference image URL.
   * @param model The target model (default: 'sora-2').
   * @param options Additional options like duration and aspect_ratio.
   */
  public static async generateVideo(
    prompt: string,
    imageUrl: string,
    model: string = 'sora-2',
    options: {
      duration?: number;
      aspect_ratio?: string;
    } = {}
  ): Promise<string> {
    return this.generationRateLimiter.schedule(async () => {
      let tempImagePath: string | null = null;
      try {
        const key = config.cometApi.apiKey;
        const maskedKey = key.length > 8 
          ? `${key.slice(0, 4)}...${key.slice(-4)}` 
          : '*** (too short)';
        
        console.log(`[CometService] Requesting video: model=${model}, keyLength=${key.length}, key=${maskedKey}`);

        const effectiveApiModel = model === 'seedance-2' ? 'doubao-seedance-2-0' : model;
        const size = model === 'seedance-2' ? '480x854' : (options.aspect_ratio === '9:16' ? '720x1280' : '1280x720');
        
        console.log(`[CometService] Target size: ${size}, API model: ${effectiveApiModel}`);
        
        const form = new FormData();
        form.append('model', effectiveApiModel);
        form.append('prompt', prompt);
        form.append('seconds', String(options.duration || 8));
        form.append('size', size);

        if (imageUrl) {
          try {
            console.log(`[CometService] Preparing reference image for size: ${size}`);
            const downloadsDir = path.resolve(__dirname, '../../data/comet-downloads');
            await fs.ensureDir(downloadsDir);
            tempImagePath = path.join(downloadsDir, `ref_${Date.now()}.jpg`);
            
            const imageRes = await axios.get(imageUrl, { responseType: 'arraybuffer' });
            await fs.writeFile(tempImagePath, imageRes.data);
            
            // Resize image to match requested size using ffmpeg
            const resizedPath = path.join(downloadsDir, `resized_${Date.now()}.jpg`);
            const [width, height] = size.split('x');
            const execAsync = promisify(exec);
            
            // Scale and pad to match exact dimensions
            const cmd = `ffmpeg -i "${tempImagePath}" -vf "scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2" "${resizedPath}"`;
            await execAsync(cmd);

            // Replace tempImagePath with resized version for upload
            await fs.remove(tempImagePath);
            tempImagePath = resizedPath;
            
            form.append('input_reference', fs.createReadStream(tempImagePath), {
              filename: 'reference.jpg',
              contentType: 'image/jpeg',
            });
          } catch (err: any) {
            console.error('[CometService] Failed to prepare reference image:', err.message);
            throw new Error(`Failed to prepare reference image for Sora 2: ${err.message}`);
          }
        }

        const response = await axios.post(
          `${config.cometApi.baseUrl}/videos`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${key}`,
            },
          }
        );

        const videoId = response.data?.id;
        if (!videoId) {
          throw new Error(`Failed to get video ID from Comet API: ${JSON.stringify(response.data)}`);
        }
        return videoId;
      } catch (error: any) {
        const errorData = error.response?.data;
        const details = errorData ? JSON.stringify(errorData) : error.message;
        console.error(`[CometService] generateVideo failed: ${this.buildAxiosDebugContext(error)}`);
        
        if (this.isCometBalanceError(error)) {
          AdminNotifierService.notifyBalanceError('Comet API', details).catch(err => 
            console.error('[CometService] Failed to notify admins:', err.message)
          );
        }

        throw new Error(`Video generation start failed (Comet): ${details}`);
      } finally {
        if (tempImagePath) {
          fs.remove(tempImagePath).catch(err => 
            console.error('[CometService] Failed to cleanup temp reference image:', err.message)
          );
        }
      }
    });
  }

  /**
   * Polls the status of a Comet video until it's finished or fails.
   * @param videoId The ID of the video to poll.
   */
  public static async pollStatus(videoId: string): Promise<string> {
    const maxRetries = 300; // up to ~50 minutes
    let resolvedVideoId = videoId;
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(
          `${config.cometApi.baseUrl}/videos/${resolvedVideoId}`,
          {
            headers: {
              'Authorization': `Bearer ${config.cometApi.apiKey}`,
            },
          }
        );

        const data = response.data;
        const extractedVideoId = this.extractVideoId(data);
        if (extractedVideoId) {
          resolvedVideoId = extractedVideoId;
        }

        const progressValue = this.parseProgress(data?.progress);
        const status = data?.status;

        if (this.isFailureStatus(status)) {
          const rawError = data?.error || data?.msg || data?.message || data?.failMsg || 'Unknown error';
          const errorDetails = typeof rawError === 'object' ? JSON.stringify(rawError) : String(rawError);
          throw new Error(`Comet video generation failed early: ${errorDetails}`);
        }

        if (this.isCompletedStatus(status) || progressValue === 100) {
          // Download the completed video content via canonical video ID.
          return await this.downloadVideo(resolvedVideoId);
        }

        console.log(`Comet Video ${resolvedVideoId} status=${status || 'unknown'} progress=${progressValue ?? 'n/a'}%. Waiting... (${i + 1}/${maxRetries})`);
        await this.sleep(10000);
      } catch (error: any) {
        if (error.message.includes('Comet video generation failed')) throw error;

        const statusCode = Number(error?.response?.status || 0);
        const isTransientServerError = statusCode >= 500 && statusCode < 600;
        const backoffMs = isTransientServerError
          ? Math.min(30000, 5000 * Math.pow(1.35, i)) + Math.floor(Math.random() * 750)
          : 5000;

        console.warn(
          `[CometService] pollStatus retry for ${resolvedVideoId} (${i + 1}/${maxRetries}): ${this.buildAxiosDebugContext(error)} | backoff=${backoffMs}ms`
        );
        await this.sleep(backoffMs);
      }
    }

    throw new Error('Comet video generation timed out');
  }

  /**
   * Downloads the video from Comet API to a local file.
   * @param videoId The ID of the video to download.
   */
  private static async downloadVideo(videoId: string): Promise<string> {
    await fs.ensureDir(downloadsDir);
    const outputPath = path.join(downloadsDir, `${videoId}.mp4`);

    try {
      const response = await axios.get(
        `${config.cometApi.baseUrl}/videos/${videoId}/content`,
        {
          headers: {
            'Authorization': `Bearer ${config.cometApi.apiKey}`,
          },
          responseType: 'arraybuffer',
          validateStatus: () => true,
        }
      );

      const contentType = String(response.headers?.['content-type'] || '').toLowerCase();
      const isJson = contentType.includes('application/json') || contentType.includes('text/json');
      const textBody = Buffer.from(response.data).toString('utf-8');

      if (response.status >= 400 || isJson) {
        let parsed: any = null;
        try {
          parsed = JSON.parse(textBody);
        } catch {
          parsed = textBody;
        }

        const message =
          parsed?.message ||
          parsed?.data?.error?.message ||
          `Unexpected Comet content response (status=${response.status}, content-type=${contentType || 'unknown'})`;
        throw new Error(message);
      }

      await fs.writeFile(outputPath, response.data);

      // Upscale to 1080x1920 if needed
      const upscaledPath = path.join(downloadsDir, `upscaled_${videoId}.mp4`);
      console.log(`[CometService] Upscaling video ${videoId} to 1080x1920...`);
      
      const execAsync = promisify(exec);
      try {
        await execAsync(`ffmpeg -i "${outputPath}" -vf "scale=1080:1920" -c:v libx264 -crf 18 -preset fast "${upscaledPath}"`);
        // Replace original with upscaled version
        await fs.remove(outputPath);
        return upscaledPath;
      } catch (upscaleErr: any) {
        console.error(`[CometService] Upscale failed, using original:`, upscaleErr.message);
        return outputPath;
      }
    } catch (error: any) {
      console.error(`[CometService] downloadVideo failed for ${videoId}: ${this.buildAxiosDebugContext(error)}`);
      throw new Error(`Failed to download video from Comet: ${error.message}`);
    }
  }
}
