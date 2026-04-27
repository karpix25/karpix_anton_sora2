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
      let tempImagePath: string | null = null;
      try {
        const key = config.cometApi.apiKey;
        const maskedKey = key.length > 8 
          ? `${key.slice(0, 4)}...${key.slice(-4)}` 
          : '*** (too short)';
        
        console.log(`[CometService] Requesting video: model=${model}, keyLength=${key.length}, key=${maskedKey}`);

        const size = options.aspect_ratio === '9:16' ? '720x1280' : '1280x720';
        form.append('model', model);
        form.append('prompt', prompt);
        form.append('seconds', String(options.duration || 8));
        form.append('size', size);

        if (imageUrl) {
          try {
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
        
        if (error.response?.status === 402 || details.toLowerCase().includes('balance')) {
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
        const progress = data?.progress; // could be "100%" (string) or 100 (number)
        const status = data?.status; 

        if (progress === '100%' || progress === 100) {
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
