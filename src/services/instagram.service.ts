import axios from 'axios';
import fs from 'fs-extra';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { config } from '../config.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const debugDir = path.resolve(__dirname, '../../data/instagram-debug');
const tempDir = path.resolve(__dirname, '../../data/temp-videos');
const downloadRetryDelaysMs = [2500, 7000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getDownloadErrorCode(error: any): string {
  return String(error?.code || error?.cause?.code || '').trim();
}

function isRetryableDownloadError(error: any): boolean {
  const code = getDownloadErrorCode(error);
  if (['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EAI_AGAIN', 'ENETUNREACH'].includes(code)) {
    return true;
  }

  const status = Number(error?.response?.status);
  return status === 408 || status === 429 || status >= 500;
}

export interface InstagramPostInfo {
  url: string;
  type: string;
  thumbnail?: string;
}

export class InstagramParseError extends Error {
  constructor(
    message: string,
    public readonly debugFilePath?: string,
    public readonly debugPreview?: string,
  ) {
    super(message);
    this.name = 'InstagramParseError';
  }
}

async function saveDebugResponse(reelUrl: string, data: unknown): Promise<{ filePath: string; preview: string }> {
  await fs.ensureDir(debugDir);

  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const filePath = path.join(debugDir, `${timestamp}.json`);
  const payload = {
    reelUrl,
    savedAt: new Date().toISOString(),
    response: data,
  };
  const content = JSON.stringify(payload, null, 2);

  await fs.writeFile(filePath, content, 'utf8');

  return {
    filePath,
    preview: content.slice(0, 1500),
  };
}

export class InstagramService {
  private static pickThumbnail(data: any): string | undefined {
    return data?.display_url ||
      data?.thumbnail_url ||
      data?.image_versions2?.candidates?.[0]?.url ||
      data?.image_versions?.items?.[0]?.url ||
      data?.clips_metadata?.music_info?.music_asset_info?.cover_artwork_uri ||
      data?.clips_metadata?.music_info?.music_asset_info?.cover_artwork_thumbnail_uri;
  }

  private static extractShortcode(url: string): string {
    // Handle both full URLs and shortcodes
    if (!url.includes('instagram.com')) {
      return url.trim();
    }

    try {
      // Regex to handle /p/ABC, /reel/ABC, /reels/ABC
      const match = url.match(/\/(?:p|reel|reels)\/([A-Za-z0-9_-]+)/);
      return (match && match[1]) ? match[1] : url;
    } catch {
      return url;
    }
  }

  /**
   * Fetches the direct MP4 URL from a Reel link using RapidAPI.
   * @param reelUrl The Instagram Reel URL.
   */
  public static async getReelInfo(reelUrl: string): Promise<InstagramPostInfo> {
    const shortcode = this.extractShortcode(reelUrl);
    console.log(`[InstagramService] Extracted shortcode: ${shortcode} from URL: ${reelUrl}`);

    try {
      const response = await axios.get(config.rapidApi.base, {
        params: {
          code_or_id_or_url: shortcode,
        },
        headers: {
          'x-rapidapi-key': config.rapidApi.key,
          'x-rapidapi-host': config.rapidApi.host,
        },
      });

      const data = response.data;
      
      // Typical structure for this type of API: 
      // data.video_url or data.media?.[0].url depending on the specific response.
      // We will look for video_url or similar in the response.
      
      if (!data) {
        throw new Error('No data received from Instagram API');
      }

      const payload = data.data || data.result || data;

      const videoUrl =
        payload?.video_url ||
        payload?.media?.[0]?.video_url ||
        payload?.video_versions?.[0]?.url ||
        data?.video_url ||
        data?.media?.[0]?.video_url ||
        data?.video_versions?.[0]?.url;

      if (!videoUrl) {
        const debug = await saveDebugResponse(reelUrl, data);
        console.error('RapidAPI Response:', JSON.stringify(data, null, 2));
        throw new InstagramParseError(
          'Failed to extract video URL from Instagram response',
          debug.filePath,
          debug.preview,
        );
      }

      const thumbnail = this.pickThumbnail(payload) || this.pickThumbnail(data);

      return {
        url: videoUrl,
        type: 'video',
        ...(thumbnail ? { thumbnail } : {}),
      };
    } catch (error: any) {
      const status = error.response?.status;
      const detail = error.response?.data?.detail;

      console.error(`[InstagramService] API Error: Status=${status}, Detail=${detail}, Message=${error.message}`);

      if (status === 404 || detail === 'Not found') {
        throw new Error('Видео не найдено. Возможно, оно было удалено или является приватным.');
      }

      if (status === 400 || detail === 'Invalid request') {
        throw new Error('Некорректный запрос к Instagram API. Пожалуйста, убедитесь, что ссылка правильная.');
      }

      if (error instanceof InstagramParseError) {
        throw error;
      }
      throw new Error(`Ошибка при разборе Instagram Reel: ${error.message}`);
    }
  }

  /**
   * Downloads a video from a URL to a temporary local file.
   * @param videoUrl The direct MP4 URL.
   * @returns Path to the downloaded file.
   */
  public static async downloadVideo(videoUrl: string): Promise<string> {
    await fs.ensureDir(tempDir);
    const fileName = `reel-${Date.now()}-${Math.random().toString(36).slice(2, 7)}.mp4`;
    const filePath = path.join(tempDir, fileName);
    const maxAttempts = downloadRetryDelaysMs.length + 1;

    console.log(`[InstagramService] Full video URL: ${videoUrl}`);
    console.log(`[InstagramService] Target path: ${filePath}`);

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      try {
        const response = await axios({
          method: 'get',
          url: videoUrl,
          responseType: 'stream',
          timeout: 45000,
          family: 4,
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/119.0.0.0 Safari/537.36',
            'Accept': 'video/webm,video/ogg,video/*;q=0.9,application/ogg;q=0.7,audio/*;q=0.6,*/*;q=0.5',
            'Referer': 'https://www.instagram.com/',
          },
        });

        const writer = fs.createWriteStream(filePath);
        response.data.pipe(writer);

        return await new Promise((resolve, reject) => {
          writer.on('finish', () => resolve(filePath));
          writer.on('error', (err) => {
            fs.remove(filePath).catch(console.error);
            reject(new Error(`Stream error during download: ${err.message}`));
          });
          response.data.on('error', (err: any) => {
            console.error(`[InstagramService] Response stream error:`, err);
            fs.remove(filePath).catch(console.error);
            reject(new Error(`Response data error: ${err.message || 'No message'}`));
          });
          response.data.on('aborted', () => {
            console.error(`[InstagramService] Response stream aborted`);
            fs.remove(filePath).catch(console.error);
            reject(new Error('Response stream aborted by server'));
          });
        });
      } catch (error: any) {
        await fs.remove(filePath).catch(() => undefined);
        console.error(`[InstagramService] Download exception (attempt ${attempt}/${maxAttempts}):`, error);

        if (isRetryableDownloadError(error) && attempt < maxAttempts) {
          const delay = downloadRetryDelaysMs[attempt - 1] || 7000;
          const code = getDownloadErrorCode(error) || 'unknown';
          console.warn(`[InstagramService] Retrying video download in ${delay}ms (code=${code})`);
          await sleep(delay);
          continue;
        }

        if (error.response) {
          throw new Error(`Failed to download video: HTTP ${error.response.status} - ${error.response.statusText}`);
        }

        const errorCode = getDownloadErrorCode(error);
        if (errorCode === 'ETIMEDOUT') {
          const host = (() => {
            try {
              return new URL(videoUrl).hostname;
            } catch {
              return 'Instagram CDN';
            }
          })();
          throw new Error(`Failed to download video: network timeout while connecting to ${host} (ETIMEDOUT)`);
        }

        throw new Error(`Failed to download video: ${error.message || String(error) || 'Unknown error'}`);
      }
    }

    throw new Error('Failed to download video: retries exhausted');
  }
}
