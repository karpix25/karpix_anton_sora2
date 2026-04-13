import { GeminiService } from './gemini.service.js';
import { ProjectReferenceService } from './project-reference.service.js';
import { ReferenceAudioService } from './reference-audio.service.js';
import { TextOverlayService } from './text-overlay.service.js';
import { VideoPostprocessService } from './video-postprocess.service.js';
import { VideoGenerationService } from './video-generation.service.js';
import { YandexDiskService } from './yandex-disk.service.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { projectStore } from '../storage/project-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import type { GenerationTriggerMode } from '../domain/generation-task.js';
import fs from 'fs-extra';

function nowIso(): string {
  return new Date().toISOString();
}

export class ManualGenerationService {
  public static async runFromLibraryItem(input: {
    projectId: string;
    referenceLibraryItemId: string;
    triggerMode: GenerationTriggerMode;
    fallbackReferenceImageUrl?: string;
  }) {
    const project = await projectStore.getProject(input.projectId);
    if (!project) {
      throw new Error(`Project not found: ${input.projectId}`);
    }

    let libraryItem = await referenceLibraryStore.getItem(input.referenceLibraryItemId);
    if (!libraryItem || libraryItem.projectId !== project.id) {
      throw new Error('Reference library item not found for this project');
    }

    const task = await generationTaskStore.createTask({
      projectId: project.id,
      referenceLibraryItemId: libraryItem.id,
      triggerMode: input.triggerMode,
      targetModel: project.selectedModel,
      provider: 'kie',
      status: 'pending',
    });

    await generationTaskStore.updateTask(task.id, {
      status: 'processing',
      startedAt: nowIso(),
      errorMessage: '',
    });

    let mergedVideoPath = '';
    try {
      let resultVideoUrl = '';
      let analysis = libraryItem.analysis;
      if (!analysis) {
        if (!libraryItem.directVideoUrl) {
          throw new Error('Reference item has no analysis and no direct video URL');
        }

        await referenceLibraryStore.updateItem(libraryItem.id, { status: 'analyzing' });
        analysis = await GeminiService.analyzeVideo({ videoUrl: libraryItem.directVideoUrl });
        await referenceLibraryStore.updateItem(libraryItem.id, {
          analysis,
          status: 'analyzed',
          errorMessage: '',
        });
        libraryItem = (await referenceLibraryStore.getItem(libraryItem.id)) || libraryItem;
      }

      let textOverlays = libraryItem.textOverlays || [];
      if (!textOverlays.length && libraryItem.directVideoUrl) {
        textOverlays = await TextOverlayService.extractFromVideo({
          videoUrl: libraryItem.directVideoUrl,
          analysis,
        });

        await referenceLibraryStore.updateItem(libraryItem.id, {
          textOverlays,
        });
        libraryItem = (await referenceLibraryStore.getItem(libraryItem.id)) || libraryItem;
      }

      const projectReferenceImageUrls = await projectStore.getReferenceImageDataUrls(project.referenceImages);
      const promptText = await GeminiService.generateClonningPrompt({
        videoAnalysis: analysis,
        targetModel: project.selectedModel,
        project,
        projectReferenceImageUrls,
      });

      await generationTaskStore.updateTask(task.id, {
        promptText,
      });

      const generationReferenceImageUrl = await ProjectReferenceService.getGenerationReferenceImageUrl(
        project,
        input.fallbackReferenceImageUrl || libraryItem.thumbnailUrl
      );
      if (!generationReferenceImageUrl) {
        throw new Error('Нет доступного изображения для генерации. Добавьте референс в проект или дождитесь thumbnail из Reel.');
      }

      const audio = await ReferenceAudioService.ensureAudioTrack(libraryItem);

      const generationResult = await VideoGenerationService.generateWithFallback({
        prompt: promptText,
        imageUrl: generationReferenceImageUrl,
        model: project.selectedModel,
        referenceDurationSeconds: audio.durationSeconds,
      });
      resultVideoUrl = generationResult.resultVideoUrl;
      await generationTaskStore.updateTask(task.id, {
        provider: generationResult.provider,
        providerTaskId: generationResult.providerTaskId,
        resultVideoUrl,
      });

      mergedVideoPath = await VideoPostprocessService.applyAudioTrack({
        taskId: task.id,
        generatedVideoUrl: resultVideoUrl,
        audioFilePath: audio.audioFilePath,
        textOverlays: textOverlays,
      });

      const storedVideo = await YandexDiskService.uploadGeneratedVideoFile({
        projectName: project.name,
        taskId: task.id,
        filePath: mergedVideoPath,
      });

      return generationTaskStore.updateTask(task.id, {
        status: 'completed',
        promptText,
        resultVideoUrl,
        yandexDiskPath: storedVideo.diskPath,
        yandexDownloadUrl: storedVideo.downloadUrl,
        storedAt: storedVideo.syncedAt,
        finishedAt: nowIso(),
      });
    } catch (error: any) {
      await generationTaskStore.updateTask(task.id, {
        status: 'failed',
        errorMessage: error.message,
        finishedAt: nowIso(),
      });
      throw error;
    } finally {
      if (mergedVideoPath && await fs.pathExists(mergedVideoPath)) {
        await fs.remove(mergedVideoPath);
      }
    }
  }
}
