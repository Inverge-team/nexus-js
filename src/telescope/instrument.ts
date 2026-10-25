import { createRequire } from 'node:module';
import diagnostics from 'node:diagnostics_channel';
import http from 'node:http';
import https from 'node:https';
import { format } from 'node:util';

import { type Batch, newSpanId, type Recorder, toSafe } from './recorder';

/** Where frameworks leave the matched route / parsed body on the raw request. */
export const ROUTE = Symbol.for('nexus.telescope.route');
export const BODY = Symbol.for('nexus.telescope.body');
const BATCH = Symbol.for('nexus.telescope.batch');
const SKIP = Symbol.for('nexus.telescope.skip');
const PATCHED = Symbol.for('nexus.telescope.patched');

type Req = http.IncomingMessage & { [ROUTE]?: string; [BODY]?: unknown; [BATCH]?: Batch; route?: { path?: unknown }; baseUrl?: string; body?: unknown; originalUrl?: string };

const now = () => performance.timeOrigin + performance.now();

function headersOf(h: http.IncomingHttpHeaders | http.OutgoingHttpHeaders): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(h)) if (v != null) out[k] = Array.isArray(v) ? v.join(', ') : String(v);
  return out;
}

/** The app frame that ran a query (first stack frame outside node_modules / node internals). */
function location(): { file?: string; line?: number } {
  const stack = new Error().stack?.split('\n') ?? [];
  const cwd = process.cwd() + '/';
  for (const line of stack.slice(3)) {
    const m = /\(?([^\s()]+):(\d+):\d+\)?$/.exec(line);
    if (!m) continue;
    const file = m[1]!.replace(/^file:\/\//, '');
    if (file.includes('node_modules') || file.startsWith('node:') || file.includes('/nexus-js/') || file.includes('/telescope/')) continue;
    return { file: file.replace(cwd, ''), line: Number(m[2]) };
  }
  return {};
}

// ── incoming HTTP — every framework (Express, Fastify, Koa, Nest, Hapi, Next…) ──

export function instrumentServer(rec: Recorder): void {
  for (const Server of [http.Server, https.Server] as unknown as { prototype: { emit: (...a: unknown[]) => boolean; [PATCHED]?: boolean } }[]) {
    const proto = Server.prototype;
    if (proto[PATCHED]) continue;
    proto[PATCHED] = true;
    const emit = proto.emit;
    proto.emit = function (this: unknown, event: unknown, ...args: unknown[]) {
      if (event !== 'request') return emit.call(this, event, ...args);
      const [req, res] = args as [Req, http.ServerResponse];
      const batch = startRequest(rec, req, res);
      return batch ? rec.within(batch, () => emit.call(this, event, ...args)) : emit.call(this, event, ...args);
    };
  }
}

function startRequest(rec: Recorder, req: Req, res: http.ServerResponse): Batch | null {
  try {
    const url = req.url ?? '/';
    const path = url.split('?')[0] || '/';
    if (!rec.enabled() || rec.ignoresPath(path)) return null;
    const host = req.headers.host ?? 'localhost';
    const proto = (req.socket as { encrypted?: boolean }).encrypted ? 'https' : String(req.headers['x-forwarded-proto'] ?? 'http').split(',')[0];
    const query = Object.fromEntries(new URLSearchParams(url.split('?')[1] ?? ''));
    const batch = rec.begin(
      'request',
      {
        method: req.method,
        uri: `${proto}://${host}${url}`,
        path,
        ip: String(req.headers['x-forwarded-for'] ?? req.socket.remoteAddress ?? '').split(',')[0]?.trim(),
        headers: headersOf(req.headers),
        query: Object.keys(query).length ? query : undefined,
      },
      { traceparent: req.headers.traceparent },
    );
    if (!batch) return null;
    req[BATCH] = batch;
    const body = captureBody(rec, res);
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      const route = req[ROUTE] ?? expressRoute(req);
      const payload = req[BODY] ?? (req.body && typeof req.body === 'object' ? req.body : undefined);
      rec.end(
        batch,
        {
          responseStatus: res.statusCode,
          responseHeaders: headersOf(res.getHeaders()),
          route,
          payload: payload !== undefined ? toSafe(payload) : undefined,
          response: body(),
          aborted: res.writableFinished ? undefined : true,
          memoryMb: Math.round((process.memoryUsage().rss / 1048576) * 10) / 10,
        },
        String(res.statusCode),
      );
    };
    res.once('finish', finish);
    res.once('close', finish);
    return batch;
  } catch {
    return null;
  }
}

