/**
 * Nexus Telescope for Node — request journeys for every Node framework.
 *
 * ```ts
 * import { NexusTelescope } from '@inverge/nexus/telescope';
 * const telescope = NexusTelescope.init({ apiKey: process.env.NEXUS_API_KEY!, service: 'orders-api' });
 * ```
 *
 * `init()` alone records every incoming request (it hooks `http.Server`, so
 * Express, Fastify, Koa, NestJS, Hapi and Next.js all work), outgoing calls
 * made with `fetch`, `http`/`https`, axios, got… (with a W3C `traceparent`, so
 * downstream services join the trace), `console` output, and `pg`, `mysql2`
 * and `ioredis` queries. Framework helpers add the matched route, the parsed
 * body and exceptions the framework would otherwise swallow.
 */
import {
  BODY,
  instrumentClient,
  instrumentConsole,
  instrumentIoredis,
  instrumentMysql2,
  instrumentPg,
  instrumentServer,
  prismaExtension,
  ROUTE,
} from './instrument';
import { type EntryType, newSpanId, Recorder, type TelescopeOptions, toSafe } from './recorder';

export type { EntryType, TelescopeOptions } from './recorder';

export interface InitOptions extends TelescopeOptions {
  /** Auto-instrumentation; everything defaults to on. */
  instrument?: {
    server?: boolean;
    client?: boolean;
    console?: boolean;
    pg?: boolean | unknown;
    mysql2?: boolean | unknown;
    ioredis?: boolean | unknown;
  };
}

type AnyReq = { raw?: unknown; [ROUTE]?: string; [BODY]?: unknown } & Record<string | symbol, unknown>;

export class NexusTelescope {
  private static instance: NexusTelescope | null = null;
  readonly recorder: Recorder;

  private constructor(opts: InitOptions) {
    this.recorder = new Recorder(opts);
    const i = opts.instrument ?? {};
    const on = (v: unknown) => v !== false;
    if (on(i.server)) instrumentServer(this.recorder);
    if (on(i.client)) instrumentClient(this.recorder);
    if (on(i.console)) instrumentConsole(this.recorder);
    if (on(i.pg)) instrumentPg(this.recorder, ...(typeof i.pg === 'object' ? [i.pg] : []));
    if (on(i.mysql2)) instrumentMysql2(this.recorder, ...(typeof i.mysql2 === 'object' ? [i.mysql2] : []));
    if (on(i.ioredis)) instrumentIoredis(this.recorder, ...(typeof i.ioredis === 'object' ? [i.ioredis] : []));

    const flush = () => void this.recorder.flush();
    process.once('beforeExit', flush);
    for (const sig of ['SIGTERM', 'SIGINT'] as const) {
      process.once(sig, () => {
        void this.recorder.flush().finally(() => {
          // Re-raise only if nobody else handles the signal.
          if (process.listenerCount(sig) === 0) process.kill(process.pid, sig);
        });
      });
    }
  }

  /** Create (once) and return the process-wide recorder. Call before your app creates its server. */
  static init(opts: InitOptions): NexusTelescope {
    return (NexusTelescope.instance ??= new NexusTelescope(opts));
  }

  static get(): NexusTelescope | null {
    return NexusTelescope.instance;
  }

  // ── framework helpers ──────────────────────────────────────────────────────

  /** Express / Connect middleware: names the route and keeps the parsed body. Mount it first. */
  express() {
    return (req: AnyReq, res: { once: (e: string, f: () => void) => void }, next: () => void) => {
      res.once('finish', () => {
        const route = (req.route as { path?: unknown } | undefined)?.path;
        if (typeof route === 'string') req[ROUTE] = `${String(req.baseUrl ?? '')}${route}`;
        if (req.body !== undefined) req[BODY] = req.body;
      });
      next();
    };
  }

  /** Express error middleware — records the exception, then passes it on. Mount it last. */
  expressErrors() {
    return (err: unknown, _req: unknown, _res: unknown, next: (e: unknown) => void) => {
      this.recorder.exception(err, false);
      next(err);
    };
  }

  /** Fastify plugin: `await app.register(telescope.fastify())`. */
  fastify() {
    const rec = this.recorder;
    const plugin = async (app: {
      addHook: (name: string, fn: (...a: never[]) => unknown) => void;
    }) => {
      app.addHook('preHandler', async (request: { raw: AnyReq; body?: unknown; routeOptions?: { url?: string }; routerPath?: string }) => {
        request.raw[ROUTE] = request.routeOptions?.url ?? request.routerPath;
        if (request.body !== undefined) request.raw[BODY] = request.body;
      });
      app.addHook('onError', async (_request: unknown, _reply: unknown, error: unknown) => {
        rec.exception(error, false);
      });
    };
    // Same as fastify-plugin: hooks apply app-wide instead of to an encapsulated child.
    (plugin as unknown as Record<symbol, unknown>)[Symbol.for('skip-override')] = true;
    (plugin as unknown as Record<symbol, unknown>)[Symbol.for('fastify.display-name')] = 'nexus-telescope';
    return plugin;
  }

