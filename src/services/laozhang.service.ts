import axios from 'axios';
import { config } from '../config.js';

export class LaozhangService {
  /**
   * Generates video using Laozhang's Synchronous API (OpenAI compatible).
   * Model 'sora_video2' automatically enforces 9:16 portrait and 10s duration.
   */
  public static async generateVideo(
    prompt: string, 
    imageUrl: string, 
    model: string,
    aspect_ratio: string = '9:16'
  ): Promise<string> {
    const isVeo = model.includes('veo');
    
    if (isVeo) {
      // Use Laozhang's New Async Video API for Veo 3.1
      try {
        const targetModel = 'veo-3.1-fl'; // Standard quality i2v
        
        console.log(`[LaozhangService] Creating Async Veo Task: model=${targetModel}, prompt=${prompt.substring(0, 50)}...`);

        const response = await axios.post(
          `${config.laozhang.baseUrl}/videos`,
          {
            model: targetModel,
            prompt: prompt,
            image_url: imageUrl,
            aspect_ratio: aspect_ratio === '9:16' ? '9:16' : '16:9'
          },
          {
            headers: {
              'Authorization': `Bearer ${config.laozhang.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 30000,
          }
        );

        const taskId = response.data?.id || response.data?.task_id;
        if (!taskId) {
          throw new Error(`Failed to get taskId from Laozhang: ${JSON.stringify(response.data)}`);
        }

        return taskId; // Return ID for polling
      } catch (error: any) {
        const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Laozhang (Veo Async) creation failed: ${details}`);
      }
    } else {
      // Legacy Synchronous "Chat" API for Sora 2
      try {
        const content: any[] = [
          {
            type: 'image_url',
            image_url: { url: imageUrl }
          },
          {
            type: 'text',
            text: prompt
          }
        ];

        const response = await axios.post(
          `${config.laozhang.baseUrl}/chat/completions`,
          {
            model: 'sora_video2', 
            messages: [
              {
                role: 'user',
                content: content,
              },
            ],
          },
          {
            headers: {
              'Authorization': `Bearer ${config.laozhang.apiKey}`,
              'Content-Type': 'application/json',
            },
            timeout: 300000, 
          }
        );

        const responseContent = response.data?.choices?.[0]?.message?.content || '';
        if (!responseContent) throw new Error(`Empty response from Laozhang`);

        const urlRegex = /(https?:\/\/[^\s\)]+)/g;
        const matches = responseContent.match(urlRegex);

        if (!matches || matches.length === 0) {
          throw new Error(`No video URL found in response: ${responseContent.substring(0, 100)}...`);
        }

        return matches[0];
      } catch (error: any) {
        const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Laozhang (Sora Sync) failed: ${details}`);
      }
    }
  }

  /**
   * Status polling for Laozhang's Async API tasks.
   */
  public static async pollStatus(taskIdOrUrl: string): Promise<string> {
    // If it's already a URL (from Sync API), just return it
    if (taskIdOrUrl.startsWith('http')) {
      return taskIdOrUrl;
    }

    const maxRetries = 150;
    for (let i = 0; i < maxRetries; i++) {
      try {
        const response = await axios.get(
          `${config.laozhang.baseUrl}/videos/${taskIdOrUrl}`,
          {
            headers: {
              'Authorization': `Bearer ${config.laozhang.apiKey}`,
            },
          }
        );

        const data = response.data;
        const status = (data?.status || '').toLowerCase();
        
        console.log(`[LaozhangService] Task ${taskIdOrUrl} status: ${status} (${i + 1}/${maxRetries})`);

        if (status === 'success' || status === 'completed') {
          const url = data?.video_url || data?.url || (data?.response?.resultUrls?.[0]);
          if (!url) throw new Error('Task succeeded but no video_url found');
          return url;
        }

        if (status === 'failed' || status === 'error') {
          throw new Error(data?.reason || data?.error?.message || 'Generation failed');
        }

        await new Promise(r => setTimeout(r, 10000)); // Poll every 10s
      } catch (error: any) {
        if (error.message.includes('Generation failed')) throw error;
        console.warn(`Laozhang poll error: ${error.message}`);
        await new Promise(r => setTimeout(r, 10000));
      }
    }

    throw new Error('Laozhang task timed out');
  }
}
