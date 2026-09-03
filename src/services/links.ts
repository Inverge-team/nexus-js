import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import { isBrowser } from '../environment';

export interface AttributeOptions {
  type?: string;
  clickId?: string;
  name?: string;
  platform?: string;
  properties?: Record<string, unknown>;
}

/** Deep linking & attribution (OneLink-style). */
export class NexusLinks {
  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
  ) {}

  /** Report a conversion; returns the matched link's deep-link data (or null). */
  async attribute(options: AttributeOptions = {}): Promise<Record<string, unknown> | null> {
    const res = await this.http.post('/partner/links/attribute', {
      type: options.type ?? 'open',
      ...(options.clickId ? { clickId: options.clickId } : {}),
      ...(options.name ? { name: options.name } : {}),
      ...(options.platform ? { platform: options.platform } : {}),
      ...(this.id.distinctId ? { distinctId: this.id.distinctId } : {}),
      deviceId: this.id.deviceKey,
      sessionKey: this.id.sessionKey,
      ...(options.properties ? { properties: options.properties } : {}),
    });
    const data = (res?.['data'] ?? res) as Record<string, unknown> | undefined;
    return (data?.['link'] as Record<string, unknown> | undefined) ?? null;
  }

  /** Parse the current URL (browser) for `link_click_id` and attribute an open. */
  async handleCurrentUrl(type = 'open'): Promise<Record<string, unknown> | null> {
    if (!isBrowser) return null;
    const clickId = new URLSearchParams(window.location.search).get('link_click_id') ?? undefined;
    return this.attribute({ type, clickId });
  }
}
