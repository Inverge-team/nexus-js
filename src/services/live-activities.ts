import type { NexusHttp } from '../http';
import type { NexusIdentity } from '../identity';

export interface LiveActivityResult {
  ios: number;
  android: number;
  /** Start only: iOS devices registered for the activity type. */
  iosTargets?: number;
  /** Start only: why iOS got fewer deliveries than targets (no devices, APNs not set up, Apple's error). */
  iosWarning?: string;
}

/**
 * Data for a templated Live Activity (the design lives in a template made in
 * the Nexus console, or sent inline). On update, send only what changed — the
 * server merges it into the current data (`null` clears a field).
 */
export interface LiveActivityData {
  /** Current step id (or label) of a steps template, e.g. "on_the_way". */
  step?: string | null;
  /** "active" | "canceled" | "done". */
  state?: 'active' | 'canceled' | 'done' | (string & {}) | null;
  /** 0–1: the tracker's position toward the next step (or along the bar). */
  progress?: number | null;
  /** Arrival time, unix seconds — a live countdown on the device. */
  etaAt?: number | null;
  /** Values for the template's {{placeholders}}; `eta` shows as fixed ETA text. */
  values?: Record<string, string | number | boolean | null>;
  /** Override the template's texts for this activity. */
  title?: string | null;
  subtitle?: string | null;
  body?: string | null;
}

export interface LiveActivityTemplateStartOptions {
  /** Omit for a shared activity (everyone). */
  distinctIds?: string[];
  /** Force one language for every recipient (default: each device's app language). */
  lang?: string;
  /** iOS alert shown with the start (default: the template's current texts). */
  alert?: { title: string; body?: string };
  attributes?: Record<string, unknown>;
  staleDate?: string;
  priority?: number;
}

const toUnixSeconds = (at: Date | number): number => (at instanceof Date ? Math.round(at.getTime() / 1000) : at > 1e11 ? Math.round(at / 1000) : at);

const drop = (o: Record<string, unknown>): Record<string, unknown> =>
  Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined && v !== null));

