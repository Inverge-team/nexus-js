import type { ResolvedConfig } from './config';
import type { NexusIdentity } from './identity';
import { NexusLog } from './logging';

/** Thin JSON transport over the `/partner/*` endpoints. Never throws. */
export class NexusHttp {
  constructor(
    private readonly config: ResolvedConfig,
    private readonly identity: NexusIdentity,
  ) {}

  private headers(extra?: Record<string, string>): Record<string, string> {
    const os = this.identity.deviceContext['osType'];
    const osVersion = this.identity.deviceContext['osVersion'];
    return {
      'content-type': 'application/json',
      'x-api-key': this.config.apiKey,
      ...(typeof os === 'string' ? { 'x-client-os': os } : {}),
      ...(typeof osVersion === 'string' ? { 'x-client-os-version': osVersion } : {}),
      ...extra,
    };
  }

  /** POST JSON to a `/partner/...` path. Returns the decoded body or null. */
  async post(
    path: string,
    body: Record<string, unknown>,
    extraHeaders?: Record<string, string>,
  ): Promise<Record<string, unknown> | null> {
    const url = `${this.config.httpBase}${path}`;
    try {
      const res = await this.config.fetch(url, {
        method: 'POST',
        headers: this.headers(extraHeaders),
        body: JSON.stringify(body),
      });
      if (res.ok) {
        NexusLog.debug(`← ${res.status} POST ${path}`);
        const text = await res.text();
        if (!text) return {};
        const decoded = JSON.parse(text);
        return typeof decoded === 'object' && decoded !== null ? decoded : { data: decoded };
      }
      NexusLog.warn(`← ${res.status} POST ${path}`);
      return null;
    } catch (e) {
      NexusLog.error(`POST ${path} failed`, e);
      return null;
    }
  }
}
