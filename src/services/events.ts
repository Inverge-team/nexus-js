import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import { BatchQueue } from '../batch-queue';

/** Product analytics — buffered, batched, session-correlated. */
export class NexusEvents {
  private readonly queue: BatchQueue<Record<string, unknown>>;
  /** Notified with each tracked event name (used for survey triggers). */
  onTracked?: (name: string) => void;

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {
    this.queue = new BatchQueue(cfg.maxBatch, cfg.flushIntervalMs, (items) => this.send(items));
  }

  /** Track a named event with optional properties. */
  track(name: string, properties?: Record<string, unknown>): void {
    if (!this.cfg.services.events) return; // switched off — don't even buffer
    this.onTracked?.(name);
    this.queue.add({
      name,
      properties: { ...this.cfg.defaultProperties, ...properties },
      timestamp: new Date().toISOString(),
    });
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  private async send(events: Record<string, unknown>[]): Promise<void> {
    await this.http.post('/partner/events', {
      events,
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      sessionKey: this.id.sessionKey,
      deviceKey: this.id.deviceKey,
      ...(this.cfg.appVersion ? { appVersion: this.cfg.appVersion } : {}),
      ...this.id.wireContext,
    });
  }

  dispose(): void {
    this.queue.dispose();
  }
}
