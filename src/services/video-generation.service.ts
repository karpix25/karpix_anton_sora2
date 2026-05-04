import { KieService } from './kie.service.js';
import { CometService } from './comet.service.js';
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
    const effectiveModel = input.model || sysConfig.defaultVideoModel || 'seedance-2';

    console.log(
      `[VideoGenerationService] Starting generation: model=${effectiveModel} (original=${input.model}), imageUrl=${input.imageUrl ? 'provided' : 'missing'}`
    );

    // Calculate effective duration (5-30s range per user requirements)
    // For Sora 2 we force 8 seconds as requested.
    let finalDuration = (effectiveModel === 'sora-2' || effectiveModel === 'seedance-2') ? 8 : (sysConfig.grokDuration || 10);
    
    if (effectiveModel !== 'sora-2' && effectiveModel !== 'seedance-2' && sysConfig.useReferenceDuration && input.referenceDurationSeconds) {
      finalDuration = Math.max(5, Math.min(30, Math.ceil(input.referenceDurationSeconds)));
      console.log(`[VideoGenerationService] Syncing duration with reference: ${input.referenceDurationSeconds}s -> ${finalDuration}s`);
    }

    const isGrok = effectiveModel.includes('grok');
    const isVeo = effectiveModel.includes('veo');
    const referenceLockInstructions = [
      'Use the exact same product identity from the reference image from the first frame to the last frame.',
      'Keep product shape, proportions, materials, cap/edges, label placement, typography layout, logo placement, and colors consistent.',
      'No product redesign, no morphing, no warping, no deformation, no brand/logo drift, no text drift, no replacing product with another item.',
      'The product must remain clearly visible and in focus whenever it is in frame.',
    ].join(' ');
    let promptWithFormat = input.prompt;

    if (isGrok) {
      // Grok requires referencing the image in the prompt as @image1
      promptWithFormat = `@image1 ${referenceLockInstructions} ${input.prompt} ${finalDuration} seconds`;
    } else if (isVeo) {
      // Veo 3.1 R2V format: instruct model to use subject consistency but generate its own scene
      promptWithFormat = `The product/subject from the reference image is featured in this scene: ${input.prompt}. ${referenceLockInstructions} Duration: ${finalDuration} seconds. 9:16 portrait orientation. Maintain high visual consistency with the reference subject while ignoring its original background. Use natural lighting and a realistic environment.`;
    } else {
      // Sora/Other default format hints
      promptWithFormat = `portrait, 9:16, ${finalDuration} seconds, ${referenceLockInstructions} ${input.prompt}`;
    }

    // 1. Comet API (Primary for Sora 2 & Seedance 2)
    if (effectiveModel === 'sora-2' || effectiveModel === 'seedance-2') {
      try {
        console.log(`[VideoGenerationService] Attempting Comet API (${effectiveModel})...`);
        const taskId = await CometService.generateVideo(
          promptWithFormat,
          input.imageUrl,
          effectiveModel,
          {
            duration: 8,
            aspect_ratio: '9:16'
          }
        );
        const videoPathOrUrl = await CometService.pollStatus(taskId);
        return { provider: 'comet', providerTaskId: taskId, resultVideoUrl: videoPathOrUrl };
      } catch (error) {
        console.warn('Comet API generation failed, falling back to Kie:', error instanceof Error ? error.message : error);
      }
    }

    // 2. KIE.AI (Fallback for Sora 2, Primary for others)
    try {
      console.log(`[VideoGenerationService] Attempting Kie.ai (${effectiveModel})...`);
      const taskId = await KieService.generateVideo(
        promptWithFormat, 
        input.imageUrl, 
        effectiveModel,
        {
          mode: sysConfig.grokMode,
          resolution: sysConfig.grokResolution === '1080p' ? '720p' : sysConfig.grokResolution as '480p' | '720p',
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