function expressRoute(req: Req): string | undefined {
  const p = req.route?.path;
  if (typeof p !== 'string') return undefined;
  return `${req.baseUrl ?? ''}${p}` || '/';
}

/** Tee the response body (bounded, text/JSON only) without changing what is sent. */
function captureBody(rec: Recorder, res: http.ServerResponse): () => unknown {
  if (!rec.options.captureBodies) return () => undefined;
  const limit = rec.options.bodySizeLimit * 1024;
  const chunks: Buffer[] = [];
  let size = 0;
  let over = false;
  const take = (chunk: unknown, enc?: unknown) => {
    if (chunk == null || over || typeof chunk === 'function') return;
    const b = Buffer.isBuffer(chunk) ? chunk : typeof chunk === 'string' ? Buffer.from(chunk, (typeof enc === 'string' ? enc : 'utf8') as BufferEncoding) : null;
    if (!b) return;
    size += b.length;
    if (size > limit) {
      over = true;
      chunks.length = 0;
      return;
    }
    chunks.push(b);
  };
  const write = res.write.bind(res) as (...a: unknown[]) => boolean;
  const end = res.end.bind(res) as (...a: unknown[]) => http.ServerResponse;
  (res as unknown as { write: (...a: unknown[]) => boolean }).write = (...a: unknown[]) => {
    take(a[0], a[1]);
    return write(...a);
  };
  (res as unknown as { end: (...a: unknown[]) => http.ServerResponse }).end = (...a: unknown[]) => {
    take(a[0], a[1]);
    return end(...a);
  };
  return () => {
    if (over) return `Response over ${rec.options.bodySizeLimit} KB — not recorded`;
    if (!chunks.length) return undefined;
    const type = String(res.getHeader('content-type') ?? '');
    const text = Buffer.concat(chunks).toString('utf8');
    if (type.includes('json')) {
      try {
        return JSON.parse(text);
      } catch {
        return text;
      }
    }
    if (type.includes('html')) return `HTML response (${size} bytes)`;
    if (type.startsWith('text/') || !type) return text;
    return `${type} (${size} bytes)`;
  };
}

// ── outgoing HTTP: node:http(s) and fetch (undici) ──────────────────────────

interface Pending {
  ctx: { batch: Batch; span: string };
  id: string;
  start: number;
  method: string;
  url: string;
  status?: number;
  headers?: Record<string, string>;
}

