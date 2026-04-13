import axios from 'axios';
import { config } from '../config.js';

function parseResultVideoUrl(task: any): string {
  const resultJson = task?.resultJson;
  if (typeof resultJson === 'string' && resultJson.trim()) {
    try {
      const parsed = JSON.parse(resultJson);
      if (Array.isArray(parsed?.resultUrls) && parsed.resultUrls[0]) {
        return parsed.resultUrls[0];
      }
    } catch (error) {
      console.warn('Failed to parse Kie resultJson:', error);
    }
  }

  return task?.videoUrl || task?.video_url || '';
}

export class KieService {
  /**
   * Triggers video generation on Kie.ai.
   * @param prompt The generated prompt from Gemini Pro.
   * @param imageUrl The product photo URL as a reference.
   * @param model The target model ('sora-2' or 'veo-3-1').
   */
  public static async generateVideo(
    prompt: string,
    imageUrl: string,
    model: 'sora-2' | 'veo-3-1'
  ): Promise<string> {
    try {
      // Kie.ai model mapping aligned with the current image-to-video flow.
      const modelMapping: Record<string, string> = {
        'sora-2': 'sora-2-image-to-video-stable',
        'veo-3-1': 'veo-3-1',
      };

      const response = await axios.post(
        `${config.kieAi.baseUrl}/jobs/createTask`,
        {
          model: modelMapping[model] || model,
          input: {
            prompt,
            image_urls: [imageUrl],
            aspect_ratio: 'portrait',
            n_frames: '10',
            upload_method: 's3',
          },
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
      console.error('Kie.ai Generation Error:', error.response?.data || error.message);
      throw new Error(`Video generation start failed: ${error.message}`);
    }
  }

  /**
   * Polls the status of a Kie.ai task until it's finished or fails.
   * @param taskId The ID of the task to poll.
   */
  public static async pollStatus(taskId: string): Promise<string> {
    const maxRetries = 60; // 5-10 minutes polling
    const delay = 10000; // 10 seconds

    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(
          `${config.kieAi.baseUrl}/jobs/recordInfo`,
          {
            params: { taskId },
            headers: {
              'Authorization': `Bearer ${config.kieAi.apiKey}`,
            },
          }
        );

        const task = response.data.data ?? response.data;
        const status = task.state || task.status;
        if (status === 'success' || status === 'FINISHED' || status === 'COMPLETED' || status === 'succeeded' || status === 'completed') {
          const resultVideoUrl = parseResultVideoUrl(task);
          if (!resultVideoUrl) {
            throw new Error('Generation completed but no result video URL was returned');
          }
          return resultVideoUrl;
        } else if (status === 'fail' || status === 'FAILED' || status === 'failed') {
          throw new Error(`Generation failed: ${task.failMsg || task.message || task.error_message || 'Unknown error'}`);
        }

        console.log(`Task ${taskId} status: ${status}. Waiting...`);
        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error: any) {
        if (error.message.includes('failed')) throw error;
        console.warn(`Polling error for ${taskId}:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('Task timed out');
  }
}
