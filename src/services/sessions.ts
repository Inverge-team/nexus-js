import type { ResolvedConfig } from '../config';
import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface IdentifyOptions {
  email?: string;
  name?: string;
  traits?: Record<string, unknown>;
}

/** The sessions spine — names the end-user and starts/refreshes the journey. */
export class NexusSessions {
  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {}

  /** Identify the current end-user; all later telemetry is attributed to it. */
  async identify(distinctId: string, options: IdentifyOptions = {}): Promise<void> {
    this.id.distinctId = distinctId;
    if (options.traits) Object.assign(this.id.traits, options.traits);
    await this.http.post('/partner/sessions/identify', {
      distinctId,
      ...(options.email ? { email: options.email } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.traits ? { traits: options.traits } : {}),
    });
    await this.track();
  }

  /** Start/refresh the active session; returns the server session id. */
  async track(context?: Record<string, unknown>): Promise<string | null> {
    const res = await this.http.post('/partner/sessions/track', {
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      deviceKey: this.id.deviceKey,
      sessionKey: this.id.sessionKey,
      ...(this.cfg.appVersion ? { appVersion: this.cfg.appVersion } : {}),
      ...this.id.wireContext,
      ...context,
    });
    const data = (res?.['data'] ?? res) as Record<string, unknown> | undefined;
    return (data?.['sessionId'] as string | undefined) ?? null;
  }

  /** Forget the user (e.g. on logout) and start a fresh session. */
  reset(): void {
    this.id.reset();
  }
}
