import axios from 'axios';
import FormData from 'form-data';
import { config } from '../config.js';

export class CometService {
  /**
   * Triggers video generation on CometAPI.
   * @param prompt The prompt for generation.
   * @param model The target model ('sora-2').
   */
  public static async generateVideo(
    prompt: string,
    model: string
  ): Promise<string> {
    try {
      const formData = new FormData();
      formData.append('model', model);
      formData.append('prompt', prompt);

      const response = await axios.post(
        `${config.cometApi.baseUrl}/videos`,
        formData,
        {
          headers: {
            ...formData.getHeaders(),
            'Authorization': `Bearer ${config.cometApi.apiKey}`,
          },
        }
      );

      const taskId = response.data?.id;
      if (!taskId) {
        throw new Error(`Failed to get task ID from CometAPI: ${JSON.stringify(response.data)}`);
      }

      console.log(`[CometService] Task created: ${taskId}`);
      return taskId;
    } catch (error: any) {
      const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      console.error(`[CometService] Generation start error:`, details);
      throw new Error(`Video generation start failed (Comet): ${details}`);
    }
  }

  /**
   * Polls the status of a CometAPI task until it's finished or fails.
   * @param taskId The ID of the task to poll.
   */
  public static async pollStatus(taskId: string): Promise<string> {
    const maxRetries = 150; 
    
    for (let i = 0; i < maxRetries; i++) {
      const delay = 10000; // 10 seconds as per user script
      try {
        const response = await axios.get(
          `${config.cometApi.baseUrl}/videos/${taskId}`,
          {
            headers: {
              'Authorization': `Bearer ${config.cometApi.apiKey}`,
            },
          }
        );

        const data = response.data ?? {};
        const progress = data.progress; // e.g. "0%" or "100%"
        const status = (data.status || '').toUpperCase();

        console.log(`[CometService] Task ${taskId} - Progress: ${progress}, Status: ${status} (${i + 1}/${maxRetries})`);

        if (progress === '100%') {
          console.log(`[CometService] Video generation completed for task ${taskId}`);
          // The content URL as per user script is /v1/videos/:id/content
          return `${config.cometApi.baseUrl}/videos/${taskId}/content`;
        }

        if (status === 'FAILURE' || status === 'FAILED') {
          throw new Error(`CometAPI generation failed: ${JSON.stringify(data)}`);
        }

        await new Promise((resolve) => setTimeout(resolve, delay));
      } catch (error: any) {
        // If it's a known failure, rethrow
        if (error.message.includes('failed') || error.message.includes('FAILURE')) throw error;
        
        console.warn(`[CometService] Polling error for ${taskId}:`, error.message);
        await new Promise((resolve) => setTimeout(resolve, delay));
      }
    }

    throw new Error('CometAPI task timed out');
  }
}
