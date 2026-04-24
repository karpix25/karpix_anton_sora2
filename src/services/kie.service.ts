import axios from 'axios';
import { config } from '../config.js';
import { AdminNotifierService } from './admin-notifier.service.js';
import { RateLimiter } from '../utils/rate-limiter.js';

function pickFirstNonEmptyString(...values: unknown[]): string {
  for (const value of values) {
    if (typeof value === 'string' && value.trim()) {
      return value.trim();
    }
  }

  return '';
}

function pickFirstUrlFromArray(value: unknown): string {
  if (!Array.isArray(value)) {
    return '';
  }

  for (const entry of value) {
    if (typeof entry === 'string' && entry.trim()) {
      return entry.trim();
    }

    if (entry && typeof entry === 'object') {
      const url = pickFirstNonEmptyString(
        (entry as Record<string, unknown>).url,
        (entry as Record<string, unknown>).videoUrl,
        (entry as Record<string, unknown>).video_url,
        (entry as Record<string, unknown>).downloadUrl,
        (entry as Record<string, unknown>).download_url,
      );
      if (url) {
        return url;
      }
    }
  }

  return '';
}

function parseJsonObject(value: unknown): Record<string, unknown> | null {
  if (typeof value !== 'string' || !value.trim()) {
    return null;
  }

  try {
    const parsed = JSON.parse(value);
    if (parsed && typeof parsed === 'object') {
      return parsed as Record<string, unknown>;
    }
  } catch (error) {
    console.warn('Failed to parse Kie JSON payload:', error);
  }

  return null;
}

function parseResultVideoUrl(task: any): string {
  const parsedResultJson = parseJsonObject(task?.resultJson);
  const parsedResult = parseJsonObject(task?.result);
  const parsedOutput = parseJsonObject(task?.output);

  const resultVideoUrl = pickFirstNonEmptyString(
    task?.videoUrl,
    task?.video_url,
    task?.resultVideoUrl,
    task?.result_video_url,
    task?.url,
    task?.downloadUrl,
    task?.download_url,
    parsedResultJson?.videoUrl,
    parsedResultJson?.video_url,
    parsedResultJson?.downloadUrl,
    parsedResultJson?.download_url,
    parsedResult?.videoUrl,
    parsedResult?.video_url,
    parsedResult?.downloadUrl,
    parsedResult?.download_url,
    parsedOutput?.videoUrl,
    parsedOutput?.video_url,
    parsedOutput?.downloadUrl,
    parsedOutput?.download_url,
  );

  if (resultVideoUrl) {
    return resultVideoUrl;
  }

  return pickFirstUrlFromArray(task?.resultUrls)
    || pickFirstUrlFromArray(task?.result_urls)
    || pickFirstUrlFromArray(task?.outputs)
    || pickFirstUrlFromArray(task?.outputUrls)
    || pickFirstUrlFromArray(parsedResultJson?.resultUrls)
    || pickFirstUrlFromArray(parsedResultJson?.result_urls)
    || pickFirstUrlFromArray(parsedResult?.resultUrls)
    || pickFirstUrlFromArray(parsedResult?.result_urls)
    || pickFirstUrlFromArray(parsedOutput?.resultUrls)
    || pickFirstUrlFromArray(parsedOutput?.result_urls)
    || '';
}

function extractStatus(...sources: any[]): string {
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    const value = pickFirstNonEmptyString(
      source.state,
      source.status,
      source.taskStatus,
      source.task_status,
      source.jobStatus,
      source.job_status,
      source.phase,
    );
    if (value) {
      return value;
    }
  }

  return '';
}

function isSuccessStatus(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['success', 'succeeded', 'completed', 'finished', 'done', 'ok'].includes(normalized);
}

function isFailureStatus(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return ['fail', 'failed', 'error', 'cancelled', 'canceled', 'timeout', 'timed_out'].includes(normalized);
}

function extractErrorMessage(...sources: any[]): string {
  for (const source of sources) {
    if (!source || typeof source !== 'object') {
      continue;
    }

    const value = pickFirstNonEmptyString(
      source.failMsg,
      source.fail_msg,
      source.errorMessage,
      source.error_message,
      source.message,
      source.error,
    );
    if (value) {
      return value;
    }
  }

  return '';
}

export class KieService {
  /**
   * Limit: 20 generation requests per 10 seconds.
   * Using 18 for safety.
   */
  private static generationRateLimiter = new RateLimiter(18, 10000);

