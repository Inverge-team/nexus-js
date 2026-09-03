import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';

/** Feature flags — evaluate once, then read synchronously. */
export class NexusFlags {
  private flags: Record<string, unknown> = {};
  private payloads: Record<string, unknown> = {};

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {}

  /** Evaluate all flags for the current person + properties and cache them. */
  async load(properties?: Record<string, unknown>): Promise<void> {
    if (!this.id.distinctId) return;
    const res = await this.http.post('/partner/flags/evaluate', {
      distinctId: this.id.distinctId,
      properties: { ...this.cfg.defaultProperties, ...this.id.traits, ...properties },
    });
    const data = (res?.['data'] ?? res) as Record<string, unknown> | undefined;
    if (!data) return;
    this.flags = (data['flags'] as Record<string, unknown>) ?? {};
    this.payloads = (data['payloads'] as Record<string, unknown>) ?? {};
  }

  /** True when a boolean flag is on, or a multivariate flag has any variant. */
  isEnabled(key: string): boolean {
    const v = this.flags[key];
    return v === true || (typeof v === 'string' && v.length > 0);
  }

  /** The variant key for a multivariate flag, or null. */
  variant(key: string): string | null {
    return typeof this.flags[key] === 'string' ? (this.flags[key] as string) : null;
  }

  /** The remote-config payload attached to a flag, if any. */
  payload(key: string): unknown {
    return this.payloads[key];
  }

  get all(): Record<string, unknown> {
    return { ...this.flags };
  }
}
