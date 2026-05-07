import { projectStore } from '../storage/project-store.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { ManualGenerationService } from './manual-generation.service.js';
import type { GenerationTask } from '../domain/generation-task.js';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';

export class AutoGenerationService {
  private static interval: NodeJS.Timeout | null = null;
  private static isRunning = false;

  public static start(intervalMs: number = 30 * 60 * 1000) {
    if (this.interval) return;
    
    console.log(`[AutoGenerationService] Starting scheduler (interval: ${intervalMs / 1000 / 60} min)...`);
    this.interval = setInterval(() => this.tick(), intervalMs);
    
    // Run first tick after a short delay
    setTimeout(() => this.tick(), 10000);
  }

  public static stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private static async tick() {
    if (this.isRunning) return;
    this.isRunning = true;

    try {
      const projects = await projectStore.listProjects();
      const activeAutoProjects = projects.filter(p => p.isActive && p.automationEnabled && p.dailyGenerationLimit > 0);

      for (const project of activeAutoProjects) {
        try {
          await this.processProject(project.id);
        } catch (err: any) {
          console.error(`[AutoGenerationService] Failed to process project ${project.id}:`, err.message);
        }
      }
    } catch (err: any) {
      console.error('[AutoGenerationService] Tick failed:', err.message);
    } finally {
      this.isRunning = false;
    }
  }

  private static async processProject(projectId: string) {
    const project = await projectStore.getProject(projectId);
    if (!project || !project.automationEnabled || !project.isActive) return;

    const today = new Date().toISOString().slice(0, 10);
    let tasksToday = await generationTaskStore.countTasksForDate(projectId, today);

    if (tasksToday >= project.dailyGenerationLimit) {
      return;
    }

    console.log(
      `[AutoGenerationService] Project ${project.name}: limit not reached (${tasksToday}/${project.dailyGenerationLimit}). Processing auto queue...`
    );

    const shouldRemix = Math.random() * 100 < project.viralReusePercentage;

    if (shouldRemix) {
      console.log(`[AutoGenerationService] Project ${project.name}: Decided to trigger VIRAL REMIX.`);
      try {
        await ManualGenerationService.runViralRemix(projectId);
        return;
      } catch (err: any) {
        console.log(
          `[AutoGenerationService] Project ${project.name}: Viral Remix was skipped (${err.message}). Falling back to queue generation.`
        );
      }
    }

    await this.processPendingLibraryItems(projectId, today, tasksToday);
  }

  private static async processPendingLibraryItems(projectId: string, today: string, initialTasksToday: number) {
    const project = await projectStore.getProject(projectId);
    if (!project || !project.automationEnabled || !project.isActive) return;

    const libraryItems = await referenceLibraryStore.listProjectItems(projectId);
    const projectTasks = await generationTaskStore.listProjectTasks(projectId);
    const latestTaskByReference = this.getLatestTaskByReference(projectTasks);
    const pendingItems = this.getPendingLibraryItems(libraryItems, latestTaskByReference);

    if (!pendingItems.length) {
      console.log(`[AutoGenerationService] Project ${project.name}: No pending parsed/analyzed library items for auto generation.`);
      return;
    }

    let tasksToday = initialTasksToday;
    for (const item of pendingItems) {
      tasksToday = await generationTaskStore.countTasksForDate(projectId, today);
      if (tasksToday >= project.dailyGenerationLimit) {
        console.log(
          `[AutoGenerationService] Project ${project.name}: daily limit reached (${tasksToday}/${project.dailyGenerationLimit}). Queue paused.`
        );
        return;
      }

      const latestTask = latestTaskByReference.get(item.id);
      const promptText = latestTask?.status === 'failed' ? latestTask.promptText : '';

      try {
        console.log(
          `[AutoGenerationService] Project ${project.name}: auto-generating library item ${item.id} (${tasksToday}/${project.dailyGenerationLimit}).`
        );
        await ManualGenerationService.runFromLibraryItem({
          projectId: project.id,
          referenceLibraryItemId: item.id,
          triggerMode: 'auto',
          ...(promptText ? { promptText } : {}),
        });
      } catch (err: any) {
        console.error(
          `[AutoGenerationService] Project ${project.name}: failed to auto-generate library item ${item.id}:`,
          err.message
        );
      }
    }
  }

  private static getLatestTaskByReference(tasks: GenerationTask[]): Map<string, GenerationTask> {
    const latestTaskByReference = new Map<string, GenerationTask>();

    for (const task of tasks) {
      if (!latestTaskByReference.has(task.referenceLibraryItemId)) {
        latestTaskByReference.set(task.referenceLibraryItemId, task);
      }
    }

    return latestTaskByReference;
  }

  private static getPendingLibraryItems(
    libraryItems: ReferenceLibraryItem[],
    latestTaskByReference: Map<string, GenerationTask>
  ): ReferenceLibraryItem[] {
    return libraryItems
      .filter((item) => {
        if (item.status !== 'parsed' && item.status !== 'analyzed') {
          return false;
        }

        if (!item.directVideoUrl && !item.analysis) {
          return false;
        }

        const latestTask = latestTaskByReference.get(item.id);
        return !latestTask || latestTask.status === 'failed';
      })
      .sort((a, b) => Date.parse(a.createdAt) - Date.parse(b.createdAt));
  }
}
