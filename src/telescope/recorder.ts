import { AsyncLocalStorage } from 'node:async_hooks';
import { randomBytes } from 'node:crypto';
import { hostname } from 'node:os';

import { resolveSwitches } from '../switches';
import { globMatch, Redactor } from './redact';

/** The entry vocabulary — identical across every Nexus SDK. */
export type EntryType =
  | 'request'
  | 'command'
  | 'job'
  | 'schedule'
  | 'query'
  | 'model'
  | 'event'
  | 'middleware'
  | 'exception'
  | 'log'
  | 'http'
  | 'cache'
  | 'redis'
  | 'mail'
  | 'notification'
  | 'gate'
  | 'view'
  | 'dump'
  | 'batch'
  | 'span';

export interface TelescopeOptions {
  apiKey: string;
  baseUrl?: string;
  /** Service name shown in traces. Default: `NEXUS_SERVICE_NAME`, else the package name. */
  service?: string;
  release?: string;
  /** null = the console's sample rate. Failed/slow/monitored work is always kept. */
  sampleRate?: number | null;
  ignorePaths?: string[];
  ignoreTypes?: EntryType[];
  redactKeys?: string[];
  /** Record response bodies (JSON is parsed). Default true. */
  captureBodies?: boolean;
  /** KB. Default 64. */
  bodySizeLimit?: number;
  maxEntries?: number;
  /** How often buffered journeys are shipped. Default 2000 ms. */
  flushIntervalMs?: number;
  /** Delivery timeout. Default 3000 ms. */
  timeoutMs?: number;
  /** Master switch (also `NEXUS_TELESCOPE_ENABLED=false`). */
  enabled?: boolean;
  fetch?: typeof globalThis.fetch;
  /** Called on delivery failures (default: silent). */
  onError?: (e: unknown) => void;
}

export interface Entry {
  id: string;
  parentId?: string;
  type: EntryType;
  name?: string;
  status?: string;
  offsetMs: number;
  durationMs?: number;
  content: Record<string, unknown>;
  tags?: string[];
}

export interface Batch {
  id: string;
  type: EntryType;
  traceId: string;
  parentSpanId?: string;
  startedAt: number; // epoch ms, fractional
  t0: number; // performance clock at start
  name?: string;
  status?: string;
  durationMs?: number;
  content: Record<string, unknown>;
  tags: string[];
  user?: Record<string, unknown>;
  sessionKey?: string;
  deviceKey?: string;
  entries: Entry[];
  dropped: number;
  failed: boolean;
  done: boolean;
}

/** The async context: which batch, and which span new entries nest under. */
interface Ctx {
  batch: Batch;
  span: string;
}

interface RemoteConfig {
  enabled?: boolean;
  sampleRate?: number;
  slowRequestMs?: number;
  ignorePaths?: string[];
  ignoreTypes?: string[];
  redactKeys?: string[];
  monitoredTags?: string[];
}

export const newTraceId = () => randomBytes(16).toString('hex');
export const newSpanId = () => randomBytes(8).toString('hex');

export function parseTraceparent(h: unknown): { traceId: string; spanId: string } | null {
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== 'string') return null;
  const m = /^\s*[0-9a-f]{2}-([0-9a-f]{32})-([0-9a-f]{16})-[0-9a-f]{2}\s*$/i.exec(v);
  if (!m || /^0+$/.test(m[1]!) || /^0+$/.test(m[2]!)) return null;
  return { traceId: m[1]!.toLowerCase(), spanId: m[2]!.toLowerCase() };
}

const now = () => performance.timeOrigin + performance.now();

function scalar(v: unknown, depth = 0, seen = new WeakSet<object>()): unknown {
  if (depth > 6) return '…';
  if (v == null || typeof v === 'number' || typeof v === 'boolean') return v;
  if (typeof v === 'string') return v.length > 4000 ? `${v.slice(0, 4000)}…` : v;
  if (typeof v === 'bigint') return v.toString();
  if (typeof v === 'function') return `[Function ${v.name || 'anonymous'}]`;
  if (typeof v === 'symbol') return v.toString();
  if (v instanceof Date) return v.toISOString();
  if (v instanceof Error) return { name: v.name, message: v.message };
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(v)) return `[Buffer ${v.length} bytes]`;
  if (typeof v === 'object') {
    if (seen.has(v)) return '[Circular]';
    seen.add(v);
    if (Array.isArray(v)) {
      const out = v.slice(0, 100).map((x) => scalar(x, depth + 1, seen));
      if (v.length > 100) out.push(`… ${v.length - 100} more`);
      return out;
    }
    const out: Record<string, unknown> = {};
    let i = 0;
    for (const [k, x] of Object.entries(v)) {
      if (i++ >= 100) {
        out['…'] = 'more keys';
        break;
      }
      out[k] = scalar(x, depth + 1, seen);
    }
    return out;
  }
  return String(v);
}

