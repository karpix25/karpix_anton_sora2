import axios from 'axios';
import { config } from '../config.js';

export class DefApiService {
  public static async generateVideo(prompt: string, imageUrl: string, model: string): Promise<string> {
    try {
      const response = await axios.post(
        `${config.defapi.baseUrl}/api/sora2/gen`,
        {
          model: model, // 'sora-2' or 'sora-2-stable'
          prompt: prompt,
          image: imageUrl,
          aspect_ratio: '9:16',
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
            params: { job_id: taskId },
            headers: { 'Authorization': `Bearer ${config.defapi.apiKey}` },
          }
        );

        const root = response.data;
        const data = root?.data ?? root;
        
        // Status check - avoid accidental match with root.message ("ok" or "success")
        const rawStatus = (data.status || data.state || '').toLowerCase();
        
        // Exhaustive URL search
        const url = data.video_url || data.url || data.result || data.videoUrl || data.download_url || 
                    root.video_url || root.url || root.result || root.videoUrl || root.download_url;

        if (['success', 'completed', 'succeeded', 'finished'].includes(rawStatus) || url) {
          if (!url) {
            console.warn(`[DefAPI] Task marked as done (${rawStatus}) but no URL found. Keys:`, Object.keys(data));
            throw new Error('DefAPI task completed but no URL found');
          }
          return url;
        }

        if (['fail', 'failed', 'error', 'canceled', 'cancelled'].includes(rawStatus)) {
          throw new Error(`DefAPI task failed: ${data.message || data.error || 'Unknown error'}`);
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
