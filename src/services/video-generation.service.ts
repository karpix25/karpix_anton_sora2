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

export class PromptModerationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptModerationError';
  }
}

export class ProviderRateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ProviderRateLimitError';
  }
}

export class VideoGenerationFallbackError extends Error {
  public readonly primaryErrorMessage: string;
  public readonly fallbackErrorMessage: string;

  constructor(input: {
    primaryErrorMessage: string;
    fallbackErrorMessage: string;
  }) {
    super(input.primaryErrorMessage);
    this.name = 'VideoGenerationFallbackError';
    this.primaryErrorMessage = input.primaryErrorMessage;
    this.fallbackErrorMessage = input.fallbackErrorMessage;
  }
}

export function isPromptModerationError(error: unknown): error is PromptModerationError {
  return error instanceof PromptModerationError || isModerationError(error);
}

export function getPrimaryGenerationErrorMessage(error: unknown): string {
  if (error instanceof VideoGenerationFallbackError) {
    return error.primaryErrorMessage;
  }

  return (error as any)?.message || String(error);
}

function isModerationError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return (
    message.includes('content_moderation_failed') ||
    message.includes('moderation system') ||
    message.includes('blocked by moderation') ||
    message.includes('blocked by our moderation') ||
    message.includes('flagged categories') ||
    message.includes('prohibited_content') ||
    message.includes('safety filter') ||
    message.includes('nsfw')
  );
}

function isProviderRateLimitError(error: unknown): boolean {
  const message = String((error as any)?.message || error || '').toLowerCase();
  return (
    message.includes('429') ||
    message.includes('too many requests') ||
    message.includes('rate limit') ||
    message.includes('saturated') ||
    message.includes('try again later') ||
    message.includes('upstream load')
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export class VideoGenerationService {
  private static readonly cometRateRetryDelaysMs = [30_000, 60_000, 120_000, 180_000];

  public static async generateWithFallback(input: {
    prompt: string;
    imageUrl: string;
    model: VideoModel;
    referenceDurationSeconds?: number;
  }): Promise<VideoGenerationResult> {
    const sysConfig = await systemConfigStore.getConfig();
    const effectiveModel = input.model || sysConfig.defaultVideoModel || 'seedance-2';
    const isCometPrimaryModel = effectiveModel === 'sora-2' || effectiveModel === 'seedance-2';
    const isWan27Model = effectiveModel === 'wan-2-7';

    console.log(
      `[VideoGenerationService] Starting generation: model=${effectiveModel} (original=${input.model}), imageUrl=${input.imageUrl ? 'provided' : 'missing'}`
    );

    // Calculate effective duration (5-30s range per user requirements).
    // For Comet primary models and Wan 2.7 we force 8 seconds as requested.
    let finalDuration = (isCometPrimaryModel || isWan27Model) ? 8 : (sysConfig.grokDuration || 10);
    
    if (!isCometPrimaryModel && !isWan27Model && sysConfig.useReferenceDuration && input.referenceDurationSeconds) {
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
    let primaryProviderErrorMessage = '';
    if (isCometPrimaryModel) {
      try {
        const taskId = await this.startCometWithRateLimitRetry({
          prompt: promptWithFormat,
          imageUrl: input.imageUrl,
          model: effectiveModel,
        });
        const videoPathOrUrl = await CometService.pollStatus(taskId);
        return { provider: 'comet', providerTaskId: taskId, resultVideoUrl: videoPathOrUrl };
      } catch (error: any) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        if (isModerationError(error)) {
          throw new PromptModerationError(`Comet blocked prompt by moderation: ${errorMsg}`);
        }
        if (error instanceof ProviderRateLimitError || isProviderRateLimitError(error)) {
          throw new ProviderRateLimitError(`Comet API is rate limited or saturated after retries: ${errorMsg}`);
        }
        primaryProviderErrorMessage = `Video generation failed (Comet API): ${errorMsg}`;
        console.warn(`Comet API generation failed, falling back to Kie: ${errorMsg}`);
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
          resolution: isWan27Model
            ? '720p'
            : (sysConfig.grokResolution === '1080p' ? '720p' : sysConfig.grokResolution as '480p' | '720p'),
          duration: isWan27Model ? 8 : finalDuration,
          aspect_ratio: '9:16'
        }
      );
      const url = await KieService.pollStatus(taskId, effectiveModel);
      return { provider: 'kie', providerTaskId: taskId, resultVideoUrl: url };
    } catch (error) {
      const fallbackErrorMessage = `Video generation failed (Kie.ai): ${error instanceof Error ? error.message : 'Unknown error'}`;
      console.error('Kie.ai generation failed:', error instanceof Error ? error.message : error);
      if (isModerationError(error)) {
        throw new PromptModerationError(`Kie.ai blocked prompt by moderation: ${error instanceof Error ? error.message : 'Unknown moderation error'}`);
      }
      if (primaryProviderErrorMessage) {
        throw new VideoGenerationFallbackError({
          primaryErrorMessage: primaryProviderErrorMessage,
          fallbackErrorMessage,
        });
      }
      throw new Error(fallbackErrorMessage);
    }
  }

  private static async startCometWithRateLimitRetry(input: {
    prompt: string;
    imageUrl: string;
    model: VideoModel;
  }): Promise<string> {
    for (let attempt = 0; attempt <= this.cometRateRetryDelaysMs.length; attempt += 1) {
      try {
        console.log(`[VideoGenerationService] Attempting Comet API (${input.model})...`);
        return await CometService.generateVideo(
          input.prompt,
          input.imageUrl,
          input.model,
          {
            duration: 8,
            aspect_ratio: '9:16',
          }
        );
      } catch (error: any) {
        if (isModerationError(error)) {
          throw error;
        }

        if (!isProviderRateLimitError(error)) {
          throw error;
        }

        const delayMs = this.cometRateRetryDelaysMs[attempt];
        if (delayMs === undefined) {
          throw new ProviderRateLimitError(error instanceof Error ? error.message : String(error));
        }

        console.warn(
          `[VideoGenerationService] Comet API is saturated/rate-limited. Waiting ${Math.round(delayMs / 1000)}s before retry (${attempt + 1}/${this.cometRateRetryDelaysMs.length})...`
        );
        await sleep(delayMs);
      }
    }

    throw new ProviderRateLimitError('Comet API rate-limit retries exhausted');
  }
}