/** JSON-safe, bounded copy of anything. */
export const toSafe = (v: unknown) => scalar(v);

/**
 * The Telescope recorder for Node. One per process (see `NexusTelescope.init`).
 * Context flows through AsyncLocalStorage, so concurrent requests never mix and
 * parallel spans nest correctly. Never throws into the app.
 */
export class Recorder {
  readonly als = new AsyncLocalStorage<Ctx>();
  private outbox: Record<string, unknown>[] = [];
  private remote: RemoteConfig = {};
  private timer: ReturnType<typeof setInterval> | null = null;
  private sending = false;
  private readonly fetchImpl: typeof globalThis.fetch;
  private readonly base: string;
  private readonly switchOn: boolean;
  readonly options: Required<Omit<TelescopeOptions, 'fetch' | 'onError' | 'sampleRate' | 'release' | 'service'>> & {
    sampleRate: number | null;
    release?: string;
    service?: string;
    onError?: (e: unknown) => void;
  };

  constructor(opts: TelescopeOptions) {
    if (!opts.apiKey) throw new Error('Nexus Telescope: apiKey is required (nxs_...).');
    this.options = {
      apiKey: opts.apiKey,
      baseUrl: opts.baseUrl ?? process.env.NEXUS_BASE_URL ?? 'https://services.inverge.net',
      service: opts.service ?? process.env.NEXUS_SERVICE_NAME ?? process.env.npm_package_name,
      release: opts.release ?? process.env.NEXUS_RELEASE ?? process.env.npm_package_version,
      sampleRate: opts.sampleRate ?? (process.env.NEXUS_TELESCOPE_SAMPLE_RATE ? Number(process.env.NEXUS_TELESCOPE_SAMPLE_RATE) : null),
      ignorePaths: opts.ignorePaths ?? ['/health*', '/healthz', '/favicon.ico', '/_next/static/*'],
      ignoreTypes: opts.ignoreTypes ?? [],
      redactKeys: opts.redactKeys ?? [],
      captureBodies: opts.captureBodies ?? true,
      bodySizeLimit: opts.bodySizeLimit ?? 64,
      maxEntries: opts.maxEntries ?? 2000,
      flushIntervalMs: opts.flushIntervalMs ?? 2000,
      timeoutMs: opts.timeoutMs ?? 3000,
      enabled: opts.enabled ?? true,
      onError: opts.onError,
    };
    this.base = this.options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = (opts.fetch ?? globalThis.fetch).bind(globalThis);
    this.switchOn = resolveSwitches(undefined, undefined).enabled.telescope;
  }

  // ── state ────────────────────────────────────────────────────────────────

  enabled(): boolean {
    return this.options.enabled && this.switchOn && this.remote.enabled !== false;
  }

  current(): Ctx | undefined {
    const c = this.als.getStore();
    return c && !c.batch.done ? c : undefined;
  }

  ignores(type: string): boolean {
    return (this.options.ignoreTypes as string[]).includes(type) || (this.remote.ignoreTypes ?? []).includes(type);
  }

  ignoresPath(path: string): boolean {
    return [...this.options.ignorePaths, ...(this.remote.ignorePaths ?? [])].some((g) => globMatch(g, path));
  }

  redactor(): Redactor {
    return new Redactor([...this.options.redactKeys, ...(this.remote.redactKeys ?? [])]);
  }

  // ── units of work ────────────────────────────────────────────────────────

  /**
   * Run `fn` as a unit of work. Context: an incoming `traceparent`, or an
   * explicit `traceId`/`parentSpanId` (from a job payload), `name`, `tags`…
   * Returns whatever `fn` returns; the batch finishes when it settles unless
   * `manual` is set (the HTTP integration finishes on response `close`).
   */
  begin(
    type: EntryType,
    content: Record<string, unknown>,
    ctx: { traceparent?: unknown; traceId?: string; parentSpanId?: string; name?: string; tags?: string[]; startedAt?: number } = {},
  ): Batch | null {
    if (this.sending || !this.enabled() || this.ignores(type)) return null;
    const tp = parseTraceparent(ctx.traceparent);
    const parent = this.current();
    const t = now();
    return {
      id: newSpanId(),
      type,
      traceId: ctx.traceId ?? tp?.traceId ?? parent?.batch.traceId ?? newTraceId(),
      parentSpanId: ctx.parentSpanId ?? tp?.spanId ?? parent?.span,
      startedAt: ctx.startedAt ?? t,
      t0: ctx.startedAt ? performance.now() - (t - ctx.startedAt) : performance.now(),
      name: ctx.name,
      content: this.redactor().redact(content),
      tags: [...(ctx.tags ?? [])],
      entries: [],
      dropped: 0,
      failed: false,
      done: false,
    };
  }

