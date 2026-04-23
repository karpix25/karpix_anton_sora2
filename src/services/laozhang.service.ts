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
        },
        {
          headers: {
            'Authorization': `Bearer ${config.laozhang.apiKey}`,
            'Content-Type': 'application/json',
          },
        }
      );

      const taskId = response.data?.id || response.data?.data?.id;
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

        const data = response.data?.data || response.data;
        const status = (data.status || data.state || '').toLowerCase();
        const url = data.video_url || data.url || data.result;

        if (status === 'completed' || status === 'succeeded' || url) {
          if (!url) throw new Error('Laozhang task completed but no URL found');
          return url;
        }

        if (['failed', 'error', 'canceled'].includes(status)) {
          throw new Error(`Laozhang task failed: ${data.error || 'Unknown error'}`);
        }

        console.log(`[Laozhang] Task ${taskId} status: ${status}. Waiting...`);
      } catch (error: any) {
        if (error.message.includes('failed')) throw error;
        console.warn(`[Laozhang] Polling error for ${taskId}:`, error.message);
      }
    }
    throw new Error('Laozhang task timed out');
  }
}
