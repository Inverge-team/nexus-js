/**
 * Nexus Push Authentication for Node — approve sign-ins and transactions on
 * the user's enrolled phone (match the number, tap, code display, silent).
 *
 * ```ts
 * import { NexusPushAuth } from '@inverge/nexus/push-auth';
 * // A SERVER key: console → API keys → the key → Push Authentication → Server access.
 * const pushAuth = new NexusPushAuth({ apiKey: process.env.NEXUS_SERVER_KEY! });
 *
 * // Enroll: hand the token to your app (Nexus.instance.pushAuth.enroll(token)).
 * const { token } = await pushAuth.createEnrollment({ identity: user.id });
 *
 * // Sign-in:
 * const c = await pushAuth.createChallenge({
 *   identity: user.id, method: 'number_match',
 *   details: { message: 'Sign in to Acme', context: { device: 'Chrome on macOS', ip } },
 * });
 * show(c.requesterView.number);                         // the number the user picks on the phone
 * const done = await pushAuth.waitForChallenge(c.id);    // long-polls until decided
 * if (done.status === 'approved') {
 *   const { claims } = await pushAuth.verifyReceipt(done.receipt!); // single-use
 * }
 * ```
 *
 * Server-only, and a separate entry for that reason. The API key must be
 * GRANTED Push Authentication server access in the console (off on every key
 * by default) — that key starts authentications, so it must never ship in a
 * browser or app bundle; without the grant calls fail with
 * `server_access_required`.
 * Throws `PushAuthError` with the server's code (e.g. `no_factors`,
 * `identity_locked`, `too_many_pending`, `method_unsupported`).
 */
import { createHmac, createPublicKey, type JsonWebKey as NodeJwk, timingSafeEqual, verify as cryptoVerify } from 'node:crypto';

export class PushAuthError extends Error {
  constructor(
    message: string,
    /** Server code — or `network` / `timeout`. */
    readonly code: string,
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'PushAuthError';
  }
}

export interface PushAuthOptions {
  /** A server-only API key granted Push Authentication server access (console → API keys → the key → Push Authentication → Server access). */
  apiKey: string;
  baseUrl?: string;
  /** Per-request timeout in ms (long-polls add their wait). Default 15000. */
  timeoutMs?: number;
  /** Custom fetch (tests, proxies). Default: the global one. */
  fetch?: typeof fetch;
}

export type Method = 'tap' | 'number_match' | 'code_display' | 'silent' | (string & {});
export type ChallengeStatus = 'pending' | 'approved' | 'denied' | 'expired' | 'cancelled';

export interface CreateChallenge {
  /** Your user id. */
  identity: string;
  /** What the user approves — shown on the phone and signed over by it. */
  details: {
    message: string;
    fields?: Array<{ label: string; value: string }>;
    /** Where the request comes from, shown on the phone. */
    context?: { ip?: string; location?: string; device?: string; app?: string };
  };
  /** Default: the environment's default method. */
  method?: Method;
  /** An escalation chain, e.g. `['silent', 'number_match']`. */
  methods?: Method[];
  /** Per-method options, e.g. `{ number_match: { entry: 'type', digits: 3 } }`. */
  methodOptions?: Record<string, Record<string, unknown>>;
  /** Only this device. Default: every active device of the identity. */
  factorId?: string;
  /** Not shown to the user; kept with the challenge. */
  hiddenDetails?: Record<string, unknown>;
  expiresInSeconds?: number;
  notification?: { title?: string; body?: string };
  /** A phone number for the one-time-code fallback (when enabled in the policy). */
  fallback?: { to?: string };
  /** Your own correlation value — echoed in webhooks and the receipt. */
  ref?: string;
  /** Retry-safe creation: the same key returns the same challenge. */
  idempotencyKey?: string;
}

export interface Challenge {
  id: string;
  identity: string;
  status: ChallengeStatus;
  /** `awaiting_code` (code_display) · `fallback` (one-time code sent) · null. */
  stage: string | null;
  method: Method;
  methods: Method[];
  /**
   * What YOUR sign-in screen shows: `{ number }` for number_match;
   * `{ entry: 'code', awaitingCode }` for code_display; `fallback` when a code
   * went out by SMS/Telegram.
   */
  requesterView: Record<string, unknown>;
  reason: string | null;
  factorId: string | null;
  /** The approval receipt (ES256 JWT) when approved. */
  receipt: string | null;
  ref: string | null;
  delivery: { targets: number; received: number; skipped: number; deliveredAt: string | null; undeliveredAt: string | null; fallback: { channel: string | null } | null };
  createdAt: string;
  expiresAt: string;
  decidedAt: string | null;
}

export interface Factor {
  id: string;
  identity: string;
  friendlyName: string;
  platform: 'android' | 'ios';
  status: 'active' | 'locked' | 'revoked';
  keyStrength: string;
  attested: boolean;
  presenceUserBound: boolean | null;
  push: { provider: string | null; reachable: boolean };
  lastSeenAt: string | null;
  createdAt: string;
  [k: string]: unknown;
}

