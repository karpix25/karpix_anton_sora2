import axios from 'axios';
import { config } from '../config.js';

export class DefApiService {
  public static async generateVideo(prompt: string, imageUrl: string, model: string): Promise<string> {
    try {
      const response = await axios.post(
        `${config.defapi.baseUrl}/api/sora2/gen`,
        {
          model: model,
          prompt: prompt,
          images: imageUrl ? [imageUrl] : [], // Documentation shows array "images"
          aspect_ratio: '9:16',
          duration: '10', // Added as per documentation example
        },
        {
          headers: {
            'Authorization': `Bearer ${config.defapi.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const taskId = response.data?.task_id || response.data?.job_id || response.data?.id || response.data?.data?.task_id || response.data?.data?.id;
      if (!taskId) {
        throw new Error(`Failed to get job ID from DefAPI: ${JSON.stringify(response.data)}`);
      }
      return taskId;
    } catch (error: any) {
      const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new Error(`DefAPI generation failed: ${details}`);
    }
  }

  public static async pollStatus(taskId: string): Promise<string> {
    const maxRetries = 100;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000));

      try {
        const response = await axios.get(
          `${config.defapi.baseUrl}/api/task/query`,
          {
            params: { job_id: taskId }, // Stick to documentation's job_id
            headers: { 'Authorization': `Bearer ${config.defapi.apiKey}` },
          }
        );

        const root = response.data;
        const data = root?.data ?? root;
        
        // ID verification
        const returnedId = data.task_id || data.job_id || data.id || root.task_id || root.id;
        if (returnedId && returnedId !== taskId) {
          console.warn(`[DefAPI] Polling ${taskId} but got ${returnedId}. This might be a stale provider response. Skipping this tick...`);
          continue;
        }

        const rawStatus = (data.status || data.state || '').toLowerCase();
        
        // If status is empty but we got a valid-looking root, check if it's an error in disguise
        if (!rawStatus && (root.code !== 0 || root.message !== 'ok')) {
           throw new Error(`DefAPI polling returned error code: ${root.code}, message: ${root.message}`);
        }
        
        // Exhaustive URL search
        let url = data.video_url || data.url || data.result || data.videoUrl || data.download_url || data.video ||
                  root.video_url || root.url || root.result || root.videoUrl || root.download_url || root.video;

        // Ensure we have a string, as some APIs return nested objects in these fields
        if (url && typeof url !== 'string') {
          url = (url as any).video || (url as any).url || (url as any).video_url || (url as any).playback || (url as any).download || null;
        }

        if (['success', 'completed', 'succeeded', 'finished'].includes(rawStatus) || (url && typeof url === 'string')) {
          if (!url || typeof url !== 'string') {
            console.warn(`[DefAPI] Task marked as done but no valid URL string found. Data:`, data);
            throw new Error('DefAPI task completed but no valid URL found');
          }
          return url;
        }

        if (['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(rawStatus)) {
          const errMsg = data.status_reason?.message || data.message || data.error || root.message || 'Unknown error';
          throw new Error(`DefAPI task failed: ${errMsg}`);
        }

        console.log(`[DefAPI] Task ${taskId} status: ${rawStatus || 'pending'}. Waiting...`);
      } catch (error: any) {
        if (error.message.includes('failed')) throw error;
        console.warn(`[DefAPI] Polling error for ${taskId}:`, error.message);
      }
    }
    throw new Error('DefAPI task timed out');
  }
}
