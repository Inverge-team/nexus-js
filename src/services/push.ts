import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface PushSendResult {
  sent: number;
  failed: number;
  recipients?: number;
}

/** What a send with `sendAt` returns, and what `scheduled()` / `cancelScheduled()` report. */
export interface PushScheduledSend {
  id: string;
  status: 'scheduled' | 'sending' | 'sent' | 'failed' | 'canceled';
  /** ISO-8601. */
  scheduledAt: string;
  sentAt: string | null;
  /** Filled in once it has been sent. */
  recipients: number;
  sent: number;
  failed: number;
}

/** When to deliver: a `Date`, epoch milliseconds, or an ISO-8601 string with an offset. */
export type PushSendAt = Date | number | string;

/** The `sendAt` wire value — always an absolute instant, so the server never guesses a timezone. */
function sendAtValue(at: PushSendAt): string {
  if (typeof at === 'string') {
    if (!/(Z|[+-]\d{2}:?\d{2})$/i.test(at.trim())) {
      throw new Error(`sendAt needs a timezone offset (e.g. "2026-11-07T09:00:00Z"): ${at}`);
    }
    return at.trim();
  }
  const d = typeof at === 'number' ? new Date(at) : at;
  if (Number.isNaN(d.getTime())) throw new Error('sendAt is not a valid date.');
  return d.toISOString();
}

/** Keep the non-empty translations, keyed by trimmed language code. */
function translations(map: PushTranslations): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [lang, text] of Object.entries(map)) {
    if (lang.trim() && typeof text === 'string' && text.trim()) out[lang.trim()] = text;
  }
  return out;
}