export interface ReceiptClaims {
  iss: string;
  sub: string;
  aud: string;
  iat: number;
  exp: number;
  jti: string;
  cid: string;
  fid: string;
  mth: string;
  /** `['hwk','user', …]` = a person approved with biometrics/PIN; `['hwk','silent']` = the device alone. */
  amr: string[];
  dh: string;
  ks: string;
  att: boolean;
  ep: number;
  ref?: string;
}

const RECEIPT_TYPE = 'nexus-push-auth+jwt';

export class NexusPushAuth {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private jwks: { at: number; envId: string; keys: Map<string, JsonWebKey> } | null = null;

  constructor(private readonly opts: PushAuthOptions) {
    if (!opts.apiKey) throw new Error('NexusPushAuth: apiKey is required');
    this.base = (opts.baseUrl ?? 'https://services.inverge.net').replace(/\/+$/, '');
    this.fetchImpl = opts.fetch ?? fetch;
    this.timeoutMs = opts.timeoutMs ?? 15_000;
  }

  // ── enrollment & devices ───────────────────────────────────────────────────

  /** A single-use enrollment token for `identity` (10 min). Give it to the app. */
  createEnrollment(input: { identity: string; friendlyName?: string; metadata?: Record<string, unknown>; ttlSeconds?: number }) {
    return this.call<{ id: string; identity: string; token: string; expiresAt: string }>('POST', '/enrollments', input);
  }

  listFactors(query: { identity?: string; status?: 'active' | 'locked' | 'revoked'; limit?: number } = {}) {
    const q = new URLSearchParams(Object.entries(query).filter(([, v]) => v !== undefined).map(([k, v]) => [k, String(v)]));
    const qs = q.toString();
    return this.call<Factor[]>('GET', `/factors${qs ? `?${qs}` : ''}`);
  }

  getFactor(id: string) {
    return this.call<Factor>('GET', `/factors/${encodeURIComponent(id)}`);
  }

  /** Remove a device for good (it can't approve anything again). */
  revokeFactor(id: string) {
    return this.call<Factor>('DELETE', `/factors/${encodeURIComponent(id)}`);
  }

  lockFactor(id: string) {
    return this.call<Factor>('POST', `/factors/${encodeURIComponent(id)}/lock`, {});
  }

  unlockFactor(id: string) {
    return this.call<Factor>('POST', `/factors/${encodeURIComponent(id)}/unlock`, {});
  }

  /** Denial streak + push-bombing lock of an identity. */
  getIdentity(identity: string) {
    return this.call<{ identity: string; consecutiveDenials: number; lockedUntil: string | null; lockedReason: string | null }>(
      'GET',
      `/identities/${encodeURIComponent(identity)}`,
    );
  }

  unlockIdentity(identity: string) {
    return this.call<{ identity: string; lockedUntil: null }>('POST', `/identities/${encodeURIComponent(identity)}/unlock`, {});
  }

  // ── challenges ────────────────────────────────────────────────────────────

  createChallenge(input: CreateChallenge) {
    return this.call<Challenge>('POST', '/challenges', input);
  }

  /** Current state; with `wait` (≤ 30 s) the call returns as soon as anything changes. */
  getChallenge(id: string, opts: { wait?: number } = {}) {
    const wait = Math.max(0, Math.min(30, Math.round(opts.wait ?? 0)));
    return this.call<Challenge>('GET', `/challenges/${encodeURIComponent(id)}${wait ? `?wait=${wait}` : ''}`, undefined, wait * 1000);
  }

  /**
   * Long-poll until the challenge is decided (approved / denied / expired /
   * cancelled), or until `untilStage` is reached (e.g. `'awaiting_code'` to know
   * when to show the code input). Gives up after `timeoutSeconds` (default: the
   * challenge's own expiry) and returns the latest state.
   */
  async waitForChallenge(id: string, opts: { timeoutSeconds?: number; untilStage?: string; signal?: AbortSignal } = {}): Promise<Challenge> {
    const deadline = Date.now() + (opts.timeoutSeconds ?? 3600) * 1000;
    let c = await this.getChallenge(id);
    while (c.status === 'pending' && (!opts.untilStage || c.stage !== opts.untilStage)) {
      if (opts.signal?.aborted) break;
      const left = Math.min(deadline, Date.parse(c.expiresAt) + 2_000) - Date.now();
      if (left <= 0) break;
      c = await this.getChallenge(id, { wait: Math.min(25, Math.ceil(left / 1000)) });
    }
    return c;
  }

  /** The code the user typed (code_display, or the SMS/Telegram fallback). */
  complete(id: string, code: string) {
    return this.call<Challenge>('POST', `/challenges/${encodeURIComponent(id)}/complete`, { code });
  }

  cancel(id: string) {
    return this.call<Challenge>('POST', `/challenges/${encodeURIComponent(id)}/cancel`, {});
  }

  // ── receipts ──────────────────────────────────────────────────────────────