export function instrumentClient(rec: Recorder): void {
  const self = (url: string) => url.startsWith(`${rec.options.baseUrl.replace(/\/+$/, '')}/partner/`);
  const pending = new WeakMap<object, Pending>();
  const done = (p: Pending, extra: Record<string, unknown>) =>
    rec.als.run(p.ctx, () =>
      rec.record(
        'http',
        { method: p.method, url: p.url, responseStatus: p.status, responseHeaders: p.headers, ...extra },
        { id: p.id, startedAt: p.start, durationMs: now() - p.start, status: p.status != null ? String(p.status) : 'failed' },
      ),
    );

  // node:http / node:https clients (axios, got, node-fetch, superagent…)
  diagnostics.subscribe('http.client.request.start', (msg) => {
    const { request } = msg as { request: http.ClientRequest };
    const ctx = rec.current();
    if (!ctx) return;
    const url = `${request.protocol}//${request.host}${request.path}`;
    if (self(url)) return;
    const id = newSpanId();
    try {
      if (!request.headersSent && !request.getHeader('traceparent')) request.setHeader('traceparent', `00-${ctx.batch.traceId}-${id}-01`);
    } catch {
      /* headers already flushed */
    }
    const p: Pending = { ctx, id, start: now(), method: request.method, url };
    pending.set(request, p);
    request.once('error', (e) => done(p, { error: e.message }));
  });
  diagnostics.subscribe('http.client.response.finish', (msg) => {
    const { request, response } = msg as { request: http.ClientRequest; response: http.IncomingMessage };
    const p = pending.get(request);
    if (!p) return;
    p.status = response.statusCode;
    p.headers = headersOf(response.headers);
    pending.delete(request);
    let ended = false;
    const end = () => {
      if (!ended) {
        ended = true;
        done(p, { requestHeaders: headersOf(request.getHeaders()) });
      }
    };
    response.once('end', end);
    response.once('close', end);
  });

  // fetch() — Node's bundled undici publishes these.
  diagnostics.subscribe('undici:request:create', (msg) => {
    const { request } = msg as { request: { origin: string; path: string; method: string; addHeader?: (k: string, v: string) => void } };
    const ctx = rec.current();
    if (!ctx) return;
    const url = `${request.origin}${request.path}`;
    if (self(url)) return;
    const id = newSpanId();
    try {
      request.addHeader?.('traceparent', `00-${ctx.batch.traceId}-${id}-01`);
    } catch {
      /* ignore */
    }
    pending.set(request, { ctx, id, start: now(), method: request.method, url });
  });
  diagnostics.subscribe('undici:request:headers', (msg) => {
    const { request, response } = msg as { request: object; response: { statusCode: number; headers: Buffer[] | string[] } };
    const p = pending.get(request);
    if (!p) return;
    p.status = response.statusCode;
    const h: Record<string, string> = {};
    for (let i = 0; i + 1 < response.headers.length; i += 2) h[String(response.headers[i]).toLowerCase()] = String(response.headers[i + 1]);
    p.headers = h;
  });
  diagnostics.subscribe('undici:request:trailers', (msg) => {
    const { request } = msg as { request: object };
    const p = pending.get(request);
    if (!p) return;
    pending.delete(request);
    done(p, {});
  });
  diagnostics.subscribe('undici:request:error', (msg) => {
    const { request, error } = msg as { request: object; error: Error };
    const p = pending.get(request);
    if (!p) return;
    pending.delete(request);
    done(p, { error: error?.message });
  });
}

// ── logs & crashes ──────────────────────────────────────────────────────────

export function instrumentConsole(rec: Recorder): void {
  const c = console as unknown as Record<string, ((...a: unknown[]) => void) & { [PATCHED]?: boolean }>;
  const levels: Record<string, string> = { log: 'info', info: 'info', warn: 'warning', error: 'error', debug: 'debug', trace: 'debug' };
  for (const [method, level] of Object.entries(levels)) {
    const orig = c[method];
    if (!orig || orig[PATCHED]) continue;
    const wrapped = Object.assign(
      (...args: unknown[]) => {
        if (rec.current()) {
          const err = args.find((a) => a instanceof Error) as Error | undefined;
          rec.record('log', { level, message: format(...args).slice(0, 8000), context: err ? { error: err.message } : undefined }, { status: level });
        }
        return orig.apply(console, args);
      },
      { [PATCHED]: true },
    );
    c[method] = wrapped;
  }
  process.on('uncaughtExceptionMonitor', (err) => {
    if (rec.current()) rec.exception(err, false);
  });
}

// ── databases ───────────────────────────────────────────────────────────────

/** Resolve a module from the APP (not from this package), so we patch the copy the app uses. */
function appRequire(name: string): unknown {
  try {
    return createRequire(`${process.cwd()}/`)(name);
  } catch {
    return null;
  }
}

type Fn = (...a: unknown[]) => unknown;

