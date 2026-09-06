import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface NexusInAppMessage {
  id: string;
  layout: string;
  content: Record<string, unknown>;
  buttons?: unknown[];
  [key: string]: unknown;
}

/**
 * In-app messages — OneSignal-style modals & banners. Messages are composed in
 * the console; this service fetches the ones a user is eligible for (server-
 * driven / headless UIs) and records impressions and clicks.
 */
export class NexusInApp {
  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
  ) {}

  /** The active in-app messages for the tenant. */
  async active(options: { distinctId?: string } = {}): Promise<NexusInAppMessage[]> {
    const res = await this.http.post('/partner/inapp/active', {
      ...(options.distinctId ?? this.id.distinctId ? { distinctId: options.distinctId ?? this.id.distinctId } : {}),
      deviceKey: this.id.deviceKey,
    });
    const data = (res?.['data'] ?? res) as Record<string, unknown> | undefined;
    return (data?.['messages'] as NexusInAppMessage[] | undefined) ?? [];
  }

  /** Record an in-app message event: `impression`, `click`, or `dismiss`. */
  async trackEvent(
    messageId: string,
    type: 'impression' | 'click' | 'dismiss',
    options: { buttonId?: string; distinctId?: string } = {},
  ): Promise<void> {
    await this.http.post('/partner/inapp/event', {
      messageId,
      type,
      ...(options.buttonId ? { buttonId: options.buttonId } : {}),
      ...(options.distinctId ?? this.id.distinctId ? { distinctId: options.distinctId ?? this.id.distinctId } : {}),
    });
  }

  impression(messageId: string, options: { distinctId?: string } = {}): Promise<void> {
    return this.trackEvent(messageId, 'impression', options);
  }
  click(messageId: string, buttonId: string, options: { distinctId?: string } = {}): Promise<void> {
    return this.trackEvent(messageId, 'click', { ...options, buttonId });
  }
  dismiss(messageId: string, options: { distinctId?: string } = {}): Promise<void> {
    return this.trackEvent(messageId, 'dismiss', options);
  }
}
