import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import { isBrowser, isNode } from '../environment';
import { NexusLog } from '../logging';

export interface CaptureOptions {
  handled?: boolean;
  level?: 'error' | 'warning' | 'fatal';
  fingerprint?: string;
  context?: Record<string, unknown>;
}

/** Error & crash monitoring. `install()` reports uncaught errors automatically
 * (browser `error`/`unhandledrejection`, Node `uncaughtException`/`unhandledRejection`). */
export class NexusErrors {
  private installed = false;

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {}

  /** Report an error (handled by default). */
  async capture(error: unknown, options: CaptureOptions = {}): Promise<void> {
    const err = error instanceof Error ? error : new Error(String(error));
    await this.http.post('/partner/errors', {
      type: err.name || 'Error',
      message: err.message || String(error),
      stack: err.stack ?? null,
      handled: options.handled ?? true,
      level: options.level ?? 'error',
      ...(options.fingerprint ? { fingerprint: options.fingerprint } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(this.cfg.appVersion ? { appVersion: this.cfg.appVersion } : {}),
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      sessionKey: this.id.sessionKey,
      deviceKey: this.id.deviceKey,
      ...this.id.wireContext,
    });
  }

  /** Auto-install global handlers for uncaught errors. Idempotent. */
  install(): void {
    if (this.installed) return;
    this.installed = true;
    if (isBrowser) {
      window.addEventListener('error', (e: ErrorEvent) => {
        void this.capture(e.error ?? e.message, { handled: false });
      });
      window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
        void this.capture(e.reason, { handled: false });
      });
    } else if (isNode) {
      process.on('uncaughtException', (err) => {
        void this.capture(err, { handled: false, level: 'fatal' });
      });
      process.on('unhandledRejection', (reason) => {
        void this.capture(reason, { handled: false });
      });
    }
    NexusLog.debug('automatic error capture installed');
  }
}
