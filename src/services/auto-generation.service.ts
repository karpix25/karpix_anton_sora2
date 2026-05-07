import { projectStore } from '../storage/project-store.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { ManualGenerationService } from './manual-generation.service.js';

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

    // 1. Check today's limit
    const today = new Date().toISOString().split('T')[0];
    const tasksToday = await generationTaskStore.countTasksForDate(projectId, today);

    if (tasksToday >= project.dailyGenerationLimit) {
      return;
    }

    console.log(`[AutoGenerationService] Project ${project.name}: limit not reached (${tasksToday}/${project.dailyGenerationLimit}). Triggering generation...`);

    // 2. Decide: New or Remix?
    const shouldRemix = Math.random() * 100 < project.viralReusePercentage;

    if (shouldRemix) {
      console.log(`[AutoGenerationService] Project ${project.name}: Decided to trigger VIRAL REMIX.`);
      const task = await ManualGenerationService.runViralRemix(projectId);
      if (task) return; // Success
      
      console.log(`[AutoGenerationService] Project ${project.name}: Viral Remix was skipped (no viral content). Falling back to new generation.`);
    }

    // 3. Fallback/Default: New Generation from Library
    const libraryItems = await referenceLibraryStore.listProjectItems(projectId);
    // Pick items that haven't been used yet today, or just pick one that is 'analyzed' or 'pending'
    // For simplicity, pick the oldest analyzed item that wasn't used recently
    const availableItems = libraryItems.filter(item => item.status !== 'failed');
    
    if (!availableItems.length) {
      console.log(`[AutoGenerationService] Project ${project.name}: No library items available for generation.`);
      return;
    }

    // Sort by created_at ascending (oldest first) or just pick one
    const targetItem = availableItems[0];
    
    console.log(`[AutoGenerationService] Project ${project.name}: Triggering NEW generation from library item ${targetItem.id}.`);
    await ManualGenerationService.runFromLibraryItem({
      projectId: project.id,
      referenceLibraryItemId: targetItem.id,
      triggerMode: 'auto',
    });
  }
}
