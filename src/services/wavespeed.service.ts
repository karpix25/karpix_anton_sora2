import axios from 'axios';
import { config } from '../config.js';

function getResultVideoUrl(data: any): string {
  if (Array.isArray(data?.outputs) && data.outputs[0]) {
    return data.outputs[0];
  }

  return '';
}

function normalizeDurationSeconds(value: number | undefined): number {
  const allowedDurations = [4, 8, 12, 16, 20];
  if (!value || !Number.isFinite(value) || value <= 0) {
    return config.waveSpeed.sora2DurationSeconds;
  }

  return allowedDurations.reduce((closest, current) => {
    const currentDistance = Math.abs(current - value);
    const closestDistance = Math.abs(closest - value);
    return currentDistance < closestDistance ? current : closest;
  }, allowedDurations[0] as number);
}

export class WaveSpeedService {
  public static isConfigured(): boolean {
    return config.waveSpeed.isConfigured;
  }

  public static async generateSora2Video(
    prompt: string,
    imageUrl: string,
    referenceDurationSeconds?: number,
  ): Promise<string> {
    const response = await axios.post(
      `${config.waveSpeed.baseUrl}/openai/sora-2/image-to-video`,
      {
        image: imageUrl,
        prompt,
        duration: normalizeDurationSeconds(referenceDurationSeconds),
      },
      {
        headers: {
          'Authorization': `Bearer ${config.waveSpeed.apiKey}`,
          'Content-Type': 'application/json',
        },
      }
    );

    const predictionId = response.data?.data?.id;
    if (!predictionId) {
      throw new Error('WaveSpeed did not return a prediction id');
    }

    return predictionId;
  }

  public static async pollStatus(predictionId: string): Promise<string> {
    const maxRetries = 60;
    const delay = 10000;

    for (let i = 0; i < maxRetries; i++) {
      const response = await axios.get(
        `${config.waveSpeed.baseUrl}/predictions/${predictionId}/result`,
        {
          headers: {
            'Authorization': `Bearer ${config.waveSpeed.apiKey}`,
          },
        }
      );

      const prediction = response.data?.data ?? response.data;
      const status = prediction?.status;

      if (status === 'completed') {
        const resultVideoUrl = getResultVideoUrl(prediction);
        if (!resultVideoUrl) {
          throw new Error('WaveSpeed completed the task but returned no video URL');
        }
        return resultVideoUrl;
      }

      if (status === 'failed') {
        throw new Error(`WaveSpeed generation failed: ${prediction?.error || 'Unknown error'}`);
      }

      await new Promise((resolve) => setTimeout(resolve, delay));
    }

    throw new Error('WaveSpeed task timed out');
  }
}
