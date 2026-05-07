import { GeminiService } from './gemini.service.js';
import { ProjectReferenceService } from './project-reference.service.js';
import { ReferenceAudioService } from './reference-audio.service.js';
import { TextOverlayService } from './text-overlay.service.js';
import { VideoPostprocessService } from './video-postprocess.service.js';
import { VideoGenerationService } from './video-generation.service.js';
import { YandexDiskService } from './yandex-disk.service.js';
import { S3StorageService } from './s3-storage.service.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { projectStore } from '../storage/project-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { InstagramService } from './instagram.service.js';
import type { GenerationTask, GenerationTriggerMode } from '../domain/generation-task.js';
import { ParserService } from './parser.service.js';
import type { Project } from '../domain/project.js';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';
import fs from 'fs-extra';

function nowIso(): string {
  return new Date().toISOString();
}

function buildVideoDescription(input: { project: Project; promptText: string; sourceUrl: string }): string {
  const base = input.promptText.trim();
  if (base) {
    return base;
  }

  const projectPart = input.project.productDescription?.trim() || input.project.productName?.trim() || input.project.name;
  const sourcePart = input.sourceUrl.trim();
  return [projectPart, sourcePart].filter(Boolean).join(' | ').slice(0, 4000);
}

function extractFileNameFromPath(value: string): string {
  const normalized = String(value || '').trim();
  if (!normalized) {
    return '';
  }

  const parts = normalized.split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

export class ManualGenerationService {
  public static async runFromLibraryItem(input: {
    projectId: string;
    referenceLibraryItemId: string;
    triggerMode: GenerationTriggerMode;
    promptText?: string;
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
      promptText: typeof input.promptText === 'string' ? input.promptText.trim() : '',
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
    console.log(
      `[ManualGenerationService] Task ${task.id}: starting processing (project=${project.id}, libraryItem=${initialLibraryItem.id})`
    );
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
      // Prioritize task-level overlay texts (e.g. from a viral remix) over library item defaults
      let textOverlays = (task.overlayTexts && task.overlayTexts.length > 0) 
        ? task.overlayTexts 
        : (libraryItem.textOverlays || []);
      
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

          // 1. Parallelize Video Analysis and Audio Extraction
          console.log('[ManualGenerationService] Running video analysis and audio extraction in parallel...');
          const [analysisResult] = await Promise.all([
            !analysis 
              ? GeminiService.analyzeVideo({
                  videoUrl: libraryItem.directVideoUrl,
                  ...(videoLocalPath ? { localPath: videoLocalPath } : {}),
                })
              : Promise.resolve(analysis),
            ReferenceAudioService.ensureAudioTrack(libraryItem),
          ]);

          analysis = analysisResult;
          needsUpdate = true;

          // 2. Text extraction depends on analysis result
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
      const promptText =
        task.promptText ||
        await GeminiService.generateClonningPrompt({
          videoAnalysis: analysis,
          targetModel: project.selectedModel,
          project,
          projectReferenceImageUrls,
        });

      if (!task.promptText) {
        await generationTaskStore.updateTask(task.id, {
          promptText,
        });
      } else {
        console.log(`[ManualGenerationService] Task ${task.id}: reusing previously generated prompt (length: ${promptText.length}).`);
      }

      // Sanitize prompt for providers (trim and reasonable length limit)
      const sanitizedPrompt = promptText.trim().slice(0, 1000);

      const generationReferenceImageUrl = await ProjectReferenceService.getGenerationReferenceImageUrl(
        project
      );
      if (!generationReferenceImageUrl) {
        throw new Error('Нет доступного фото товара. Загрузите референс в проект (нужно минимум одно фото).');
      }

      // Audio was already ensured in the parallel pre-processing block above
      const audio = await ReferenceAudioService.ensureAudioTrack(libraryItem);

      if (task.resultVideoUrl) {
        resultVideoUrl = task.resultVideoUrl;
        console.log(
          `[ManualGenerationService] Task ${task.id}: reusing existing generated video URL and continuing from postprocess.`
        );
      } else {
        console.log(`[ManualGenerationService] Task ${task.id}: starting generation with model=${project.selectedModel}, promptLength=${sanitizedPrompt.length}...`);
        const generationResult = await VideoGenerationService.generateWithFallback({
          prompt: sanitizedPrompt,
          imageUrl: generationReferenceImageUrl,
          model: project.selectedModel,
          referenceDurationSeconds: audio.durationSeconds,
        });
        console.log(
          `[ManualGenerationService] Task ${task.id}: generation completed by ${generationResult.provider} (providerTaskId=${generationResult.providerTaskId})`
        );
        resultVideoUrl = generationResult.resultVideoUrl;
        await generationTaskStore.updateTask(task.id, {
          provider: generationResult.provider,
          providerTaskId: generationResult.providerTaskId,
          resultVideoUrl,
        });
      }

      const videoDescription = buildVideoDescription({
        project,
        promptText,
        sourceUrl: libraryItem.sourceUrl,
      });

      let s3Upload = {
        bucket: task.s3Bucket || '',
        objectKey: task.s3ObjectKey || '',
        objectUrl: task.s3ObjectUrl || '',
        fileName: task.videoFileName || '',
        storedAt: task.s3StoredAt || '',
      };
      if (S3StorageService.isConfigured()) {
        if (s3Upload.objectKey) {
          console.log(`[ManualGenerationService] Task ${task.id}: original video already stored in S3, skipping upload.`);
        } else {
          console.log(`[ManualGenerationService] Task ${task.id}: uploading original generated video to S3...`);
          s3Upload = await S3StorageService.uploadGeneratedVideo({
            projectId: project.id,
            projectCode: project.projectCode,
            taskId: task.id,
            sourceVideoUrl: resultVideoUrl,
          });
        }
      } else {
        console.warn('[ManualGenerationService] S3 is not configured, skipping original video upload.');
      }

      if (s3Upload.objectKey || videoDescription || textOverlays.length) {
        await generationTaskStore.updateTask(task.id, {
          videoFileName: s3Upload.fileName,
          videoDescription,
          overlayTexts: textOverlays,
          s3Bucket: s3Upload.bucket,
          s3ObjectKey: s3Upload.objectKey,
          s3ObjectUrl: s3Upload.objectUrl,
          s3StoredAt: s3Upload.storedAt,
        });
      }

      console.log(`[ManualGenerationService] Task ${task.id}: starting postprocess with ffmpeg...`);
      mergedVideoPath = await VideoPostprocessService.applyAudioTrack({
        taskId: task.id,
        generatedVideoUrl: resultVideoUrl,
        audioFilePath: audio.audioFilePath,
        textOverlays: textOverlays,
        textStyle: project.textStyle,
        endFrameText: project.endFrameText || '',
        endFrameVerticalMargin: project.endFrameVerticalMargin,
        endFrameWidthPercent: project.endFrameWidthPercent,
        endFrameXPercent: project.endFrameXPercent,
      });
      console.log(`[ManualGenerationService] Task ${task.id}: postprocess completed, uploading to Yandex Disk...`);

      const storedVideo = await YandexDiskService.uploadGeneratedVideoFile({
        projectName: project.name,
        projectCode: project.projectCode,
        taskId: task.id,
        filePath: mergedVideoPath,
      });

      const completedTask = await generationTaskStore.updateTask(task.id, {
        status: 'completed',
        promptText,
        resultVideoUrl,
        videoFileName: s3Upload.fileName || extractFileNameFromPath(storedVideo.diskPath),
        videoDescription,
        overlayTexts: textOverlays,
        yandexDiskPath: storedVideo.diskPath,
        yandexDownloadUrl: storedVideo.downloadUrl,
        s3Bucket: s3Upload.bucket,
        s3ObjectKey: s3Upload.objectKey,
        s3ObjectUrl: s3Upload.objectUrl,
        s3StoredAt: s3Upload.storedAt,
        storedAt: storedVideo.syncedAt,
        finishedAt: nowIso(),
      });
      if (!completedTask) {
        throw new Error(`Task disappeared while completing: ${task.id}`);
      }
      console.log(`[ManualGenerationService] Task ${task.id}: completed successfully.`);
      return completedTask;
    } catch (error: any) {
      const errorMsg = error?.message || String(error);
      console.error(`[ManualGenerationService] Task ${task.id}: failed:`, errorMsg);
      await generationTaskStore.updateTask(task.id, {
        status: 'failed',
        errorMessage: errorMsg,
        finishedAt: nowIso(),
      });
      throw error;
    } finally {
      if (mergedVideoPath && await fs.pathExists(mergedVideoPath)) {
        await fs.remove(mergedVideoPath);
      }
    }
  }

  public static async runViralRemix(projectId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project) throw new Error(`Project not found: ${projectId}`);

    // 1. Find all tasks with publication_url
    const tasksWithPub = await generationTaskStore.findTasksWithPublication(projectId);
    if (!tasksWithPub.length) {
      console.log(`[ManualGenerationService] Project ${projectId}: No tasks with publication URLs found for remixing.`);
      return null;
    }

    // 2. Query Parser DB for view counts
    const urls = tasksWithPub.map(t => t.publicationUrl!);
    const viralVideos = await ParserService.getViralVideos(urls, project.minViewsToReuse || 1000);
    
    if (!viralVideos.length) {
      console.log(`[ManualGenerationService] Project ${projectId}: No viral videos found above threshold ${project.minViewsToReuse}.`);
      return null;
    }

    // 3. Pick one viral video (randomly from the top ones)
    const viral = viralVideos[Math.floor(Math.random() * viralVideos.length)];
    const originalTask = tasksWithPub.find(t => t.publicationUrl === viral.url)!;
    
    const libraryItem = await referenceLibraryStore.getItem(originalTask.referenceLibraryItemId);
    if (!libraryItem) throw new Error('Original library item not found for viral task');

    // 4. Pick a NEW random audio from the project library
    const allLibraryItems = await referenceLibraryStore.listProjectItems(projectId);
    const audioItems = allLibraryItems.filter(item => item.audioFilePath || item.directVideoUrl);
    
    // Try to pick one DIFFERENT from the original if possible
    let remixAudioItem = audioItems.length > 1 
      ? audioItems.filter(item => item.id !== libraryItem.id)[Math.floor(Math.random() * (audioItems.length - 1))]
      : audioItems[0];
    
    if (!remixAudioItem) {
      console.log(`[ManualGenerationService] Project ${projectId}: No audio items found in library for remix.`);
      return null;
    }

    console.log(`[ManualGenerationService] Project ${projectId}: Remixing viral video ${viral.url} (${viral.views} views). Using audio from ${remixAudioItem.id}.`);

    // 5. Generate NEW trigger texts via Gemini (instead of new video prompt)
    const newTexts = await GeminiService.generateRemixTexts({
      videoAnalysis: libraryItem.analysis,
      originalTexts: originalTask.overlayTexts || [],
      project,
    });

    // 6. Create new task reusing the clean generated video URL
    const task = await generationTaskStore.createTask({
      projectId: project.id,
      referenceLibraryItemId: remixAudioItem.id, // Using the new audio item for sound
      triggerMode: 'auto_remix',
      targetModel: project.selectedModel,
      provider: originalTask.provider, // Reuse provider info
      status: 'pending',
      promptText: originalTask.promptText, // Keep original prompt for reference
      resultVideoUrl: originalTask.resultVideoUrl, // CRITICAL: This skips generation in processTask
      overlayTexts: newTexts, // Use the new viral texts
    });

    // We process it normally, it will skip generation and go straight to postprocess with new audio + new texts
    return this.processTask(task, project, remixAudioItem);
  }
}
