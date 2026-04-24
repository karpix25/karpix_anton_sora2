import { KieService } from './kie.service.js';
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
      // Veo 3.1 R2V format: instruct model to use subject consistency but generate its own scene
      promptWithFormat = `The product/subject from the reference image is featured in this scene: ${input.prompt}. Duration: ${finalDuration} seconds. 9:16 portrait orientation. Maintain high visual consistency with the reference subject while ignoring its original background. Use natural lighting and a realistic environment.`;
    } else {
      // Sora/Other default format hints
      promptWithFormat = `portrait, 9:16, ${finalDuration} seconds, ${input.prompt}`;
    }

    // 1. KIE.AI (Primary & Only)
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
      console.error('Kie.ai generation failed:', error instanceof Error ? error.message : error);
      throw new Error(`Video generation failed (Kie.ai): ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