  /** Koa middleware: `app.use(telescope.koa())` (before the router). */
  koa() {
    return async (ctx: { req: AnyReq; _matchedRoute?: string; request?: { body?: unknown } }, next: () => Promise<unknown>) => {
      try {
        await next();
      } catch (e) {
        this.recorder.exception(e, false);
        throw e;
      } finally {
        if (ctx._matchedRoute) ctx.req[ROUTE] = ctx._matchedRoute;
        if (ctx.request?.body !== undefined) ctx.req[BODY] = ctx.request.body;
      }
    };
  }

  /** Prisma: `const db = new PrismaClient().$extends(telescope.prisma())`. */
  prisma() {
    return prismaExtension(this.recorder);
  }

  // ── units of work outside HTTP ─────────────────────────────────────────────

  /**
   * Run a queued job as its own journey. Pass the job's data as `carrier` so
   * it joins the trace of the request that queued it (see {@link inject}).
   *
   * ```ts
   * new Worker('emails', (job) => telescope.job(job.name, () => send(job.data), { carrier: job.data, queue: 'emails' }));
   * ```
   */
  job<T>(name: string, fn: () => Promise<T> | T, opts: { carrier?: Record<string, unknown>; queue?: string; attempts?: number; data?: unknown } = {}): Promise<T> {
    return this.recorder.run('job', name, fn, { queue: opts.queue, attempts: opts.attempts, data: toSafe(opts.data ?? opts.carrier) }, { carrier: opts.carrier });
  }

  /** A CLI command / script as a journey. */
  command<T>(name: string, fn: () => Promise<T> | T, args?: Record<string, unknown>): Promise<T> {
    return this.recorder.run('command', name, fn, { command: name, arguments: toSafe(args) });
  }

  /** A scheduled task (node-cron, agenda, …) as a journey. */
  schedule<T>(name: string, fn: () => Promise<T> | T, expression?: string): Promise<T> {
    return this.recorder.run('schedule', name, fn, { description: name, expression });
  }

  /**
   * Fields to merge into a job payload so its execution joins this trace, and
   * records the dispatch in the current journey:
   * `queue.add('send', { ...data, ...telescope.inject('SendInvoice', 'emails') })`.
   */
  inject(jobName?: string, queue?: string): Record<string, string> {
    const id = newSpanId();
    const tp = this.recorder.traceparent(id);
    if (!tp) return {};
    if (jobName) this.recorder.record('job', { name: jobName, queue, status: 'dispatched' }, { id, status: 'dispatched' });
    return { __nexusTelescope: tp };
  }

  // ── manual entries ─────────────────────────────────────────────────────────

  span<T>(name: string, fn: () => T, content: Record<string, unknown> = {}): T {
    return this.recorder.span(name, fn, content);
  }

  record(type: EntryType, content: Record<string, unknown>, opts?: { durationMs?: number; status?: string; name?: string; tags?: string[] }): void {
    this.recorder.record(type, content, opts);
  }

  query(sql: string, bindings: unknown[] = [], durationMs?: number, connection?: string): void {
    this.recorder.record('query', { sql, bindings: toSafe(bindings), connection }, { durationMs });
  }

  event(name: string, payload?: unknown, listeners?: string[]): void {
    this.recorder.record('event', { name, payload: toSafe(payload), listeners });
  }

  cache(action: 'hit' | 'missed' | 'set' | 'forget', key: string, value?: unknown): void {
    this.recorder.record('cache', { action, key, value: toSafe(value) }, { status: action });
  }

  log(level: string, message: string, context?: Record<string, unknown>): void {
    this.recorder.record('log', { level, message, context: toSafe(context) }, { status: level });
  }

  exception(error: unknown, handled = true, context?: Record<string, unknown>): void {
    this.recorder.exception(error, handled, context);
  }

  /** The signed-in user of the current request: tags it `Auth:<id>`, links it to Nexus Sessions. */
  user(user: { id: string | number; email?: string; name?: string } & Record<string, unknown>): void {
    this.recorder.user({ ...user, id: String(user.id) });
  }

  tag(...tags: string[]): void {
    this.recorder.tag(...tags);
  }

  traceparent(): string | null {
    return this.recorder.traceparent();
  }

  flush(): Promise<void> {
    return this.recorder.flush();
  }
}
