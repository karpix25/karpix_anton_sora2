import { KieService } from './kie.service.js';
import { AihubmixService } from './aihubmix.service.js';
import { LaozhangService } from './laozhang.service.js';
import { DefApiService } from './defapi.service.js';
import { config } from '../config.js';
import type { GenerationProvider } from '../domain/generation-task.js';
import type { VideoModel } from '../domain/project.js';

export interface VideoGenerationResult {
  provider: GenerationProvider;
  providerTaskId: string;
  resultVideoUrl: string;
}

export class VideoGenerationService {
  public static async generateWithFallback(input: {
    prompt: string;
    imageUrl: string;
    model: VideoModel;
    referenceDurationSeconds?: number;
  }): Promise<VideoGenerationResult> {
    console.log(
      `[VideoGenerationService] Starting generation: model=${input.model}, imageUrl=${input.imageUrl ? 'provided' : 'missing'}`
    );

    // 1. KIE.AI (Primary)
    try {
      console.log('[VideoGenerationService] Attempting Kie.ai...');
      const taskId = await KieService.generateVideo(input.prompt, input.imageUrl, input.model);
      const url = await KieService.pollStatus(taskId);
      return { provider: 'kie', providerTaskId: taskId, resultVideoUrl: url };
    } catch (error) {
      console.warn('Kie.ai failed, trying AIHUBMIX...', error instanceof Error ? error.message : error);
    }

    // 2. AIHUBMIX (Fallback 1) - Sync/Long-poll
    if (config.aihubmix.isConfigured) {
      try {
        console.log('[VideoGenerationService] Attempting AIHUBMIX...');
        const url = await AihubmixService.generateVideo(
          { ...config.aihubmix, model: 'web-sora-2' },
          input.prompt,
          input.imageUrl
        );
        return { provider: 'aihubmix', providerTaskId: 'synced', resultVideoUrl: url };
      } catch (error) {
        console.warn('AIHUBMIX failed, trying Laozhang...', error instanceof Error ? error.message : error);
      }
    }

    // 3. Laozhang (Fallback 2) - Native Polling
    if (config.laozhang.isConfigured) {
      try {
        console.log('[VideoGenerationService] Attempting Laozhang (Async)...');
        const taskId = await LaozhangService.generateVideo(input.prompt, input.imageUrl, 'sora-2');
        const url = await LaozhangService.pollStatus(taskId);
        return { provider: 'laozhang', providerTaskId: taskId, resultVideoUrl: url };
      } catch (error) {
        console.warn('Laozhang failed, trying DefAPI...', error instanceof Error ? error.message : error);
      }
    }

    // 4. DefAPI (Fallback 3) - Native Polling
    if (config.defapi.isConfigured) {
      try {
        console.log('[VideoGenerationService] Attempting DefAPI (Async)...');
        const taskId = await DefApiService.generateVideo(input.prompt, input.imageUrl, 'sora-2');
        const url = await DefApiService.pollStatus(taskId);
        return { provider: 'defapi', providerTaskId: taskId, resultVideoUrl: url };
      } catch (error) {
        console.warn('DefAPI failed, trying DefAPI Stable...', error instanceof Error ? error.message : error);
      }
    }

    // 5. DefAPI Stable (Fallback 4) - Native Polling
    if (config.defapi.isConfigured) {
      try {
        console.log('[VideoGenerationService] Attempting DefAPI Stable (Async)...');
        const taskId = await DefApiService.generateVideo(input.prompt, input.imageUrl, 'sora-2-stable');
        const url = await DefApiService.pollStatus(taskId);
        return { provider: 'defapi-stable', providerTaskId: taskId, resultVideoUrl: url };
      } catch (error) {
        console.error('All providers failed:', error instanceof Error ? error.message : error);
      }
    }

    throw new Error('All video generation providers failed or are not configured.');
  }
}
