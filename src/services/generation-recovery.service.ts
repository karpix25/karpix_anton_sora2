import { ManualGenerationService } from './manual-generation.service.js';
import { generationTaskStore } from '../storage/generation-task-store.js';

function toPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

export class GenerationRecoveryService {
  private static hasStarted = false;

  public static start(): void {
    if (this.hasStarted) {
      return;
    }

    this.hasStarted = true;
    void this.recoverIncompleteTasks().catch((error) => {
      console.error('[GenerationRecovery] Startup recovery failed:', error?.message || error);
    });
  }

  public static async recoverIncompleteTasks(): Promise<void> {
    const limit = toPositiveNumber(process.env.RECOVERY_MAX_TASKS, 50);
    const pendingOlderThanSeconds = toPositiveNumber(process.env.RECOVERY_PENDING_OLDER_THAN_SECONDS, 20);
    const processingOlderThanSeconds = toPositiveNumber(process.env.RECOVERY_PROCESSING_OLDER_THAN_SECONDS, 120);

    const tasks = await generationTaskStore.listRecoverableTasks({
      limit,
      pendingOlderThanSeconds,
      processingOlderThanSeconds,
    });

    if (!tasks.length) {
      console.log('[GenerationRecovery] No recoverable tasks found.');
      return;
    }

    console.log(`[GenerationRecovery] Recovering ${tasks.length} unfinished task(s)...`);

    for (const task of tasks) {
      try {
        console.log(`[GenerationRecovery] Resuming task ${task.id} (status=${task.status})`);
        await ManualGenerationService.resumeTask(task.id);
        console.log(`[GenerationRecovery] Task ${task.id} resumed successfully.`);
      } catch (error: any) {
        console.error(`[GenerationRecovery] Failed to recover task ${task.id}:`, error?.message || error);
      }
    }
  }
}