export function instrumentPg(rec: Recorder, pg: unknown = appRequire('pg')): boolean {
  const mod = pg as { Client?: { prototype: Record<string, unknown> }; Pool?: { prototype: Record<string, unknown> } } | null;
  const Client = mod?.Client;
  if (!Client || (Client.prototype as { [PATCHED]?: boolean })[PATCHED]) return false;
  (Client.prototype as { [PATCHED]?: boolean })[PATCHED] = true;

  const wrapQuery = (orig: Fn, viaPool: boolean) =>
    function (this: unknown, ...args: unknown[]) {
      const ctx = rec.current();
      const cfg = args[0] as { text?: string; values?: unknown[]; [SKIP]?: boolean } | string;
      if (!ctx || (typeof cfg === 'object' && cfg?.[SKIP])) return orig.apply(this, args);
      const sql = typeof cfg === 'string' ? cfg : cfg?.text;
      if (typeof sql !== 'string') return orig.apply(this, args);
      const values = (Array.isArray(args[1]) ? args[1] : typeof cfg === 'object' ? cfg.values : undefined) ?? [];
      const start = now();
      const where = location();
      const finish = (err?: unknown, res?: { rowCount?: number }) =>
        rec.als.run(ctx, () =>
          rec.record('query', { sql, bindings: toSafe(values), connection: 'pg', rows: res?.rowCount, error: err ? String((err as Error).message ?? err) : undefined, ...where }, { durationMs: now() - start, startedAt: start }),
        );
      // A pooled query is attributed HERE, at call time: the pool may run it
      // later in another request's async context, so the inner Client.query is skipped.
      if (viaPool && typeof cfg === 'string') {
        args[0] = { text: cfg, values: Array.isArray(args[1]) ? args[1] : undefined, [SKIP]: true };
        if (Array.isArray(args[1])) args.splice(1, 1);
      } else if (viaPool && typeof cfg === 'object') {
        args[0] = { ...cfg, [SKIP]: true };
      }
      const cbIndex = args.findIndex((a) => typeof a === 'function');
      if (cbIndex >= 0) {
        const cb = args[cbIndex] as Fn;
        args[cbIndex] = (err: unknown, res: { rowCount?: number }) => {
          finish(err, res);
          return cb(err, res);
        };
        return orig.apply(this, args);
      }
      const out = orig.apply(this, args) as Promise<{ rowCount?: number }> | undefined;
      if (out && typeof out.then === 'function') {
        out.then((r) => finish(undefined, r), (e) => finish(e));
      }
      return out;
    };

  Client.prototype.query = wrapQuery(Client.prototype.query as Fn, false);
  if (mod?.Pool) mod.Pool.prototype.query = wrapQuery(mod.Pool.prototype.query as Fn, true);
  return true;
}

export function instrumentMysql2(rec: Recorder, mysql: unknown = appRequire('mysql2')): boolean {
  const Connection = (mysql as { Connection?: { prototype: Record<string, unknown> } } | null)?.Connection;
  if (!Connection || (Connection.prototype as { [PATCHED]?: boolean })[PATCHED]) return false;
  (Connection.prototype as { [PATCHED]?: boolean })[PATCHED] = true;
  for (const method of ['query', 'execute']) {
    const orig = Connection.prototype[method] as Fn | undefined;
    if (!orig) continue;
    Connection.prototype[method] = function (this: unknown, ...args: unknown[]) {
      const ctx = rec.current();
      const first = args[0] as string | { sql?: string; values?: unknown };
      const sql = typeof first === 'string' ? first : first?.sql;
      if (!ctx || typeof sql !== 'string') return orig.apply(this, args);
      const values = Array.isArray(args[1]) ? args[1] : typeof first === 'object' ? first.values : undefined;
      const start = now();
      const where = location();
      const cbIndex = args.findIndex((a) => typeof a === 'function');
      const finish = (err?: unknown) =>
        rec.als.run(ctx, () =>
          rec.record('query', { sql, bindings: toSafe(values ?? []), connection: 'mysql', error: err ? String((err as Error).message ?? err) : undefined, ...where }, { durationMs: now() - start, startedAt: start }),
        );
      if (cbIndex >= 0) {
        const cb = args[cbIndex] as Fn;
        args[cbIndex] = (err: unknown, ...rest: unknown[]) => {
          finish(err);
          return cb(err, ...rest);
        };
        return orig.apply(this, args);
      }
      const q = orig.apply(this, args) as { once?: (e: string, f: Fn) => void };
      q?.once?.('end', () => finish());
      q?.once?.('error', (e) => finish(e));
      return q;
    };
  }
  return true;
}