/**
 * Live Activities — a live, updating view of an in-progress event on the iOS
 * Lock Screen / Dynamic Island and as an Android live notification. The classic
 * server-side use case: start when the event begins, update as it changes, end
 * when it's done.
 *
 * Templated (recommended) — design in the Nexus console, send only data; the
 * SDKs render it on iOS + Android in each device's language:
 * `nexus.liveActivities.template('order_tracking', 'order_42').step('pending').etaAt(eta).value('driver', 'Ahmed').toUser('u_1').start()`
 * then `nexus.liveActivities.activity('order_42').step('arrived').update()`.
 *
 * Plain (your own iOS widget):
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

  /**
   * A templated activity: `template` is a template key from the console (e.g.
   * "order_tracking") or an inline design object.
   */
  template(template: string | Record<string, unknown>, activityId: string): NexusLiveActivityBuilder {
    return new NexusLiveActivityBuilder(this.http, activityId, undefined, template);
  }

  /** Start a templated activity (plain form). */
  async startTemplate(
    template: string | Record<string, unknown>,
    activityId: string,
    data: LiveActivityData = {},
    options: LiveActivityTemplateStartOptions = {},
  ): Promise<LiveActivityResult> {
    const res = await this.http.post(
      '/partner/live-activities/start',
      drop({
        template,
        activityId,
        data,
        distinctIds: options.distinctIds?.length ? options.distinctIds : undefined,
        lang: options.lang,
        alert: options.alert,
        attributes: options.attributes,
        staleDate: options.staleDate,
        priority: options.priority,
      }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  /** Update a templated activity with partial data (merged server-side). */
  async updateData(activityId: string, data: LiveActivityData, options: { staleDate?: string; priority?: number } = {}): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(activityId)}/update`,
      drop({ data, staleDate: options.staleDate, priority: options.priority }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
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

  /** End an activity. Templated: `data` is the final state shown before dismissal (e.g. `{ step: 'completed' }`). */
  async end(
    activityId: string,
    options: { contentState?: Record<string, unknown>; data?: LiveActivityData; dismissalDate?: string } = {},
  ): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(activityId)}/end`,
      drop({ data: options.data, contentState: options.contentState, dismissalDate: options.dismissalDate }),
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

/**
 * Fluent builder for a Live Activity. Template data setters (`step`, `etaAt`,
 * `value`, `canceled`, …) send `data`; the plain setters (`status`, `set`, …)
 * send a `contentState` for your own widget.
 */
export class NexusLiveActivityBuilder {
  private _state: Record<string, unknown> = {};
  private _data: LiveActivityData = {};
  private _lang?: string;
  private _alert?: { title: string; body?: string };
  private _distinctIds: string[] = [];
  private _attributes: Record<string, unknown> = {};
  private _priority?: number;
  private _staleDate?: string;
  private _dismissalDate?: string;

  constructor(
    private readonly http: NexusHttp,
    private readonly activityId: string,
    private readonly activityType?: string,
    private readonly _template?: string | Record<string, unknown>,
  ) {}

  /**
   * Template mode = a template, or a template-only field (step / state / etaAt
   * / values). `progress` and the texts exist in both modes, so on their own
   * they keep the plain contentState behaviour.
   */
  private get templated(): boolean {
    const d = this._data;
    return this._template !== undefined || d.step !== undefined || d.state !== undefined || d.etaAt !== undefined || d.values !== undefined;
  }

  // ---- template data ----
  /** Current step (a step id or label of the template). */
  step(step: string): this {
    this._data.step = step;
    return this;
  }
  /** Arrival time → a live countdown on the device (Date, unix seconds or ms). */
  etaAt(at: Date | number): this {
    this._data.etaAt = toUnixSeconds(at);
    return this;
  }
  /** A fixed ETA text instead of a countdown, e.g. "8 min" (the `eta` value). */
  eta(text: string): this {
    return this.value('eta', text);
  }
  /** One `{{placeholder}}` value. */
  value(key: string, value: string | number | boolean): this {
    this._data.values = { ...(this._data.values ?? {}), [key]: value };
    return this;
  }
  values(values: Record<string, string | number | boolean>): this {
    this._data.values = { ...(this._data.values ?? {}), ...values };
    return this;
  }
  /** Show the canceled state. */
  canceled(): this {
    this._data.state = 'canceled';
    return this;
  }
  /** Show the finished state. */
  done(): this {
    this._data.state = 'done';
    return this;
  }
  /** Partial template data (merged). */
  data(data: LiveActivityData): this {
    this._data = { ...this._data, ...data, values: { ...(this._data.values ?? {}), ...(data.values ?? {}) } };
    if (!Object.keys(this._data.values ?? {}).length) delete this._data.values;
    return this;
  }
  /** Start only: force one language for every recipient (default: each device's own). */
  lang(lang: string): this {
    this._lang = lang;
    return this;
  }
  /** Start only: the iOS alert shown with the start. */
  alert(title: string, body?: string): this {
    this._alert = { title, ...(body ? { body } : {}) };
    return this;
  }

  // ---- content-state (templated: these override the template's texts) ----
  title(v: string): this {
    return this.text('title', v);
  }
  subtitle(v: string): this {
    return this.text('subtitle', v);
  }
  body(v: string): this {
    return this.text('body', v);
  }
  private text(key: 'title' | 'subtitle' | 'body', v: string): this {
    this._data[key] = v;
    this._state[key] = v;
    return this;
  }
  status(v: string): this {
    return this.set('status', v);
  }
  /** Progress 0–1 (or 0–100). Templated: toward the next step / along the bar. */
  progress(v: number): this {
    this._data.progress = v;
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
  /** The body fields for `data` vs `contentState`, depending on the mode. */
  private payload(): Record<string, unknown> {
    if (!this.templated) return { contentState: this._state };
    return { data: this._data };
  }

  async start(): Promise<LiveActivityResult> {
    if (this._template === undefined && !this.activityType) {
      throw new Error('start() requires a template — template(key, id) — or an activity type — activity(type, id).');
    }
    const res = await this.http.post(
      '/partner/live-activities/start',
      drop({
        ...(this._template !== undefined ? { template: this._template } : { activityType: this.activityType }),
        activityId: this.activityId,
        ...(this._template !== undefined ? { data: this._data } : { contentState: this._state }),
        lang: this._lang,
        alert: this._alert,
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
      drop({ ...this.payload(), staleDate: this._staleDate, priority: this._priority }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }

  async end(): Promise<LiveActivityResult> {
    const res = await this.http.post(
      `/partner/live-activities/${encodeURIComponent(this.activityId)}/end`,
      drop({
        ...(this.templated
          ? { data: Object.keys(this._data).length ? this._data : undefined }
          : { contentState: Object.keys(this._state).length ? this._state : undefined }),
        dismissalDate: this._dismissalDate,
      }),
    );
    return (res as LiveActivityResult | null) ?? { ios: 0, android: 0 };
  }
}
