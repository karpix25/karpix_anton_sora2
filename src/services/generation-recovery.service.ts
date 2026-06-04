import { ManualGenerationService } from './manual-generation.service.js';
import { generationTaskStore } from '../storage/generation-task-store.js';

function toPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class GenerationRecoveryService {
  private static hasStarted = false;
  private static isRunning = false;
  private static interval: NodeJS.Timeout | null = null;

  public static start(): void {
    if (this.hasStarted) {
      return;
    }

    this.hasStarted = true;
    void this.runRecovery().catch((error) => {
      console.error('[GenerationRecovery] Startup recovery failed:', error?.message || error);
    });

    const intervalMinutes = toPositiveNumber(process.env.RECOVERY_INTERVAL_MINUTES, 10);
    if (intervalMinutes > 0) {
      this.interval = setInterval(() => {
        void this.runRecovery().catch((error) => {
          console.error('[GenerationRecovery] Periodic recovery failed:', error?.message || error);
        });
      }, intervalMinutes * 60 * 1000);
      console.log(`[GenerationRecovery] Scheduled periodic recovery every ${intervalMinutes} minute(s).`);
    }
  }

  private static async runRecovery(): Promise<void> {
    if (this.isRunning) {
      console.log('[GenerationRecovery] Previous recovery pass is still running; skipping this pass.');
      return;
    }

    this.isRunning = true;
    try {
      await this.recoverIncompleteTasks();
    } finally {
      this.isRunning = false;
    }
  }

  public static async recoverIncompleteTasks(): Promise<void> {
    const limit = toPositiveNumber(process.env.RECOVERY_MAX_TASKS, 50);
    const pendingOlderThanSeconds = toPositiveNumber(process.env.RECOVERY_PENDING_OLDER_THAN_SECONDS, 20);
    const processingOlderThanSeconds = toPositiveNumber(process.env.RECOVERY_PROCESSING_OLDER_THAN_SECONDS, 120);
    const pendingDownloadOlderThanSeconds = toPositiveNumber(
      process.env.RECOVERY_PENDING_DOWNLOAD_OLDER_THAN_SECONDS,
      3600
    );

    const tasks = await generationTaskStore.listRecoverableTasks({
      limit,
      pendingOlderThanSeconds,
      processingOlderThanSeconds,
      pendingDownloadOlderThanSeconds,
    });

    if (!tasks.length) {
      console.log('[GenerationRecovery] No recoverable tasks found.');
      return;
    }

    console.log(`[GenerationRecovery] Recovering ${tasks.length} unfinished task(s)...`);

    for (const task of tasks) {
      try {
        console.log(`[GenerationRecovery] Resuming task ${task.id} (status=${task.status})`);
        const result = await ManualGenerationService.resumeTask(task.id);
        
        // Notify admin/topic about completion
        const { projectStore } = await import('../storage/project-store.js');
        const project = await projectStore.getProject(task.projectId);
        if (project) {
          const { AdminNotifierService } = await import('./admin-notifier.service.js');
          await AdminNotifierService.sendVideoToProject(project, result);
        }

        console.log(`[GenerationRecovery] Task ${task.id} resumed successfully and notified.`);
      } catch (error: any) {
        console.error(`[GenerationRecovery] Failed to recover task ${task.id}:`, error?.message || error);
      }
    }
  }
}