/** Laravel-style truthiness for `when()`: null/undefined/false/0/''/[] are falsy. */
function truthy(v: unknown): boolean {
  return Array.isArray(v) ? v.length > 0 : Boolean(v);
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

/** Text per language code, e.g. `{ en: 'Your order shipped', ar: 'تم شحن طلبك' }`. */
export type PushTranslations = Record<string, string | null | undefined>;

export interface PushMessage {
  /** A string, or one per language. */
  title: string | PushTranslations;
  /** A string, or one per language. */
  body?: string | PushTranslations;
  /** The language a device gets when its own has no translation. */
  defaultLanguage?: string;
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
    return this.sendRaw(this.messagePayload(distinctIds, message));
  }

  /** Built by the builder, so per-language titles/bodies expand the same way. */
  private messagePayload(distinctIds: string[], message: PushMessage): Record<string, unknown> {
    const b = this.notification()
      .title(message.title)
      .body(message.body)
      .image(message.imageUrl)
      .data(message.data)
      .defaultLanguage(message.defaultLanguage);
    if (message.options) b.options(message.options);
    return { distinctIds, ...b.toJSON() };
  }

  sendToUser(distinctId: string, message: PushMessage): Promise<PushSendResult> {
    return this.send([distinctId], message);
  }

  /**
   * Deliver a notification to specific users later. Resolves to the scheduled
   * send — keep its `id` to check on it or cancel it. Null when push is
   * switched off or the request failed.
   */
  schedule(distinctIds: string[], message: PushMessage, sendAt: PushSendAt): Promise<PushScheduledSend | null> {
    return this.scheduleRaw({ ...this.messagePayload(distinctIds, message), sendAt: sendAtValue(sendAt) });
  }

  /** Send a fully-assembled payload (title + targeting). Used by the builder. */
  async sendRaw(payload: Record<string, unknown>): Promise<PushSendResult> {
    const res = await this.http.post('/partner/push/send', payload);
    return (res as PushSendResult | null) ?? { sent: 0, failed: 0 };
  }

  /** Schedule a fully-assembled payload that carries `sendAt`. Used by the builder. */
  async scheduleRaw(payload: Record<string, unknown>): Promise<PushScheduledSend | null> {
    return ((await this.http.post('/partner/push/send', payload)) as PushScheduledSend | null) ?? null;
  }

  /** A scheduled send's status, and its outcome once it has fired. Null if unknown. */
  async scheduled(id: string): Promise<PushScheduledSend | null> {
    return ((await this.http.get(`/partner/push/scheduled/${encodeURIComponent(id)}`)) as PushScheduledSend | null) ?? null;
  }

  /**
   * Cancel a scheduled send before it fires. Resolves to the canceled send, or
   * null if it is unknown or already went out.
   */
  async cancelScheduled(id: string): Promise<PushScheduledSend | null> {
    return ((await this.http.post(`/partner/push/scheduled/${encodeURIComponent(id)}/cancel`, {})) as PushScheduledSend | null) ?? null;
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
  private _titles: Record<string, string> = {};
  private _bodies: Record<string, string> = {};
  private _defaultLanguage?: string;
  private _imageUrl?: string;
  private _data: Record<string, unknown> = {};
  private _options: PushOptions = {};
  private _distinctIds: string[] = [];
  private _segmentIds: string[] = [];
  private _filter: Record<string, unknown> = {};
  private _all = false;

  private _sendAt?: string;
  private _name?: string;

  constructor(private readonly http: NexusHttp) {}

  // ---- content ----
  /**
   * The title — a string, or one per language: `{ en: 'Your order shipped', ar: 'تم شحن طلبك' }`.
   * Each device gets its language's; an empty or missing translation falls back
   * to the default language (see {@link defaultLanguage}).
   */
  title(v: string | PushTranslations): this {
    if (typeof v === 'string') {
      this._title = v;
      this._titles = {};
    } else {
      this._titles = translations(v);
      this._title = undefined;
    }
    return this;
  }
  /** The body — a string or one per language. `null` / `''` leaves it unset. */
  body(v: string | PushTranslations | null | undefined): this {
    if (v !== null && typeof v === 'object') {
      this._bodies = translations(v);
      this._body = undefined;
    } else {
      this._body = v || undefined;
      this._bodies = {};
    }
    return this;
  }
  /**
   * The language a device gets when its own has no translation. Defaults to
   * `en` when there is one, else the first language given.
   */
  defaultLanguage(lang: string | null | undefined): this {
    this._defaultLanguage = lang?.trim() || undefined;
    return this;
  }
  /** `null` / `''` leaves the image unset. */
  image(url: string | null | undefined): this {
    this._imageUrl = url || undefined;
    return this;
  }
  data(data: Record<string, unknown> | null | undefined): this {
    this._data = { ...this._data, ...(data ?? {}) };
    return this;
  }

  // ---- conditionals ----
  /**
   * Apply `callback` only when `value` is truthy — Laravel's `when()`. Otherwise
   * `otherwise` runs, if given. `value` may be a function of the builder,
   * evaluated now; the callbacks receive the builder and that value. Falsy:
   * `null`, `undefined`, `false`, `0`, `''` and an empty array.
   *
   * ```ts
   * nexus.push.notification()
   *   .title(title)
   *   .when(image, (p, url) => p.image(url))
   *   .when(ids.length === 0, (p) => p.toSegment('All Clients'), (p) => p.toUsers(ids))
   *   .send();
   * ```
   */
  when<V>(
    value: V | ((builder: this) => V),
    callback: (builder: this, value: V) => unknown,
    otherwise?: (builder: this, value: V) => unknown,
  ): this {
    const v = typeof value === 'function' ? (value as (b: this) => V)(this) : value;
    if (truthy(v)) callback(this, v);
    else otherwise?.(this, v);
    return this;
  }
  /** The inverse of {@link when}: apply `callback` only when `value` is falsy. */
  unless<V>(
    value: V | ((builder: this) => V),
    callback: (builder: this, value: V) => unknown,
    otherwise?: (builder: this, value: V) => unknown,
  ): this {
    const v = typeof value === 'function' ? (value as (b: this) => V)(this) : value;
    if (!truthy(v)) callback(this, v);
    else otherwise?.(this, v);
    return this;
  }

  // ---- scheduling ----
  /**
   * Deliver at this time instead of now (up to a year ahead; a past time goes
   * out within a minute). `send()` then resolves to the scheduled send.
   * `null` clears it, so `.sendAt(maybeDate)` sends now when there is none.
   */
  sendAt(at: PushSendAt | null | undefined): this {
    this._sendAt = at === null || at === undefined || at === '' ? undefined : sendAtValue(at);
    return this;
  }
  /** Label shown for a scheduled send in the console. */
  name(label: string | null | undefined): this {
    this._name = label || undefined;
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
  /** Empty ids are ignored, so `toUsers([])` adds no target. */
  toUsers(distinctIds: string[]): this {
    this._distinctIds = [...new Set([...this._distinctIds, ...distinctIds.filter(Boolean)])];
    return this;
  }
  toUser(distinctId: string): this {
    return this.toUsers([distinctId]);
  }
  /** Target saved segments (union). `toSegments` is an alias. Empty ids are ignored. */
  setSegments(segmentIds: string[]): this {
    this._segmentIds = [...new Set([...this._segmentIds, ...segmentIds.filter(Boolean)])];
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

  /**
   * Deliver the notification — or, with {@link sendAt}, schedule it and resolve
   * to the scheduled send (which has an `id`; `sent`/`failed` fill in once it fires).
   */
  async send(): Promise<PushSendResult | PushScheduledSend> {
    if (!this.toJSON().title) throw new Error('A push notification requires a title.');
    if (!this._all && this._distinctIds.length === 0 && this._segmentIds.length === 0 && Object.keys(this._filter).length === 0) {
      throw new Error('A push notification requires a target: toUsers(), setSegments(), where(), or toAll().');
    }
    const res = await this.http.post('/partner/push/send', this.toJSON());
    return (res as PushSendResult | PushScheduledSend | null) ?? { sent: 0, failed: 0 };
  }

  /**
   * Schedule it — `.sendAt(at).send()`, typed as the scheduled send. Null when
   * push is switched off or the request failed.
   */
  async schedule(at: PushSendAt): Promise<PushScheduledSend | null> {
    const res = await this.sendAt(at).send();
    return 'id' in res ? res : null;
  }

  /** The assembled request payload, without sending — handy in tests. */
  toJSON(): Record<string, unknown> {
    const c = this.content();
    return drop({
      title: c.title,
      body: c.body,
      localizations: c.localizations,
      defaultLanguage: c.defaultLanguage,
      imageUrl: this._imageUrl,
      data: Object.keys(this._data).length ? this._data : undefined,
      options: Object.keys(this._options).length ? this._options : undefined,
      distinctIds: this._distinctIds.length ? this._distinctIds : undefined,
      segmentIds: this._segmentIds.length ? this._segmentIds : undefined,
      filter: Object.keys(this._filter).length ? this._filter : undefined,
      all: this._all || undefined,
      sendAt: this._sendAt,
      name: this._sendAt ? this._name : undefined,
    });
  }

  /**
   * Base text (the default language's, when given per language) plus one complete
   * `{title, body}` per language — a language missing one takes the default's.
   */
  private content(): {
    title?: string;
    body?: string;
    localizations?: Record<string, { title: string; body?: string }>;
    defaultLanguage?: string;
  } {
    const langs = [...new Set([...Object.keys(this._titles), ...Object.keys(this._bodies)])];
    if (langs.length === 0) return { title: this._title, body: this._body };
    const def: string = this._defaultLanguage ?? (langs.includes('en') ? 'en' : (langs[0] as string));
    const title = this._title ?? this._titles[def] ?? Object.values(this._titles)[0];
    const body = this._body ?? this._bodies[def];
    const localizations: Record<string, { title: string; body?: string }> = {};
    for (const lang of langs) {
      const t = this._titles[lang] ?? title;
      if (!t) continue;
      const b = this._bodies[lang] ?? body;
      localizations[lang] = b ? { title: t, body: b } : { title: t };
    }
    return { title, body, localizations: Object.keys(localizations).length ? localizations : undefined, defaultLanguage: def };
  }
}
