import axios from 'axios';
import FormData from 'form-data';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';
import { AdminNotifierService } from './admin-notifier.service.js';
import { RateLimiter } from '../utils/rate-limiter.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const downloadsDir = path.resolve(__dirname, '../../data/comet-downloads');

export class CometService {
  /**
   * Limit: 10 generation requests per 10 seconds.
   */
  private static generationRateLimiter = new RateLimiter(10, 10000);

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
      try {
        const key = config.cometApi.apiKey;
        const maskedKey = key.length > 8 
          ? `${key.slice(0, 4)}...${key.slice(-4)}` 
          : '*** (too short)';
        
        console.log(`[CometService] Requesting video: model=${model}, keyLength=${key.length}, key=${maskedKey}`);

        const form = new FormData();
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('duration', String(options.duration || 8));
        form.append('aspect_ratio', options.aspect_ratio || '9:16');
        
        if (imageUrl) {
          form.append('image_url', imageUrl);
        }

        const headers = {
          ...form.getHeaders(),
          'Authorization': `Bearer ${key}`,
        };

        const response = await axios.post(
          `${config.cometApi.baseUrl}/videos`,
          form,
          { headers }
        );

        const videoId = response.data?.id;
        if (!videoId) {
          throw new Error(`Failed to get video ID from Comet API: ${JSON.stringify(response.data)}`);
        }
        return videoId;
      } catch (error: any) {
        const errorData = error.response?.data;
        const details = errorData ? JSON.stringify(errorData) : error.message;
        
        if (error.response?.status === 402 || details.toLowerCase().includes('balance')) {
          AdminNotifierService.notifyBalanceError('Comet API', details).catch(err => 
            console.error('[CometService] Failed to notify admins:', err.message)
          );
        }

        throw new Error(`Video generation start failed (Comet): ${details}`);
      }
    });
  }

  /**
   * Polls the status of a Comet video until it's finished or fails.
   * @param videoId The ID of the video to poll.
   */
  public static async pollStatus(videoId: string): Promise<string> {
    const maxRetries = 120; // 10 minutes at 5s interval
    
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(
          `${config.cometApi.baseUrl}/videos/${videoId}`,
          {
            headers: {
              'Authorization': `Bearer ${config.cometApi.apiKey}`,
            },
          }
        );

        const data = response.data;
        const progress = data?.progress; // e.g. "100%"
        const status = data?.status; // e.g. "FAILURE" or "SUCCESS" (guessing based on common patterns)

        if (progress === '100%') {
          if (status === 'FAILURE') {
            throw new Error(`Comet video generation failed: ${data?.error || 'Unknown error'}`);
          }
          
          // Download the video
          return await this.downloadVideo(videoId);
        }

        if (status === 'FAILURE') {
          throw new Error(`Comet video generation failed early: ${data?.error || 'Unknown error'}`);
        }

        console.log(`Comet Video ${videoId} progress: ${progress || '0%'}. Waiting... (${i + 1}/${maxRetries})`);
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } catch (error: any) {
        if (error.message.includes('Comet video generation failed')) throw error;
        console.warn(`Polling error for Comet ${videoId}:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, 5000));
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
          responseType: 'stream',
        }
      );

      const writer = fs.createWriteStream(outputPath);
      response.data.pipe(writer);

      await new Promise((resolve, reject) => {
        writer.on('finish', resolve);
        writer.on('error', reject);
      });

      return outputPath;
    } catch (error: any) {
      throw new Error(`Failed to download video from Comet: ${error.message}`);
    }
  }
}
