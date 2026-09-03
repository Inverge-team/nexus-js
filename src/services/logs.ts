import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import { BatchQueue } from '../batch-queue';

export type LogLevel = 'trace' | 'debug' | 'info' | 'warn' | 'error';
export interface LogOptions {
  source?: string;
  context?: Record<string, unknown>;
}

/** Structured logging — buffered, batched, session-correlated. */
export class NexusLogs {
  private readonly queue: BatchQueue<Record<string, unknown>>;

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {
    this.queue = new BatchQueue(cfg.maxBatch, cfg.flushIntervalMs, (items) => this.send(items));
  }

  trace(message: string, options?: LogOptions): void {
    this.log('trace', message, options);
  }
  debug(message: string, options?: LogOptions): void {
    this.log('debug', message, options);
  }
  info(message: string, options?: LogOptions): void {
    this.log('info', message, options);
  }
  warn(message: string, options?: LogOptions): void {
    this.log('warn', message, options);
  }
  error(message: string, options?: LogOptions): void {
    this.log('error', message, options);
  }

  log(level: LogLevel, message: string, options?: LogOptions): void {
    this.queue.add({
      level,
      message,
      ...(options?.source ? { source: options.source } : {}),
      ...(options?.context ? { context: options.context } : {}),
      timestamp: new Date().toISOString(),
    });
  }

  flush(): Promise<void> {
    return this.queue.flush();
  }

  private async send(logs: Record<string, unknown>[]): Promise<void> {
    await this.http.post('/partner/logs', {
      logs,
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