  /** Run `fn` inside a batch's context. */
  within<T>(batch: Batch, fn: () => T): T {
    return this.als.run({ batch, span: batch.id }, fn);
  }

  /** Close a batch: merge content, tail-sample, queue for delivery. */
  end(batch: Batch, content: Record<string, unknown> = {}, status?: string, name?: string): void {
    if (batch.done) return;
    batch.done = true;
    try {
      batch.durationMs = performance.now() - batch.t0;
      batch.content = { ...batch.content, ...this.redactor().redact(content) };
      if (status !== undefined) batch.status = status;
      if (name !== undefined) batch.name = name;
      if (this.keep(batch)) this.outbox.push(this.wire(batch));
      this.schedule();
      if (this.outbox.length >= 50) void this.flush();
    } catch (e) {
      this.options.onError?.(e);
    }
  }

  /** Convenience: run `fn` as a whole unit of work (jobs, commands, cron). */
  async run<T>(
    type: EntryType,
    name: string,
    fn: () => Promise<T> | T,
    content: Record<string, unknown> = {},
    ctx: { traceparent?: unknown; traceId?: string; parentSpanId?: string; carrier?: Record<string, unknown> } = {},
  ): Promise<T> {
    const carried = ctx.carrier ? extract(ctx.carrier) : null;
    const batch = this.begin(type, { name, ...content }, { ...ctx, ...(carried ?? {}), name });
    if (!batch) return fn();
    return this.within(batch, async () => {
      try {
        const out = await fn();
        this.end(batch, {}, type === 'job' ? 'processed' : type === 'command' || type === 'schedule' ? '0' : undefined);
        return out;
      } catch (e) {
        this.exception(e, false);
        this.end(batch, { error: e instanceof Error ? e.message : String(e) }, type === 'job' ? 'failed' : '1');
        throw e;
      }
    });
  }

  // ── entries ──────────────────────────────────────────────────────────────

  record(
    type: EntryType,
    content: Record<string, unknown>,
    opts: { durationMs?: number; startedAt?: number; status?: string; name?: string; tags?: string[]; id?: string; parentId?: string } = {},
  ): string | null {
    const ctx = this.current();
    if (!ctx || this.sending || this.ignores(type)) return null;
    const b = ctx.batch;
    if (b.entries.length >= this.options.maxEntries) {
      b.dropped++;
      return null;
    }
    try {
      const at = opts.startedAt ?? (opts.durationMs != null ? now() - opts.durationMs : now());
      const id = opts.id ?? newSpanId();
      const entry: Entry = {
        id,
        parentId: opts.parentId ?? ctx.span,
        type,
        offsetMs: Math.max(0, Math.round((at - b.startedAt) * 1000) / 1000),
        content: this.redactor().redact(content),
      };
      if (opts.durationMs != null) entry.durationMs = Math.round(opts.durationMs * 1000) / 1000;
      if (opts.status != null) entry.status = String(opts.status);
      if (opts.name != null) entry.name = opts.name;
      if (opts.tags?.length) entry.tags = opts.tags;
      b.entries.push(entry);
      if (type === 'exception' && content.handled !== true) b.failed = true;
      return id;
    } catch {
      return null;
    }
  }

  /** Run `fn` inside a span; entries recorded meanwhile (even across awaits) nest under it. */
  span<T>(name: string, fn: () => T, content: Record<string, unknown> = {}, type: EntryType = 'span'): T {
    const ctx = this.current();
    if (!ctx) return fn();
    const start = now();
    const t0 = performance.now();
    const id = this.record(type, { name, ...content }, { name, startedAt: start });
    if (!id) return fn();
    const entry = ctx.batch.entries[ctx.batch.entries.length - 1]!;
    const close = (err?: unknown) => {
      entry.durationMs = Math.round((performance.now() - t0) * 1000) / 1000;
      if (err) entry.content.error = err instanceof Error ? err.message : String(err);
    };
    return this.als.run({ batch: ctx.batch, span: id }, () => {
      try {
        const out = fn();
        if (out && typeof (out as { then?: unknown }).then === 'function') {
          return (out as unknown as Promise<unknown>).then(
            (v) => (close(), v),
            (e) => {
              close(e);
              throw e;
            },
          ) as T;
        }
        close();
        return out;
      } catch (e) {
        close(e);
        throw e;
      }
    });
  }

  exception(e: unknown, handled = false, context?: Record<string, unknown>): string | null {
    const err = e instanceof Error ? e : new Error(String(e));
    return this.record('exception', {
      class: err.name || err.constructor?.name || 'Error',
      message: err.message,
      handled,
      stack: parseStack(err.stack),
      code: (err as { code?: unknown }).code,
      context: context ? (toSafe(context) as Record<string, unknown>) : undefined,
    });
  }

