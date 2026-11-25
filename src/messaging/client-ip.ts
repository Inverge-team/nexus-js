/**
 * The END USER's IP for the request being handled, so Messaging can apply the
 * project's per-IP rate limit without every call passing `clientIp`.
 *
 * The messaging API is server-to-server: the address Nexus sees is your
 * server's. So the SDK forwards your end user's address as `X-Client-IP` — on
 * `verifications.start()` and on `send({ messageClass: 'otp' })`. Other sends
 * never carry it by themselves: a message triggered by a webhook would
 * otherwise be counted against the webhook sender's address.
 *
 * Node has no request global, so the address is bound per request with
 * `AsyncLocalStorage`:
 *
 * ```ts
 * app.use(clientIpMiddleware());                                         // Express / Connect
 * fastify.addHook('onRequest', (req, _r, done) => runWithClientIp(req.ip, done)); // Fastify
 * app.use((ctx, next) => runWithClientIp(ctx.ip, next));                 // Koa
 * ```
 *
 * Use the framework's resolved address (`req.ip` with `trust proxy` set), never
 * a raw `X-Forwarded-For` — a client can write that header itself.
 *
 * A queued job runs outside the request, so carry the address in the job:
 *
 * ```ts
 * await queue.add('otp', { phone, clientIp: currentClientIp() });
 * // worker
 * await runWithClientIp(job.data.clientIp, () => messaging.verifications.start({ to: job.data.phone }));
 * ```
 *
 * Private, loopback and link-local addresses are never forwarded: one of those
 * is your proxy or load balancer, and counting every user against it would
 * rate-limit them all together.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { isIP } from 'node:net';

interface Scope { ip: string | null }

// One store per process even if the ESM and CJS builds are both loaded.
const KEY = Symbol.for('inverge.nexus.clientIp');
const g = globalThis as unknown as Record<symbol, AsyncLocalStorage<Scope> | undefined>;
const store: AsyncLocalStorage<Scope> = (g[KEY] ??= new AsyncLocalStorage<Scope>());

/** Run `fn` with `ip` as the end user's address — `null` for none (e.g. in a webhook handler). */
export function runWithClientIp<T>(ip: string | null | undefined, fn: () => T): T {
  return store.run({ ip: publicIp(ip) }, fn);
}

/** The end user's address for the current request or job, or null. */
export function currentClientIp(): string | null {
  return store.getStore()?.ip ?? null;
}

/**
 * Express / Connect middleware: binds `req.ip` (Express honours `trust proxy`),
 * falling back to the socket peer.
 */
export function clientIpMiddleware() {
  return (
    req: { ip?: string; socket?: { remoteAddress?: string } },
    _res: unknown,
    next: (err?: unknown) => void,
  ): void => {
    runWithClientIp(req.ip ?? req.socket?.remoteAddress, () => next());
  };
}

/** A public IPv4/IPv6 address (IPv4-mapped IPv6 unwrapped), or null. */
export function publicIp(ip: string | null | undefined): string | null {
  let s = (ip ?? '').trim();
  if (s.toLowerCase().startsWith('::ffff:') && isIP(s.slice(7)) === 4) s = s.slice(7);
  const v = isIP(s);
  if (v === 4) {
    const [a = 0, b = 0] = s.split('.').map(Number);
    if (a === 0 || a === 10 || a === 127 || a >= 224) return null;
    if (a === 169 && b === 254) return null;
    if (a === 172 && b >= 16 && b <= 31) return null;
    if (a === 192 && b === 168) return null;
    if (a === 100 && b >= 64 && b <= 127) return null; // carrier-grade NAT
    return s;
  }
  if (v === 6) {
    const l = s.toLowerCase();
    if (l === '::' || l === '::1') return null;
    if (/^f[cd]/.test(l) || /^fe[89ab]/.test(l)) return null; // unique-local, link-local
    return s;
  }
  return null;
}

/** Whether `NEXUS_FORWARD_CLIENT_IP` leaves forwarding on (default: on). */
export function forwardingFromEnv(): boolean {
  const v = typeof process !== 'undefined' ? process.env.NEXUS_FORWARD_CLIENT_IP : undefined;
  return !v || !['0', 'false', 'no', 'off'].includes(v.trim().toLowerCase());
}

/** Headers to add: none when the caller passed an address (it goes in the body) or forwarding is off. */
export function clientIpHeaders(explicit: string | undefined, forward: boolean): Record<string, string> {
  if (explicit !== undefined || !forward) return {};
  const ip = currentClientIp();
  return ip ? { 'X-Client-IP': ip } : {};
}
