import { KieService } from './kie.service.js';
import { WaveSpeedService } from './wavespeed.service.js';
import type { GenerationProvider } from '../domain/generation-task.js';
import type { VideoModel } from '../domain/project.js';

export interface VideoGenerationResult {
  provider: GenerationProvider;
  providerTaskId: string;
  resultVideoUrl: string;
}

function shouldUseWaveSpeedFallback(model: VideoModel, error: unknown): boolean {
  if (model !== 'sora-2' || !WaveSpeedService.isConfigured()) {
    return false;
  }

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();
  return Boolean(message);
}

export class VideoGenerationService {
  public static async generateWithFallback(input: {
    prompt: string;
    imageUrl: string;
    model: VideoModel;
    referenceDurationSeconds?: number;
  }): Promise<VideoGenerationResult> {
    try {
      const providerTaskId = await KieService.generateVideo(input.prompt, input.imageUrl, input.model);
      const resultVideoUrl = await KieService.pollStatus(providerTaskId);
      return {
        provider: 'kie',
        providerTaskId,
        resultVideoUrl,
      };
    } catch (error) {
      if (!shouldUseWaveSpeedFallback(input.model, error)) {
        throw error;
      }

      console.warn('Kie generation failed, switching to WaveSpeed fallback:', error);

      const providerTaskId = await WaveSpeedService.generateSora2Video(
        input.prompt,
        input.imageUrl,
        input.referenceDurationSeconds,
      );
      const resultVideoUrl = await WaveSpeedService.pollStatus(providerTaskId);
      return {
        provider: 'wavespeed',
        providerTaskId,
        resultVideoUrl,
      };
    }
  }
}