  /**
   * Triggers video generation on Kie.ai.
   * @param prompt The generated prompt from Gemini Pro.
   * @param imageUrl The product photo URL as a reference.
   * @param model The target model ('sora-2' or 'veo-3-1').
   */
  public static async generateVideo(
    prompt: string,
    imageUrl: string,
    model: string,
    options: {
      mode?: 'fun' | 'normal' | 'spicy';
      resolution?: '480p' | '720p';
      aspect_ratio?: string;
    } = {}
  ): Promise<string> {
    return this.generationRateLimiter.schedule(async () => {
      let retryCount = 0;
      const maxRetries = 3;

      while (retryCount <= maxRetries) {
        try {
          const isGrok = model.includes('grok');
          const isVeo = model.includes('veo');
          
          let endpoint = `${config.kieAi.baseUrl}/jobs/createTask`;
          let targetModel = model;

          // Kie.ai model mapping.
          const modelMapping: Record<string, string> = {
            'sora-2': 'sora-2-image-to-video-stable',
            'veo-3-1': 'veo3',
            'grok-imagine': 'grok-imagine/image-to-video',
          };

          targetModel = modelMapping[model] || model;

          const input: any = {
            prompt,
          };

          if (isVeo) {
            endpoint = `${config.kieAi.baseUrl}/veo/generate`;
            input.imageUrls = [imageUrl];
            input.model = targetModel;
            input.aspect_ratio = options.aspect_ratio || '9:16';
            input.resolution = options.resolution || '720p';
            // Use REFERENCE_2_VIDEO for "Reference" mode where image is used for consistency but not forced as first frame
            input.generationType = 'REFERENCE_2_VIDEO';
          } else {
            input.image_urls = [imageUrl];
            if (isGrok) {
              input.mode = options.mode || 'normal';
              input.resolution = options.resolution || '720p';
              input.aspect_ratio = options.aspect_ratio || '9:16';
              input.nsfw_checker = false;
            } else {
              input.aspect_ratio = 'portrait';
              input.n_frames = '10';
              input.upload_method = 's3';
            }
          }

          const response = await axios.post(
            endpoint,
            isVeo ? input : {
              model: targetModel,
              input: input,
            },
            {
              headers: {
                'Authorization': `Bearer ${config.kieAi.apiKey}`,
                'Content-Type': 'application/json',
              },
            }
          );

          const taskId = response.data.data?.taskId || response.data.task_id || response.data.id;
          if (!taskId) {
            throw new Error('Failed to get task ID from Kie.ai');
          }
          return taskId;
        } catch (error: any) {
          if (error.response?.status === 429) {
            retryCount++;
            if (retryCount <= maxRetries) {
              const waitTime = Math.pow(2, retryCount) * 2000;
              console.warn(`KIE.ai Rate limit hit (429). Retrying in ${waitTime}ms... (Attempt ${retryCount}/${maxRetries})`);
              await new Promise((resolve) => setTimeout(resolve, waitTime));
              continue;
            }
          }
          const errorData = error.response?.data;
          const status = error.response?.status;
          console.error(`[KieService] Generation error (status=${status}):`, errorData || error.message);
          
          const details = errorData ? (typeof errorData === 'object' ? JSON.stringify(errorData) : String(errorData)) : error.message;
          const lowercaseDetails = details.toLowerCase();

          // Detect balance errors
          if (
            status === 402 || 
            lowercaseDetails.includes('insufficient') || 
            lowercaseDetails.includes('balance') || 
            lowercaseDetails.includes('credits') ||
            lowercaseDetails.includes('not enough funds')
          ) {
            console.warn('[KieService] Detected balance/credit error. Notifying admins...');
            AdminNotifierService.notifyBalanceError('Kie.ai', details).catch(err => 
              console.error('[KieService] Failed to notify admins:', err.message)
            );
          }

          throw new Error(`Video generation start failed (Kie): ${details}`);
        }
      }
      throw new Error('Failed to start video generation after multiple rate-limit retries.');
    });
  }

  /**
   * Polls the status of a Kie.ai task until it's finished or fails.
   * @param taskId The ID of the task to poll.
   */
  public static async pollStatus(taskId: string, model: string = ''): Promise<string> {
    const maxRetries = 150; 
    const isVeoModel = model.toLowerCase().includes('veo') || taskId.includes('veo_task');
    
    for (let i = 0; i < maxRetries; i++) {
      const delay = i < 4 ? 15000 : 5000; 
      try {
        const endpoint = isVeoModel 
          ? `${config.kieAi.baseUrl}/veo/record-info`
          : `${config.kieAi.baseUrl}/jobs/recordInfo`;

        const response = await axios.get(
          endpoint,
          {
            params: { taskId },
            headers: {
              'Authorization': `Bearer ${config.kieAi.apiKey}`,
            },
          }
        );

        const root = response.data ?? {};
        const data = root?.data ?? root;

        if (isVeoModel) {
          // Veo 3.1 specific logic (successFlag: 0=Gen, 1=Success, 2=Failed, 3=Gen Failed)
          // Look at successFlag in data or root
          const successFlag = data?.successFlag !== undefined ? data.successFlag : root?.successFlag;
          const veoResponse = data?.response || root?.response;
          
          if (successFlag === 1) {
            const urls = veoResponse?.resultUrls || veoResponse?.originUrls || veoResponse?.fullResultUrls;
            const url = pickFirstUrlFromArray(urls);
            if (!url) throw new Error('Veo task succeeded but no video URL found');
            return url;
          } else if (successFlag === 2 || successFlag === 3) {
            const error = data?.errorMessage || root?.msg || 'Veo generation failed';
            throw new Error(`Veo task error: ${error}`);
          }
          
          console.log(`Veo Task ${taskId} status: ${successFlag === 0 ? 'Generating' : 'Unknown'}. Waiting... (${i + 1}/${maxRetries})`);
        } else {
          // Standard Kie logic
          const task = data?.task ?? data?.record ?? data;
          const status = extractStatus(task, data, root);
          const resultVideoUrl = parseResultVideoUrl(task) || parseResultVideoUrl(data) || parseResultVideoUrl(root);

          if (resultVideoUrl && !isFailureStatus(status)) {
            return resultVideoUrl;
          }

          if (isSuccessStatus(status)) {
            const url = parseResultVideoUrl(task);
            if (!url) throw new Error('Generation completed but no result video URL was returned');
            return url;
          } else if (isFailureStatus(status)) {
            const details = extractErrorMessage(task, data, root) || 'Unknown error';
            throw new Error(`Generation failed: ${details}`);
          }
          
          console.log(`Task ${taskId} status: ${status || 'unknown'}. Waiting... (${i + 1}/${maxRetries})`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error: any) {
        if (typeof error?.message === 'string' && /failed|error|timed out|timeout/i.test(error.message)) throw error;
        console.warn(`Polling error for ${taskId}:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Task timed out');
  }
}
