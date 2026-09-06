import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface PushSendResult {
  sent: number;
  failed: number;
  recipients?: number;
}

export interface PushActionButton {
  id: string;
  text: string;
  action?: 'dismiss' | 'url' | 'event';
  url?: string;
  event?: string;
  icon?: string;
  style?: string;
}

/** Rich per-platform options — same fields as the console composer. */
export interface PushOptions {
  buttons?: PushActionButton[];
  androidLargeIcon?: string;
  androidBigPicture?: string;
  androidSmallIcon?: string;
  androidVisibility?: 'public' | 'private' | 'secret';
  androidAccentColor?: string;
  iosBadge?: number;
  iosRelevanceScore?: number;
  iosInterruptionLevel?: 'passive' | 'active' | 'time-sensitive' | 'critical';
  iosSubtitle?: string;
  webIcon?: string;
  webImage?: string;
  webBadge?: string;
  [key: string]: unknown;
}

export interface PushMessage {
  title: string;
  body?: string;
  imageUrl?: string;
  data?: Record<string, unknown>;
  options?: PushOptions;
}

const drop = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * Push notifications. Send transactional push to users or segments; campaigns,
 * provider credentials, segments and templates are managed in the console.
 *
 * Prefer the fluent builder:
 * `nexus.push.notification().title('…').setSegments(['vip']).send()`.
 */
export class NexusPush {
  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
  ) {}

  /** Start a fluent push notification. */
  notification(): NexusPushBuilder {
    return new NexusPushBuilder(this.http);
  }

  /** Send a plain notification to specific users (by distinctId). */
  send(distinctIds: string[], message: PushMessage): Promise<PushSendResult> {
    return this.sendRaw(drop({ distinctIds, ...message }));
  }

  sendToUser(distinctId: string, message: PushMessage): Promise<PushSendResult> {
    return this.send([distinctId], message);
  }

  /** Send a fully-assembled payload (title + targeting). Used by the builder. */
  async sendRaw(payload: Record<string, unknown>): Promise<PushSendResult> {
    const res = await this.http.post('/partner/push/send', payload);
    return (res as PushSendResult | null) ?? { sent: 0, failed: 0 };
  }

  /** Register (or refresh) a device token. Normally the client SDK does this. */
  async registerToken(
    token: string,
    platform: 'ios' | 'android' | 'web',
    options: {
      provider?: string;
      distinctId?: string;
      deviceKey?: string;
      appVersion?: string;
      osType?: string;
      osVersion?: string;
      lang?: string;
      tags?: Record<string, string>;
    } = {},
  ): Promise<void> {
    await this.http.post(
      '/partner/push/register',
      drop({
        token,
        platform,
        provider: options.provider ?? (platform === 'web' ? 'webpush' : 'fcm'),
        distinctId: options.distinctId ?? this.id.distinctId,
        deviceKey: options.deviceKey ?? this.id.deviceKey,
        appVersion: options.appVersion,
        osType: options.osType,
        osVersion: options.osVersion,
        lang: options.lang,
        tags: options.tags,
      }),
    );
  }

  async unregister(token: string): Promise<void> {
    await this.http.post('/partner/push/unregister', { token });
  }
}

/** Fluent builder for a transactional push. */
export class NexusPushBuilder {
  private _title?: string;
  private _body?: string;
  private _imageUrl?: string;
  private _data: Record<string, unknown> = {};
  private _options: PushOptions = {};
  private _distinctIds: string[] = [];
  private _segmentIds: string[] = [];
  private _filter: Record<string, unknown> = {};
  private _all = false;

  constructor(private readonly http: NexusHttp) {}

  // ---- content ----
  title(v: string): this {
    this._title = v;
    return this;
  }
  body(v: string): this {
    this._body = v;
    return this;
  }
  image(url: string): this {
    this._imageUrl = url;
    return this;
  }
  data(data: Record<string, unknown>): this {
    this._data = { ...this._data, ...data };
    return this;
  }

  // ---- options ----
  button(id: string, text: string, opts: Omit<PushActionButton, 'id' | 'text'> = {}): this {
    (this._options.buttons ??= []).push(drop({ id, text, action: opts.url ? 'url' : opts.event ? 'event' : 'dismiss', ...opts }) as unknown as PushActionButton);
    return this;
  }
  iosBadge(count: number): this {
    return this.option('iosBadge', count);
  }
  iosInterruptionLevel(level: PushOptions['iosInterruptionLevel']): this {
    return this.option('iosInterruptionLevel', level);
  }
  androidVisibility(v: PushOptions['androidVisibility']): this {
    return this.option('androidVisibility', v);
  }
  androidLargeIcon(url: string): this {
    return this.option('androidLargeIcon', url);
  }
  androidBigPicture(url: string): this {
    return this.option('androidBigPicture', url);
  }
  /** Set any option field directly. */
  option(key: string, value: unknown): this {
    (this._options as Record<string, unknown>)[key] = value;
    return this;
  }
  options(options: PushOptions): this {
    this._options = { ...this._options, ...options };
    return this;
  }

  // ---- targeting ----
  toUsers(distinctIds: string[]): this {
    this._distinctIds = [...new Set([...this._distinctIds, ...distinctIds])];
    return this;
  }
  toUser(distinctId: string): this {
    return this.toUsers([distinctId]);
  }
  /** Target saved segments (union). `toSegments` is an alias. */
  setSegments(segmentIds: string[]): this {
    this._segmentIds = [...new Set([...this._segmentIds, ...segmentIds])];
    return this;
  }
  toSegments(segmentIds: string[]): this {
    return this.setSegments(segmentIds);
  }
  toSegment(segmentId: string): this {
    return this.setSegments([segmentId]);
  }
  /** Ad-hoc device filter (platform, lang, osType, appVersion, lastSeenDays, tags). */
  where(filter: Record<string, unknown>): this {
    this._filter = { ...this._filter, ...filter };
    return this;
  }
  /** Everyone (overrides other targets). */
  toAll(): this {
    this._all = true;
    return this;
  }

  /** Deliver the notification. */
  async send(): Promise<PushSendResult> {
    if (!this._title) throw new Error('A push notification requires a title.');
    if (!this._all && this._distinctIds.length === 0 && this._segmentIds.length === 0 && Object.keys(this._filter).length === 0) {
      throw new Error('A push notification requires a target: toUsers(), setSegments(), where(), or toAll().');
    }
    const res = await this.http.post(
      '/partner/push/send',
      drop({
        title: this._title,
        body: this._body,
        imageUrl: this._imageUrl,
        data: Object.keys(this._data).length ? this._data : undefined,
        options: Object.keys(this._options).length ? this._options : undefined,
        distinctIds: this._distinctIds.length ? this._distinctIds : undefined,
        segmentIds: this._segmentIds.length ? this._segmentIds : undefined,
        filter: Object.keys(this._filter).length ? this._filter : undefined,
        all: this._all || undefined,
      }),
    );
    return (res as PushSendResult | null) ?? { sent: 0, failed: 0 };
  }
}
