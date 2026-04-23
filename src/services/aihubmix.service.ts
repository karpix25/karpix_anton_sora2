import axios from 'axios';

export interface AihubmixConfig {
  baseUrl: string;
  apiKey: string;
  model: string;
}

export class AihubmixService {
  /**
   * Generates video using an OpenAI-compatible chat completions endpoint.
   * Extracts the first URL found in the response content.
   */
  public static async generateVideo(
    config: AihubmixConfig,
    prompt: string,
    imageUrl?: string,
    aspect_ratio: string = '9:16'
  ): Promise<string> {
    const content: any[] = [{ type: 'text', text: prompt }];
    
    if (imageUrl) {
      content.push({
        type: 'image_url',
        image_url: { url: imageUrl }
      });
    }

    try {
      const response = await axios.post(
        `${config.baseUrl}/chat/completions`,
        {
          model: config.model,
          messages: [
            {
              role: 'user',
              content: content,
            },
          ],
        },
        {
          headers: {
            'Authorization': `Bearer ${config.apiKey}`,
            'Content-Type': 'application/json',
          },
          timeout: 300000, // 5 minutes for generation wait if sync
        }
      );

      const content = response.data?.choices?.[0]?.message?.content || '';
      if (!content) {
        throw new Error(`Empty response from aggregator (${config.model})`);
      }

      // Extract URL from content (markdown or plain text)
      const urlRegex = /(https?:\/\/[^\s\)]+)/g;
      const matches = content.match(urlRegex);

      if (!matches || matches.length === 0) {
        // Some providers might return the video URL directly if they use image/video generation format
        // but since we are using chat/completions as requested for AIHUBMIX, we parse text.
        throw new Error(`No video URL found in response from ${config.model}: ${content.substring(0, 100)}...`);
      }

      // Return the first URL found
      return matches[0];
    } catch (error: any) {
      const details = error.response?.data 
        ? JSON.stringify(error.response.data) 
        : error.message;
      throw new Error(`Aggregator (${config.model}) failed: ${details}`);
    }
  }
}
