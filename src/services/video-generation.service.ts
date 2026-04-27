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
    const effectiveModel = sysConfig.defaultVideoModel || input.model;

    // Force 8 seconds as per user request
    const finalDuration = 8;

    console.log(
      `[VideoGenerationService] Starting generation: model=${effectiveModel}, duration=${finalDuration}s, orientation=vertical`
    );

    // Format prompt for vertical 8-second generation
    const promptWithFormat = `${input.prompt}. Duration: ${finalDuration} seconds. 9:16 portrait orientation. Vertical video.`;

    // 1. CometAPI (Primary)
    try {
      console.log(`[VideoGenerationService] Attempting CometAPI (${effectiveModel})...`);
      const taskId = await CometService.generateVideo(
        promptWithFormat,
        effectiveModel
      );
      const url = await CometService.pollStatus(taskId);
      return { provider: 'comet', providerTaskId: taskId, resultVideoUrl: url };
    } catch (error) {
      console.error('CometAPI generation failed:', error instanceof Error ? error.message : error);
      throw new Error(`Video generation failed (CometAPI): ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
  }
}
