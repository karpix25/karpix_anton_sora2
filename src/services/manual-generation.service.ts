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
import { InstagramService } from './instagram.service.js';
import type { GenerationTask, GenerationTriggerMode } from '../domain/generation-task.js';
import type { Project } from '../domain/project.js';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';
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

    return this.processTask(task, project, libraryItem);
  }

  public static async resumeTask(taskId: string) {
    const task = await generationTaskStore.getTask(taskId);
    if (!task) {
      throw new Error(`Generation task not found: ${taskId}`);
    }

    if (task.status === 'completed') {
      return task;
    }

    const context = await this.loadTaskContext(task);
    return this.processTask(task, context.project, context.libraryItem);
  }

  private static async loadTaskContext(task: GenerationTask): Promise<{ project: Project; libraryItem: ReferenceLibraryItem }> {
    const project = await projectStore.getProject(task.projectId);
    if (!project) {
      throw new Error(`Project not found for task ${task.id}: ${task.projectId}`);
    }

    const libraryItem = await referenceLibraryStore.getItem(task.referenceLibraryItemId);
    if (!libraryItem || libraryItem.projectId !== project.id) {
      throw new Error(`Reference library item not found for task ${task.id}: ${task.referenceLibraryItemId}`);
    }

    return { project, libraryItem };
  }

  private static async processTask(task: GenerationTask, project: Project, initialLibraryItem: ReferenceLibraryItem) {
    await generationTaskStore.updateTask(task.id, {
      status: 'processing',
      startedAt: task.startedAt || nowIso(),
      finishedAt: '',
      errorMessage: '',
    });

    let mergedVideoPath = '';
    try {
      let libraryItem = initialLibraryItem;
      let resultVideoUrl = '';
      let analysis = libraryItem.analysis;
      let textOverlays = libraryItem.textOverlays || [];
      
      // Force processing if missing components
      if (!analysis || !textOverlays.length) {
        if (!libraryItem.directVideoUrl) {
          throw new Error('Reference item has no analysis and no direct video URL');
        }

        let videoLocalPath: string | null = null;
        let needsUpdate = false;

        try {
          // Download for stability if something is missing
          if (!analysis || !textOverlays.length) {
            console.log(`[ManualGenerationService] Downloading video for ${!analysis ? 'analysis' : ''} ${!textOverlays.length ? 'and text extraction' : ''}...`);
            videoLocalPath = await InstagramService.downloadVideo(libraryItem.directVideoUrl);
          }

          if (!analysis) {
            console.log('[ManualGenerationService] Running video analysis...');
            analysis = await GeminiService.analyzeVideo({
              videoUrl: libraryItem.directVideoUrl,
              ...(videoLocalPath ? { localPath: videoLocalPath } : {}),
            });
            needsUpdate = true;
          }

          if (!textOverlays.length) {
            console.log('[ManualGenerationService] Running text overlay extraction...');
            textOverlays = await TextOverlayService.extractFromVideo({
              videoUrl: libraryItem.directVideoUrl,
              analysis,
              ...(videoLocalPath ? { localPath: videoLocalPath } : {}),
            });
            needsUpdate = true;
          }
        } finally {
          if (videoLocalPath) {
            fs.remove(videoLocalPath).catch(err => 
              console.error('[ManualGenerationService] Failed to cleanup temp video:', err.message)
            );
          }
        }

        if (needsUpdate) {
          await referenceLibraryStore.updateItem(libraryItem.id, {
            analysis,
            textOverlays,
            status: 'analyzed',
          });
          libraryItem = (await referenceLibraryStore.getItem(libraryItem.id)) || libraryItem;
        }
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
        project
      );
      if (!generationReferenceImageUrl) {
        throw new Error('Нет доступного фото товара. Загрузите референс в проект (нужно минимум одно фото).');
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
        trimVideoToAudio: project.trimVideoToAudio,
        textOverlays: textOverlays,
        textStyle: project.textStyle,
      });

      const storedVideo = await YandexDiskService.uploadGeneratedVideoFile({
        projectName: project.name,
        taskId: task.id,
        filePath: mergedVideoPath,
      });

      const completedTask = await generationTaskStore.updateTask(task.id, {
        status: 'completed',
        promptText,
        resultVideoUrl,
        yandexDiskPath: storedVideo.diskPath,
        yandexDownloadUrl: storedVideo.downloadUrl,
        storedAt: storedVideo.syncedAt,
        finishedAt: nowIso(),
      });
      if (!completedTask) {
        throw new Error(`Task disappeared while completing: ${task.id}`);
      }
      return completedTask;
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
