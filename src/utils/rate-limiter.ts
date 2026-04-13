/**
 * A simple sliding-window rate limiter to control asynchronous task execution.
 */
export class RateLimiter {
  private queue: (() => Promise<void>)[] = [];
  private requestTimestamps: number[] = [];
  private processing = false;

  constructor(
    private maxRequests: number,
    private windowMs: number
  ) {}

  /**
   * Schedules a task to be executed within rate limits.
   * @param task A function that returns a Promise.
   */
  public async schedule<T>(task: () => Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      this.queue.push(async () => {
        try {
          const result = await task();
          resolve(result);
        } catch (error) {
          reject(error);
        }
      });
      this.processQueue();
    });
  }

  private async processQueue(): Promise<void> {
    if (this.processing || this.queue.length === 0) return;
    this.processing = true;

    while (this.queue.length > 0) {
      const now = Date.now();
      
      // Remove timestamps outside the current window
      this.requestTimestamps = this.requestTimestamps.filter(
        (ts) => now - ts < this.windowMs
      );

      if (this.requestTimestamps.length < this.maxRequests) {
        const task = this.queue.shift();
        if (task) {
          this.requestTimestamps.push(now);
          // Run task without awaiting to allow parallel execution up to limit
          task().catch(() => {}); 
        }
      } else {
        // Wait until the oldest request falls out of the window
        const oldestTimestamp = this.requestTimestamps[0];
        const waitTime = this.windowMs - (now - oldestTimestamp) + 10; // Extra 10ms buffer
        await new Promise((resolve) => setTimeout(resolve, waitTime));
      }
    }

    this.processing = false;
  }
}
