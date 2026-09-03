import type { ResolvedConfig } from '../config';
import type { NexusIdentity } from '../identity';
import type { NexusHttp } from '../http';
import type { NexusRealtime } from './realtime';
import { platformName } from '../environment';
import { NexusLog } from '../logging';

export const REMOTE_CONFIG_ROOM = '__remote_config';
type ChangeListener = () => void;

/** Firebase-style Remote Config: typed parameters with server-evaluated
 * conditions (platform, version, country, percentile, custom attributes). */
export class NexusRemoteConfig {
  private values: Record<string, unknown> = {};
  private sources: Record<string, string | null> = {};
  private attributes: Record<string, unknown> = {};
  private defaults: Record<string, unknown>;
  private etag: string | null = null;
  private _version = 0;
  private lastFetch: Date | null = null;
  private readonly listeners = new Set<ChangeListener>();
  private realtime: NexusRealtime | null = null;

  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
    private readonly cfg: ResolvedConfig,
  ) {
    this.defaults = { ...cfg.remoteConfigDefaults };
  }

  get version(): number {
    return this._version;
  }
  get lastFetchTime(): Date | null {
    return this.lastFetch;
  }

  /** In-app fallback values, used until/unless the server has a value. */
  setDefaults(defaults: Record<string, unknown>): void {
    this.defaults = { ...this.defaults, ...defaults };
  }

  /** Persistent custom targeting attributes sent with every fetch. */
  setAttributes(attributes: Record<string, unknown>): void {
    Object.assign(this.attributes, attributes);
  }
  setAttribute(key: string, value: unknown): void {
    if (value == null) delete this.attributes[key];
    else this.attributes[key] = value;
  }
  clearAttributes(): void {
    this.attributes = {};
  }

  /** Subscribe to config changes. Returns an unsubscribe function. */
  onChange(listener: ChangeListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Fetch + activate the published template. Returns `true` if values changed. */
  async fetch(attributes?: Record<string, unknown>): Promise<boolean> {
    const res = await this.http.post(
      '/partner/remote-config/fetch',
      this.buildContext(attributes),
      this.etag ? { 'if-none-match': this.etag } : undefined,
    );
    if (!res) return false;
    const body = (res['parameters'] != null || res['notModified'] != null || res['throttled'] != null)
      ? res
      : ((res['data'] as Record<string, unknown>) ?? res);

    if (body['notModified'] === true || body['throttled'] === true) {
      this.lastFetch = new Date();
      return false;
    }
    const params = (body['parameters'] as Record<string, { value: unknown; source: string | null }>) ?? {};
    this.values = {};
    this.sources = {};
    for (const [key, entry] of Object.entries(params)) {
      this.values[key] = entry.value;
      this.sources[key] = entry.source ?? null;
    }
    this.etag = (body['etag'] as string | null) ?? this.etag;
    this._version = (body['version'] as number | undefined) ?? this._version;
    this.lastFetch = new Date();
    NexusLog.debug(`remote-config: fetched v${this._version} (${Object.keys(this.values).length} params)`);
    for (const l of this.listeners) l();
    return true;
  }

  getValue(key: string): unknown {
    return key in this.values ? this.values[key] : this.defaults[key];
  }
  getString(key: string, fallback = ''): string {
    const v = this.getValue(key);
    return v == null ? fallback : typeof v === 'string' ? v : String(v);
  }
  getBool(key: string, fallback = false): boolean {
    const v = this.getValue(key);
    if (typeof v === 'boolean') return v;
    if (typeof v === 'number') return v !== 0;
    if (typeof v === 'string') return v === 'true' || v === '1';
    return fallback;
  }
  getNumber(key: string, fallback = 0): number {
    const v = this.getValue(key);
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = Number(v);
      return Number.isNaN(n) ? fallback : n;
    }
    return fallback;
  }
  getJSON<T = unknown>(key: string, fallback?: T): T {
    return (this.getValue(key) as T) ?? (fallback as T);
  }
  sourceOf(key: string): string | null {
    return this.sources[key] ?? null;
  }
  getAll(): Record<string, unknown> {
    return { ...this.defaults, ...this.values };
  }

  /** Re-fetch automatically when a new template is published (needs realtime). */
  async subscribeRealtime(realtime: NexusRealtime): Promise<void> {
    if (this.realtime) return;
    this.realtime = realtime;
    try {
      await realtime.join(REMOTE_CONFIG_ROOM);
      realtime.on('config_updated', () => {
        NexusLog.debug('remote-config: realtime update — re-fetching');
        void this.fetch();
      });
      NexusLog.info('remote-config: realtime updates on');
    } catch (e) {
      NexusLog.warn(`remote-config: realtime subscribe failed: ${String(e)}`);
    }
  }

  private buildContext(oneShot?: Record<string, unknown>): Record<string, unknown> {
    const dc = this.id.deviceContext;
    return {
      appInstanceId: this.id.deviceKey,
      ...(this.cfg.appVersion ?? dc['appVersion'] ? { appVersion: this.cfg.appVersion ?? dc['appVersion'] } : {}),
      platform: (typeof dc['osType'] === 'string' ? dc['osType'] : platformName()).toLowerCase(),
      ...(typeof dc['osVersion'] === 'string' ? { osVersion: dc['osVersion'] } : {}),
      ...this.locale(),
      userProperties: { ...this.cfg.defaultProperties, ...this.id.traits, ...this.attributes, ...oneShot },
    };
  }

  private locale(): Record<string, unknown> {
    try {
      if (typeof Intl !== 'undefined') {
        const loc = Intl.DateTimeFormat().resolvedOptions().locale; // e.g. "en-US"
        const [language, country] = loc.split('-');
        return { ...(language ? { language } : {}), ...(country ? { country } : {}) };
      }
    } catch {
      /* ignore */
    }
    return {};
  }
}
