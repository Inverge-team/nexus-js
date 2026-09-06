import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface LiveActivityResult {
  ios: number;
  android: number;
}

const drop = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * Live Activities — a live, updating view of an in-progress event on the iOS
 * Lock Screen / Dynamic Island and as an Android live notification. The classic
 * server-side use case: start when the event begins, update as it changes, end
 * when it's done.
 *
 * Prefer the fluent builder:
 * `nexus.liveActivities.activity('DeliveryAttributes', 'order_42').status('Preparing').progress(20).toUser('u_1').start()`.
 */
export class NexusLiveActivities {
  constructor(
    private readonly http: NexusHttp,
    private readonly id: NexusIdentity,
  ) {}

  /** Start a fluent Live Activity. `activity(type, id)` for start; `activity(id)` for update/end. */
  activity(activityTypeOrId: string, activityId?: string): NexusLiveActivityBuilder {
    return activityId === undefined
      ? new NexusLiveActivityBuilder(this.http, activityTypeOrId)
      : new NexusLiveActivityBuilder(this.http, activityId, activityTypeOrId);
  }

  /** Start an activity (plain form). Omit `distinctIds` for a shared activity. */
  async start(
    activityType: string,
    activityId: string,
    contentState: Record<string, unknown>,
    options: { distinctIds?: string[]; attributes?: Record<string, unknown>; staleDate?: string; priority?: number } = {},
  ): Promise<LiveActivityResult> {
    const res = await this.http.post(
      '/partner/live-activities/start',
      drop({
        activityType,
        activityId,
        contentState,
        distinctIds: options.distinctIds?.length ? options.distinctIds : undefined,
        attributes: options.attributes,
        staleDate: options.staleDate,
        priority: options.priority,
      }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  async update(
    activityId: string,
    contentState: Record<string, unknown>,
    options: { staleDate?: string; priority?: number } = {},
  ): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(activityId)}/update`,
      drop({ contentState, staleDate: options.staleDate, priority: options.priority }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  async end(
    activityId: string,
    options: { contentState?: Record<string, unknown>; dismissalDate?: string } = {},
  ): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(activityId)}/end`,
      drop({ contentState: options.contentState, dismissalDate: options.dismissalDate }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  /** Register an iOS push-to-start token (client-side; exposed for BYO). */
  async registerPushToStartToken(activityType: string, token: string): Promise<void> {
    await this.http.post(
      '/partner/live-activities/push-token',
      drop({ activityType, token, distinctId: this.id.distinctId, deviceKey: this.id.deviceKey }),
    );
  }

  /** Register a running activity instance's update token (client-side; BYO). */
  async registerActivity(
    activityId: string,
    activityType: string,
    options: { platform?: string; updateToken?: string; contentState?: Record<string, unknown> } = {},
  ): Promise<void> {
    await this.http.post(
      '/partner/live-activities/register',
      drop({
        activityId,
        activityType,
        platform: options.platform ?? 'ios',
        updateToken: options.updateToken,
        distinctId: this.id.distinctId,
        contentState: options.contentState,
      }),
    );
  }

  /** Report a receipt / click / failure for analytics. */
  async event(activityId: string, type: 'receipt' | 'click' | 'failed', options: { platform?: string } = {}): Promise<void> {
    await this.http.post('/partner/live-activities/event', drop({ activityId, type, platform: options.platform }));
  }
}

/** Fluent builder for a Live Activity. */
export class NexusLiveActivityBuilder {
  private _state: Record<string, unknown> = {};
  private _distinctIds: string[] = [];
  private _attributes: Record<string, unknown> = {};
  private _priority?: number;
  private _staleDate?: string;
  private _dismissalDate?: string;

  constructor(
    private readonly http: NexusHttp,
    private readonly activityId: string,
    private readonly activityType?: string,
  ) {}

  // ---- content-state ----
  title(v: string): this {
    return this.set('title', v);
  }
  subtitle(v: string): this {
    return this.set('subtitle', v);
  }
  body(v: string): this {
    return this.set('body', v);
  }
  status(v: string): this {
    return this.set('status', v);
  }
  /** Progress 0–100 (or 0–1 — both accepted by the renderers). */
  progress(v: number): this {
    return this.set('progress', v);
  }
  set(key: string, value: unknown): this {
    this._state[key] = value;
    return this;
  }
  state(state: Record<string, unknown>): this {
    this._state = { ...this._state, ...state };
    return this;
  }

  // ---- targeting (start) ----
  toUsers(distinctIds: string[]): this {
    this._distinctIds = [...new Set([...this._distinctIds, ...distinctIds])];
    return this;
  }
  toUser(distinctId: string): this {
    return this.toUsers([distinctId]);
  }
  /** A shared activity (many users watching one event). */
  shared(): this {
    this._distinctIds = [];
    return this;
  }
  attributes(attributes: Record<string, unknown>): this {
    this._attributes = { ...this._attributes, ...attributes };
    return this;
  }

  // ---- modifiers ----
  /** APNs priority: 5 = routine (unmetered), 10 = immediate (metered). */
  priority(priority: number): this {
    this._priority = priority;
    return this;
  }
  staleAt(iso: string): this {
    this._staleDate = iso;
    return this;
  }
  dismissAt(iso: string): this {
    this._dismissalDate = iso;
    return this;
  }

  // ---- terminal ----
  async start(): Promise<LiveActivityResult> {
    if (!this.activityType) throw new Error('start() requires an activity type: activity(type, id).');
    const res = await this.http.post(
      '/partner/live-activities/start',
      drop({
        activityType: this.activityType,
        activityId: this.activityId,
        contentState: this._state,
        distinctIds: this._distinctIds.length ? this._distinctIds : undefined,
        attributes: Object.keys(this._attributes).length ? this._attributes : undefined,
        staleDate: this._staleDate,
        priority: this._priority,
      }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  async update(): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(this.activityId)}/update`,
      drop({ contentState: this._state, staleDate: this._staleDate, priority: this._priority }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  async end(): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(this.activityId)}/end`,
      drop({ contentState: Object.keys(this._state).length ? this._state : undefined, dismissalDate: this._dismissalDate }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }
}
