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
    _unused_model: string,
    _unused_ratio: string = '9:16'
  ): Promise<string> {
    try {
      // Formulate content with reference image and prompt
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
          model: 'sora_video2', // High-quality Sora 2 (9:16, 10s)
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
          timeout: 300000, // 5 minutes
        }
      );

      const responseContent = response.data?.choices?.[0]?.message?.content || '';
      if (!responseContent) {
        throw new Error(`Empty response from Laozhang`);
      }

      // Extract URL from content (markdown or plain text)
      const urlRegex = /(https?:\/\/[^\s\)]+)/g;
      const matches = responseContent.match(urlRegex);

      if (!matches || matches.length === 0) {
        throw new Error(`No video URL found in Laozhang response: ${responseContent.substring(0, 100)}...`);
      }

      // Return the first URL found
      return matches[0];
    } catch (error: any) {
      const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
      throw new Error(`Laozhang (Sync) failed: ${details}`);
    }
  }

  /**
   * Stub for compatibility, Sync API doesn't need polling.
   */
  public static async pollStatus(url: string): Promise<string> {
    return url;
  }
}