export function instrumentIoredis(rec: Recorder, ioredis: unknown = appRequire('ioredis')): boolean {
  const Redis = ((ioredis as { default?: unknown })?.default ?? ioredis) as { prototype?: Record<string, unknown> } | null;
  const proto = Redis?.prototype;
  if (!proto || typeof proto.sendCommand !== 'function' || (proto as { [PATCHED]?: boolean })[PATCHED]) return false;
  (proto as { [PATCHED]?: boolean })[PATCHED] = true;
  const orig = proto.sendCommand as Fn;
  proto.sendCommand = function (this: unknown, command: { name?: string; args?: unknown[]; promise?: Promise<unknown> }, ...rest: unknown[]) {
    const ctx = rec.current();
    const out = orig.call(this, command, ...rest);
    if (ctx && command?.promise && command.name && !['info', 'ping', 'select', 'client', 'auth', 'hello'].includes(command.name)) {
      const start = now();
      const text = `${command.name.toUpperCase()} ${(command.args ?? []).map((a) => (Buffer.isBuffer(a) ? '<buffer>' : String(a))).join(' ')}`.slice(0, 500);
      const finish = (err?: unknown) =>
        rec.als.run(ctx, () => rec.record('redis', { command: text, connection: 'ioredis', error: err ? String(err) : undefined }, { durationMs: now() - start, startedAt: start }));
      command.promise.then(() => finish(), (e) => finish(e));
    }
    return out;
  };
  return true;
}

/**
 * Prisma: returns an extended client that records every operation as a query
 * entry (`prisma.User.findMany …`). `const db = telescope.prisma(new PrismaClient())`.
 */
export function prismaExtension(rec: Recorder) {
  return {
    name: 'nexus-telescope',
    query: {
      async $allOperations({ model, operation, args, query }: { model?: string; operation: string; args: unknown; query: (a: unknown) => Promise<unknown> }) {
        if (!rec.current()) return query(args);
        const start = now();
        const where = location();
        const leaves: unknown[] = [];
        let error: string | undefined;
        try {
          return await query(args);
        } catch (e) {
          error = e instanceof Error ? e.message : String(e);
          throw e;
        } finally {
          rec.record(
            'query',
            {
              // The SHAPE of the call (values → ?) is the "SQL", so findUnique-by-id
              // in a loop groups as one family and N+1 detection works; the values
              // are the bindings, so duplicates are still told apart.
              sql: `prisma.${model ?? '$raw'}.${operation}(${JSON.stringify(shape(args, leaves)) ?? ''})`.slice(0, 4000),
              bindings: leaves.slice(0, 100),
              connection: 'prisma',
              error,
              ...where,
            },
            { durationMs: now() - start, startedAt: start },
          );
        }
      },
    },
  };
}

/** Replace every leaf value with `?`, collecting the values. */
function shape(v: unknown, leaves: unknown[], depth = 0): unknown {
  if (depth > 8) return '?';
  if (v === null || typeof v !== 'object' || v instanceof Date) {
    if (v !== undefined) leaves.push(toSafe(v));
    return '?';
  }
  if (Array.isArray(v)) return v.length ? [shape(v[0], leaves, depth + 1)] : [];
  const out: Record<string, unknown> = {};
  for (const [k, x] of Object.entries(v)) out[k] = shape(x, leaves, depth + 1);
  return out;
}
