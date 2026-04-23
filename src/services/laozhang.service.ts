import axios from 'axios';
import { config } from '../config.js';

export class LaozhangService {
  public static async generateVideo(prompt: string, imageUrl: string, model: string): Promise<string> {
    try {
      const response = await axios.post(
        `${config.laozhang.baseUrl}/videos`,
        {
          model: model, // e.g. 'sora-2'
          prompt: prompt,
          image_url: imageUrl,
          aspect_ratio: '9:16',
        },
        {
          headers: {
            'Authorization': `Bearer ${config.laozhang.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const taskId = response.data?.task_id || response.data?.id || response.data?.data?.id || response.data?.data?.task_id;
      if (!taskId) {
        throw new Error(`Failed to get task ID from Laozhang: ${JSON.stringify(response.data)}`);
      }
      return taskId;
    } catch (error: any) {
      const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new Error(`Laozhang generation failed: ${details}`);
    }
  }

  public static async pollStatus(taskId: string): Promise<string> {
    const maxRetries = 100;
    for (let i = 0; i < maxRetries; i++) {
      await new Promise(resolve => setTimeout(resolve, 10000)); // 10s intervals

      try {
        const response = await axios.get(
          `${config.laozhang.baseUrl}/videos/${taskId}`,
          {
            headers: { 'Authorization': `Bearer ${config.laozhang.apiKey}` },
          }
        );

        const root = response.data;
        const data = root?.data ?? root;
        
        // Status check
        const rawStatus = (data.status || data.state || root.status || root.state || '').toLowerCase();
        
        // Exhaustive URL search
        let url = data.video_url || data.url || data.result || data.videoUrl || data.download_url || 
                  root.video_url || root.url || root.result || root.videoUrl || root.download_url;

        // Ensure we have a string, as some APIs return nested objects in these fields
        if (url && typeof url !== 'string') {
          url = (url as any).url || (url as any).video_url || (url as any).playback || (url as any).download || null;
        }

        if (['completed', 'succeeded', 'success', 'finished'].includes(rawStatus) || (url && typeof url === 'string')) {
          if (!url || typeof url !== 'string') {
            console.warn(`[Laozhang] Task marked as done but no valid URL string found. Data:`, data);
            throw new Error('Laozhang task completed but no valid URL found');
          }
          return url;
        }

        if (['failed', 'error', 'canceled', 'cancelled'].includes(rawStatus)) {
          throw new Error(`Laozhang task failed: ${data.errorMessage || data.error || data.message || 'Unknown error'}`);
        }

        console.log(`[Laozhang] Task ${taskId} status: ${rawStatus || 'pending'}. Waiting...`);
      } catch (error: any) {
        if (error.message.includes('failed')) throw error;
        console.warn(`[Laozhang] Polling error for ${taskId}:`, error.message);
      }
    }
    throw new Error('Laozhang task timed out');
  }
}
