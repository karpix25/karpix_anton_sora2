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
      // Use Laozhang's New Async Video API for Veo 3.1 with Multipart/Form-Data
      let tempFilePath: string | null = null;
      try {
        const targetModel = 'veo-3.1-fl'; // Standard quality i2v
        
        console.log(`[LaozhangService] Preparing Async Veo Task: model=${targetModel}`);

        // 1. Download the remote image to a temporary local file
        const fs = await import('fs');
        const path = await import('path');
        const os = await import('os');
        const { Readable } = await import('stream');
        const { finished } = await import('stream/promises');

        const tempDir = os.tmpdir();
        tempFilePath = path.join(tempDir, `veo_ref_${Date.now()}.jpg`);
        
        const writer = fs.createWriteStream(tempFilePath);
        const imgResponse = await axios.get(imageUrl, { responseType: 'stream' });
        imgResponse.data.pipe(writer);
        await finished(writer);

        // 2. Build Form-Data
        const FormData = (await import('form-data')).default;
        const form = new FormData();
        form.append('model', targetModel);
        form.append('prompt', prompt);
        form.append('input_reference', fs.createReadStream(tempFilePath));
        
        // Note: aspect_ratio is often encoded in model name or ignored in some versions, 
        // but we'll include it if documentation suggests. 
        // Based on research, model name covers it, but let's be safe.
        form.append('aspect_ratio', aspect_ratio === '9:16' ? '9:16' : '16:9');

        console.log(`[LaozhangService] Uploading image and creating task...`);

        const response = await axios.post(
          `${config.laozhang.baseUrl}/videos`,
          form,
          {
            headers: {
              ...form.getHeaders(),
              'Authorization': `Bearer ${config.laozhang.apiKey}`,
            },
            timeout: 60000, // 1 minute for upload + creation
          }
        );

        const taskId = response.data?.id || response.data?.task_id;
        if (!taskId) {
          throw new Error(`Failed to get taskId from Laozhang: ${JSON.stringify(response.data)}`);
        }

        return taskId;
      } catch (error: any) {
        const details = error.response?.data ? JSON.stringify(error.response.data) : error.message;
        throw new Error(`Laozhang (Veo Form-Data) creation failed: ${details}`);
      } finally {
        // 3. Clean up temp file
        if (tempFilePath) {
          try {
            const fs = await import('fs');
            if (fs.existsSync(tempFilePath)) fs.unlinkSync(tempFilePath);
          } catch (e) {
            console.warn(`[LaozhangService] Failed to delete temp file: ${tempFilePath}`);
          }
        }
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
