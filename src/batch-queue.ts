/** Buffers items and flushes them by size or on a timer. */
export class BatchQueue<T> {
  private buffer: T[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(
    private readonly maxBatch: number,
    private readonly intervalMs: number,
    private readonly onFlush: (items: T[]) => void | Promise<void>,
  ) {}

  add(item: T): void {
    this.buffer.push(item);
    if (this.buffer.length >= this.maxBatch) {
      void this.flush();
    } else {
      this.ensureTimer();
    }
  }

  private ensureTimer(): void {
    if (this.timer != null) return;
    this.timer = setInterval(() => void this.flush(), this.intervalMs);
    // Don't keep a Node process alive just for the flush timer.
    (this.timer as { unref?: () => void }).unref?.();
  }

  async flush(): Promise<void> {
    if (this.timer != null) {
      clearInterval(this.timer);
      this.timer = null;
    }
    if (this.buffer.length === 0) return;
    const items = this.buffer;
    this.buffer = [];
    await this.onFlush(items);
  }

  dispose(): void {
    if (this.timer != null) clearInterval(this.timer);
    this.timer = null;
    this.buffer = [];
  }
}
