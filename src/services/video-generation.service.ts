import { KieService } from './kie.service.js';
import { LaozhangService } from './laozhang.service.js';
import { config } from '../config.js';
import { systemConfigStore } from '../storage/system-config-store.js';
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
    const sysConfig = await systemConfigStore.getConfig();
    const effectiveModel = sysConfig.defaultVideoModel || input.model;

    console.log(
      `[VideoGenerationService] Starting generation: model=${effectiveModel} (original=${input.model}), imageUrl=${input.imageUrl ? 'provided' : 'missing'}`
    );

    // Calculate effective duration (5-30s range per user requirements)
    let finalDuration = sysConfig.grokDuration || 10;
    if (sysConfig.useReferenceDuration && input.referenceDurationSeconds) {
      finalDuration = Math.max(5, Math.min(30, Math.ceil(input.referenceDurationSeconds)));
      console.log(`[VideoGenerationService] Syncing duration with reference: ${input.referenceDurationSeconds}s -> ${finalDuration}s`);
    }

    const isGrok = effectiveModel.includes('grok');
    const isVeo = effectiveModel.includes('veo');
    let promptWithFormat = input.prompt;

    if (isGrok) {
      // Grok requires referencing the image in the prompt as @image1
      promptWithFormat = `@image1 ${input.prompt} ${finalDuration} seconds`;
    } else if (isVeo) {
      // Veo 3.1 also benefits from explicit duration
      promptWithFormat = `${input.prompt} ${finalDuration} seconds, 9:16 portrait style`;
    } else {
      // Sora/Other default format hints
      promptWithFormat = `portrait, 9:16, ${finalDuration} seconds, ${input.prompt}`;
    }

    // 1. KIE.AI (Primary)
    try {
      console.log(`[VideoGenerationService] Attempting Kie.ai (${effectiveModel})...`);
      const taskId = await KieService.generateVideo(
        promptWithFormat, 
        input.imageUrl, 
        effectiveModel,
        {
          mode: sysConfig.grokMode,
          resolution: sysConfig.grokResolution,
          aspect_ratio: '9:16'
        }
      );
      const url = await KieService.pollStatus(taskId, effectiveModel);
      return { provider: 'kie', providerTaskId: taskId, resultVideoUrl: url };
    } catch (error) {
      console.warn('Kie.ai failed, trying AIHUBMIX...', error instanceof Error ? error.message : error);
    }

    // 2. Laozhang (Fallback) - Native Polling
    if (config.laozhang.isConfigured) {
      try {
        console.log(`[VideoGenerationService] Attempting Laozhang (${effectiveModel})...`);
        const result = await LaozhangService.generateVideo(
          promptWithFormat, 
          input.imageUrl, 
          effectiveModel, 
          '9:16'
        );
        const url = await LaozhangService.pollStatus(result);
        if (typeof url !== 'string') throw new Error('Invalid URL returned from Laozhang');
        return { provider: 'laozhang', providerTaskId: result, resultVideoUrl: url };
      } catch (error) {
        console.error('All providers (Kie, Laozhang) failed:', error instanceof Error ? error.message : error);
      }
    }

    throw new Error('All primary video generation providers (Kie, Laozhang) failed or are not configured.');
  }
}