  user(user: Record<string, unknown>): void {
    const ctx = this.current();
    if (ctx) ctx.batch.user = toSafe(user) as Record<string, unknown>;
  }

  tag(...tags: string[]): void {
    const ctx = this.current();
    if (ctx) ctx.batch.tags.push(...tags);
  }

  /** A W3C traceparent for an outgoing call from the current point. */
  traceparent(spanId?: string): string | null {
    const ctx = this.current();
    return ctx ? `00-${ctx.batch.traceId}-${spanId ?? ctx.span}-01` : null;
  }

  // ── delivery ─────────────────────────────────────────────────────────────

  private schedule(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.flush(), this.options.flushIntervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    if (!this.outbox.length || this.sending) return;
    const batches = this.outbox.splice(0, 200);
    this.sending = true;
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), this.options.timeoutMs);
    t.unref?.();
    try {
      const res = await this.fetchImpl(`${this.base}/partner/telescope`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-api-key': this.options.apiKey },
        body: JSON.stringify({
          service: this.options.service,
          host: hostname(),
          release: this.options.release,
          sdk: { name: 'nexus-js', version: SDK_VERSION },
          batches,
        }),
        signal: ac.signal,
      });
      if (res.ok) {
        const body = (await res.json().catch(() => null)) as { config?: RemoteConfig } | null;
        if (body?.config) this.remote = body.config;
      }
    } catch (e) {
      this.options.onError?.(e);
    } finally {
      clearTimeout(t);
      this.sending = false;
    }
    if (this.outbox.length) void this.flush();
  }

  private keep(b: Batch): boolean {
    if (b.failed || isFailure(b)) return true;
    if ((b.durationMs ?? 0) >= (this.remote.slowRequestMs ?? 1000)) return true;
    const monitored = this.remote.monitoredTags ?? [];
    const userTag = b.user?.id != null ? `Auth:${String(b.user.id)}` : null;
    if (monitored.some((t) => b.tags.includes(t) || t === userTag)) return true;
    const rate = this.options.sampleRate ?? this.remote.sampleRate ?? 1;
    return rate >= 1 || Math.random() < rate;
  }

  private wire(b: Batch): Record<string, unknown> {
    const content = b.dropped ? { ...b.content, droppedEntries: b.dropped } : b.content;
    return Object.fromEntries(
      Object.entries({
        id: b.id,
        type: b.type,
        traceId: b.traceId,
        parentSpanId: b.parentSpanId,
        startedAt: Math.round(b.startedAt * 1000) / 1000,
        durationMs: Math.round((b.durationMs ?? 0) * 1000) / 1000,
        name: b.name,
        status: b.status,
        content,
        tags: [...new Set(b.tags)],
        user: b.user,
        sessionKey: b.sessionKey,
        deviceKey: b.deviceKey,
        entries: b.entries,
      }).filter(([, v]) => v !== undefined),
    );
  }

  /** @internal for tests */
  setRemote(r: RemoteConfig): void {
    this.remote = r;
  }
}

export const SDK_VERSION = '1.4.0';

function isFailure(b: Batch): boolean {
  const s = b.status ?? (b.content.responseStatus != null ? String(b.content.responseStatus) : undefined);
  if (s == null) return false;
  if (b.type === 'request') return Number(s) >= 500;
  if (b.type === 'job') return s === 'failed';
  if (b.type === 'command' || b.type === 'schedule') return s !== '0' && Number(s) !== 0;
  return false;
}

/** V8 stack → frames Nexus Errors renders. */
export function parseStack(stack: string | undefined): { function: string; filename: string; lineno: number; colno: number }[] {
  if (!stack) return [];
  const out: { function: string; filename: string; lineno: number; colno: number }[] = [];
  for (const line of stack.split('\n').slice(1, 61)) {
    const m = /^\s*at (?:(.+?) \()?(.+?):(\d+):(\d+)\)?$/.exec(line);
    if (m) out.push({ function: m[1] ?? '<anonymous>', filename: m[2]!, lineno: Number(m[3]), colno: Number(m[4]) });
  }
  return out;
}

/** What a job/message carries so its execution joins the trace (`telescope.inject()`). */
export function extract(carrier: Record<string, unknown>): { traceId?: string; parentSpanId?: string } | null {
  const v = carrier.__nexusTelescope ?? carrier.traceparent;
  if (typeof v === 'string') {
    const tp = parseTraceparent(v);
    return tp ? { traceId: tp.traceId, parentSpanId: tp.spanId } : null;
  }
  return null;
}

export const processHost = hostname;