  /**
   * Verify an approval receipt with Nexus. `consume` (default true) makes it
   * single-use — a replayed receipt answers `{ valid: false, reason: 'token_replayed' }`.
   */
  verifyReceipt(token: string, opts: { consume?: boolean } = {}) {
    return this.call<{ valid: boolean; reason?: string; claims?: ReceiptClaims }>('POST', '/tokens/verify', { token, consume: opts.consume ?? true });
  }

  /**
   * Verify a receipt OFFLINE against the environment's JWKS (cached 5 min).
   * Checks signature, audience, issuer and expiry; NOT single-use and NOT the
   * revocation epoch — use {@link verifyReceipt} when those matter.
   */
  async verifyReceiptOffline(token: string, environmentId: string): Promise<{ valid: boolean; reason?: string; claims?: ReceiptClaims }> {
    const parts = token.split('.') as [string, string, string];
    if (parts.length !== 3) return { valid: false, reason: 'token_malformed' };
    let header: { typ?: string; kid?: string; alg?: string };
    let claims: ReceiptClaims;
    try {
      header = JSON.parse(Buffer.from(parts[0], 'base64url').toString('utf8'));
      claims = JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
    } catch {
      return { valid: false, reason: 'token_malformed' };
    }
    if (header.typ !== RECEIPT_TYPE || header.alg !== 'ES256' || !header.kid) return { valid: false, reason: 'token_type' };
    let jwk = (await this.keys(environmentId)).get(header.kid);
    if (!jwk) jwk = (await this.keys(environmentId, true)).get(header.kid);
    if (!jwk) return { valid: false, reason: 'token_unknown_key' };
    const ok = cryptoVerify(
      'sha256',
      Buffer.from(`${parts[0]}.${parts[1]}`),
      { key: createPublicKey({ key: jwk as NodeJwk, format: 'jwk' }), dsaEncoding: 'ieee-p1363' },
      Buffer.from(parts[2], 'base64url'),
    );
    if (!ok) return { valid: false, reason: 'token_signature' };
    if (claims.aud !== environmentId || !claims.iss?.endsWith(`/push-auth/${environmentId}`)) return { valid: false, reason: 'token_audience', claims };
    const now = Date.now() / 1000;
    if (claims.exp < now - 5) return { valid: false, reason: 'token_expired', claims };
    if (claims.iat > now + 60) return { valid: false, reason: 'token_not_yet_valid', claims };
    return { valid: true, claims };
  }

  private async keys(environmentId: string, refresh = false): Promise<Map<string, JsonWebKey>> {
    const hit = this.jwks;
    if (!refresh && hit && hit.envId === environmentId && Date.now() - hit.at < 300_000) return hit.keys;
    const res = await this.fetchImpl(`${this.base}/partner/push-auth/${encodeURIComponent(environmentId)}/jwks.json`);
    const body = (await res.json()) as { keys?: Array<JsonWebKey & { kid: string }> };
    const keys = new Map((body.keys ?? []).map((k) => [k.kid, k as JsonWebKey]));
    this.jwks = { at: Date.now(), envId: environmentId, keys };
    return keys;
  }

  // ── transport ─────────────────────────────────────────────────────────────

  private async call<T>(method: string, path: string, body?: unknown, extraTimeout = 0): Promise<T> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), this.timeoutMs + extraTimeout);
    let res: Response;
    try {
      res = await this.fetchImpl(`${this.base}/partner/push-auth${path}`, {
        method,
        headers: { 'x-api-key': this.opts.apiKey, 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: ctrl.signal,
      });
    } catch (e) {
      throw new PushAuthError(ctrl.signal.aborted ? 'Request timed out' : String(e), ctrl.signal.aborted ? 'timeout' : 'network', 0);
    } finally {
      clearTimeout(timer);
    }
    const text = await res.text();
    let json: unknown = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      /* non-JSON */
    }
    if (!res.ok) {
      const err = (json as { error?: { code?: string; message?: string; details?: unknown } } | null)?.error;
      throw new PushAuthError(err?.message ?? `HTTP ${res.status}`, err?.code ?? `http_${res.status}`, res.status, err?.details);
    }
    return json as T;
  }
}

/**
 * Verify a Push Authentication webhook. Pass the RAW body and the
 * `x-nexus-signature` / `x-nexus-timestamp` / `x-nexus-nonce` headers. Rejects
 * a timestamp outside `toleranceSeconds` (default 300). Dedupe on the body's
 * `id` (deliveries are at-least-once) and remember nonces to stop replays.
 */
export function verifyWebhook(
  input: { body: string; signature: string | null | undefined; timestamp: string | number | null | undefined; nonce: string | null | undefined },
  secret: string,
  toleranceSeconds = 300,
): boolean {
  const ts = Number(input.timestamp);
  if (!input.signature || !input.nonce || !Number.isFinite(ts)) return false;
  if (Math.abs(Date.now() / 1000 - ts) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${ts}.${input.nonce}.${input.body}`).digest('hex');
  const a = Buffer.from(input.signature);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}
