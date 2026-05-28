import { projectStore } from '../storage/project-store.js';
import { generationTaskStore } from '../storage/generation-task-store.js';
import { referenceLibraryStore } from '../storage/reference-library-store.js';
import { ManualGenerationService } from './manual-generation.service.js';
import { isPromptModerationError } from './video-generation.service.js';
import type { GenerationTask } from '../domain/generation-task.js';
import type { ReferenceLibraryItem } from '../domain/reference-library.js';

interface ReferenceQueueState {
  latestTask?: GenerationTask;
  hasCompleted: boolean;
  failedAttempts: number;
}

interface GenerationReferenceCandidate {
  item: ReferenceLibraryItem;
  state?: ReferenceQueueState;
}

function toPositiveNumber(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function calculateDailyRemixLimit(dailyLimit: number, remixPercentage: number): number {
  const normalizedDailyLimit = Math.max(0, Math.floor(dailyLimit));
  const normalizedPercentage = Math.max(0, Math.min(100, Math.floor(remixPercentage)));
  if (!normalizedDailyLimit || !normalizedPercentage) {
    return 0;
  }

  const calculated = Math.floor((normalizedDailyLimit * normalizedPercentage) / 100);
  return Math.min(normalizedDailyLimit, Math.max(1, calculated));
}

export class AutoGenerationService {
  private static interval: NodeJS.Timeout | null = null;
  private static isRunning = false;
  private static readonly failedRetryBaseMs = toPositiveNumber(
    process.env.AUTO_GENERATION_FAILED_RETRY_BASE_MINUTES,
    60
  ) * 60 * 1000;
  private static readonly failedRetryMaxMs = toPositiveNumber(
    process.env.AUTO_GENERATION_FAILED_RETRY_MAX_MINUTES,
    12 * 60
  ) * 60 * 1000;
  private static readonly recentReferenceWindow = Math.max(
    1,
    toPositiveNumber(process.env.AUTO_GENERATION_RECENT_REFERENCE_WINDOW, 2)
  );
  private static readonly concurrencyPerProject = Math.max(
    1,
    Math.floor(toPositiveNumber(process.env.AUTO_GENERATION_CONCURRENCY_PER_PROJECT, 1))
  );

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

    const packageLimit = Math.max(0, Math.floor(project.packageVideoLimit || 0));
    if (packageLimit) {
      const packageUsage = await generationTaskStore.getPackageUsage(projectId);
      if (packageUsage.billableTotal >= packageLimit) {
        await projectStore.updateProject(projectId, {
          automationEnabled: false,
          isActive: false,
        });
        console.log(
          `[AutoGenerationService] Project ${project.name}: package limit reached (${packageUsage.completed}/${packageLimit}, reserved=${packageUsage.reserved}). Project paused.`
        );
        return;
      }
    }

    console.log(
      `[AutoGenerationService] Project ${project.name}: limit not reached (${tasksToday}/${project.dailyGenerationLimit}). Processing auto queue...`
    );

    const remixDailyLimit = calculateDailyRemixLimit(project.dailyGenerationLimit, project.viralReusePercentage);
    const remixTasksToday = await generationTaskStore.countAutoRemixTasksForDate(projectId, today);
    const shouldRemix = remixTasksToday < remixDailyLimit;

    if (shouldRemix) {
      console.log(
        `[AutoGenerationService] Project ${project.name}: remix quota not reached (${remixTasksToday}/${remixDailyLimit}). Trying VIRAL REMIX.`
      );
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
    const taskStateByReference = this.getTaskStateByReference(projectTasks);
    const candidates = this.getGenerationReferenceCandidates(libraryItems, taskStateByReference);

    if (!candidates.length) {
      console.log(`[AutoGenerationService] Project ${project.name}: No successful analyzed library items available for auto generation.`);
      return;
    }

    let tasksToday = initialTasksToday;
    let attemptsThisTick = 0;
    const recentReferenceIds: string[] = [];
    const maxAttemptsThisTick = Math.max(
      1,
      Math.min(
        project.dailyGenerationLimit,
        toPositiveNumber(process.env.AUTO_GENERATION_MAX_ATTEMPTS_PER_PROJECT_TICK, project.dailyGenerationLimit)
      )
    );
    const maxConcurrentTasks = Math.max(
      1,
      Math.min(project.dailyGenerationLimit, this.concurrencyPerProject)
    );
    const inFlight: Promise<void>[] = [];
    let shouldStopLaunching = false;

    const waitForRunningTasks = async () => {
      if (inFlight.length) {
        await Promise.allSettled([...inFlight]);
      }
    };

    while (candidates.length || inFlight.length) {
      while (!shouldStopLaunching && candidates.length && inFlight.length < maxConcurrentTasks) {
        tasksToday = await generationTaskStore.countTasksForDate(projectId, today);
        if (tasksToday + inFlight.length >= project.dailyGenerationLimit) {
          console.log(
            `[AutoGenerationService] Project ${project.name}: daily limit reached/reserved (${tasksToday}+${inFlight.length}/${project.dailyGenerationLimit}). Queue paused.`
          );
          shouldStopLaunching = true;
          await waitForRunningTasks();
          return;
        }

        const packageLimit = Math.max(0, Math.floor(project.packageVideoLimit || 0));
        if (packageLimit) {
          const packageUsage = await generationTaskStore.getPackageUsage(projectId);
          if (packageUsage.billableTotal + inFlight.length >= packageLimit) {
            await projectStore.updateProject(projectId, {
              automationEnabled: false,
              isActive: false,
            });
            console.log(
              `[AutoGenerationService] Project ${project.name}: package limit reached/reserved (${packageUsage.completed}/${packageLimit}, reserved=${packageUsage.reserved}+${inFlight.length}). Queue paused.`
            );
            shouldStopLaunching = true;
            await waitForRunningTasks();
            return;
          }
        }

        if (attemptsThisTick >= maxAttemptsThisTick) {
          console.log(
            `[AutoGenerationService] Project ${project.name}: attempt limit reached for this tick (${attemptsThisTick}/${maxAttemptsThisTick}). Queue will continue on the next tick.`
          );
          shouldStopLaunching = true;
          break;
        }

        const candidateIndex = this.pickCandidateIndex(candidates, recentReferenceIds);
        const [entry] = candidates.splice(candidateIndex, 1);
        if (!entry) {
          break;
        }
        const item = entry.item;

        console.log(
          `[AutoGenerationService] Project ${project.name}: auto-generating library item ${item.id} (${tasksToday}/${project.dailyGenerationLimit}, concurrency=${inFlight.length + 1}/${maxConcurrentTasks}).`
        );
        attemptsThisTick += 1;

        let taskPromise: Promise<void>;
        taskPromise = (async () => {
          try {
            await ManualGenerationService.runFromLibraryItem({
              projectId: project.id,
              referenceLibraryItemId: item.id,
              triggerMode: 'auto',
              skipProviderModerationRewrite: true,
            });
            recentReferenceIds.push(item.id);
            while (recentReferenceIds.length > this.recentReferenceWindow) {
              recentReferenceIds.shift();
            }
          } catch (err: any) {
            console.error(
              `[AutoGenerationService] Project ${project.name}: failed to auto-generate library item ${item.id}:`,
              err.message
            );

            if (String(err?.message || '').includes('Project package limit reached')) {
              shouldStopLaunching = true;
              return;
            }

            if (isPromptModerationError(err)) {
              console.warn(
                `[AutoGenerationService] Project ${project.name}: reference ${item.id} is blocked by moderation. Skipping it for this tick and trying another project reference.`
              );
              return;
            }

            if (this.shouldPauseProjectAfterFailure(err)) {
              console.warn(
                `[AutoGenerationService] Project ${project.name}: provider looks unstable. Pausing this project until the next scheduler tick.`
              );
              shouldStopLaunching = true;
            }
          }
        })().finally(() => {
          const index = inFlight.indexOf(taskPromise);
          if (index >= 0) {
            inFlight.splice(index, 1);
          }
        });

        inFlight.push(taskPromise);
      }

      if (inFlight.length) {
        await Promise.race([...inFlight]);
        continue;
      }

      if (shouldStopLaunching) {
        return;
      }
    }
  }

  private static pickCandidateIndex(
    candidates: GenerationReferenceCandidate[],
    recentReferenceIds: string[]
  ): number {
    const allowedIndexes = candidates
      .map((candidate, index) => recentReferenceIds.includes(candidate.item.id) ? -1 : index)
      .filter((index) => index >= 0);

    const sourceIndexes = allowedIndexes.length ? allowedIndexes : candidates.map((_, index) => index);
    return sourceIndexes[Math.floor(Math.random() * sourceIndexes.length)] ?? 0;
  }

  private static getTaskStateByReference(tasks: GenerationTask[]): Map<string, ReferenceQueueState> {
    const taskStateByReference = new Map<string, ReferenceQueueState>();

    for (const task of tasks) {
      const current = taskStateByReference.get(task.referenceLibraryItemId) || {
        hasCompleted: false,
        failedAttempts: 0,
      };

      if (!current.latestTask) {
        current.latestTask = task;
      }

      if (task.status === 'completed') {
        current.hasCompleted = true;
      }

      if (task.status === 'failed') {
        current.failedAttempts += 1;
      }

      taskStateByReference.set(task.referenceLibraryItemId, current);
    }

    return taskStateByReference;
  }

  private static getGenerationReferenceCandidates(
    libraryItems: ReferenceLibraryItem[],
    taskStateByReference: Map<string, ReferenceQueueState>
  ): GenerationReferenceCandidate[] {
    const now = Date.now();

    return libraryItems
      .map((item): GenerationReferenceCandidate | null => {
        if (item.status !== 'analyzed' || !item.analysis) {
          return null;
        }

        if (!item.directVideoUrl && !item.analysis) {
          return null;
        }

        const state = taskStateByReference.get(item.id);
        if (!state?.hasCompleted) {
          return null;
        }

        const latestTask = state?.latestTask;
        if (latestTask?.status === 'pending' || latestTask?.status === 'processing') {
          return null;
        }

        if (latestTask?.status === 'failed') {
          const retryAt = this.getRetryAt(latestTask, state.failedAttempts || 1);
          if (retryAt > now) {
            return null;
          }
        }

        return {
          item,
          state,
        };
      })
      .filter((entry): entry is GenerationReferenceCandidate => Boolean(entry));
  }

  private static getRetryAt(task: GenerationTask, failedAttempts: number): number {
    const failedAt = Date.parse(task.finishedAt || task.updatedAt || task.createdAt) || Date.now();
    const multiplier = Math.pow(2, Math.max(0, failedAttempts - 1));
    const retryDelay = Math.min(this.failedRetryBaseMs * multiplier, this.failedRetryMaxMs);
    return failedAt + retryDelay;
  }

  private static shouldPauseProjectAfterFailure(error: unknown): boolean {
    if (isPromptModerationError(error)) {
      return false;
    }

    const message = String((error as any)?.message || error || '').toLowerCase();
    return (
      message.includes('internal error') ||
      message.includes('please try again later') ||
      message.includes('task id is blank') ||
      message.includes('timed out') ||
      message.includes('timeout') ||
      message.includes('rate limit') ||
      message.includes('429') ||
      message.includes('502') ||
      message.includes('503') ||
      message.includes('504')
    );
  }
}
